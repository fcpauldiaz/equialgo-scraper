import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  listPortfolios,
  createPortfolio,
  readJobStatistics,
  writeTradierCredentials,
  setPortfolioSystemTraderStrategies,
  readTradierCredentials,
  updateTradierPortfolioAccountId,
  readMonthlyPerformance,
  readClosedTrades,
  readPerformanceByStrategy,
  parseAndNormalizeSystemTraderSlug,
} from "./state";
import { startSchwabLoginFlow, handleSchwabCallback, isSchwabCallbackPathname, schwabCallbackPathnames } from "./schwab-oauth";
import { renderSchwabOAuthPage } from "./schwab-oauth-page";
import {
  getTradierAccountId,
  isTradierAccountInProfileList,
  listTradierAccountsForKey,
} from "./tradier-client";
import { verifyConnection, getPortfolioPositions, getHoldingsByStrategy, getPortfolioCurrentValue, readOpenPerformanceSummary } from "./trader";
import { DAILY_CHECK_TIMEZONE, runCheckForPortfolio } from "./run-check";
import { auditDaily, auditHistory, auditReportHasFailures } from "./audit-trades";
import { closeBrowser } from "./scraper";

const UI_PORT = parseInt(process.env.UI_PORT || "3000", 10);

function getPublicOrigin(req: http.IncomingMessage): string | undefined {
  const fromEnv = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (fromEnv) return fromEnv;

  const forwardedProto = req.headers["x-forwarded-proto"];
  const protoRaw = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto;
  const proto = protoRaw?.split(",")[0]?.trim() || "http";

  const forwardedHost = req.headers["x-forwarded-host"];
  const hostRaw =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(",")[0]?.trim() ||
    req.headers.host?.split(",")[0]?.trim();
  if (!hostRaw) return undefined;

  return `${proto}://${hostRaw}`;
}

const UI_DIST = path.join(__dirname, "..", "ui", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || "";
const activeSessions = new Set<string>();

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return null;
}

function isAuthenticated(req: http.IncomingMessage): boolean {
  if (!ADMIN_PASSWORD) return true;
  const token = extractBearerToken(req);
  return token != null && activeSessions.has(token);
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (isAuthenticated(req)) return true;
  sendJson(res, 401, { error: "Authentication required" });
  return false;
}

function serveStatic(
  res: http.ServerResponse,
  filePath: string,
  contentType: string
): void {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function serveUiFallback(res: http.ServerResponse): void {
  const indexPath = path.join(UI_DIST, "index.html");
  fs.readFile(indexPath, (err, data) => {
    if (err) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(
        "UI not built. Run: pnpm run build:ui (from project root) then restart."
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
}

async function tryServeSchwabCallback(
  res: http.ServerResponse,
  url: URL,
  pathname: string,
  method: string
): Promise<boolean> {
  if (method !== "GET" || !isSchwabCallbackPathname(pathname)) {
    return false;
  }

  try {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    const { html } = await handleSchwabCallback({
      code,
      state,
      error,
      error_description: errorDescription,
    });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(
      renderSchwabOAuthPage({
        variant: "error",
        title: "Callback error",
        message: "An unexpected error occurred while processing Schwab authorization.",
        detail: message,
        notifySuccess: false,
      })
    );
  }
  return true;
}

export function startUiServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${UI_PORT}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    if (await tryServeSchwabCallback(res, url, pathname, method)) {
      return;
    }

    if (pathname.startsWith("/api/")) {
      // API routes handled below
    } else if (method === "GET") {
      const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "").replace(/\.\./g, "");
      const filePath = path.join(UI_DIST, safePath);
      const ext = path.extname(safePath);
      const contentType = MIME[ext];
      if (contentType && safePath !== "") {
        fs.stat(filePath, (statErr, stat) => {
          if (!statErr && stat.isFile()) {
            serveStatic(res, filePath, contentType);
          } else {
            serveUiFallback(res);
          }
        });
      } else {
        serveUiFallback(res);
      }
      return;
    }

    if (pathname === "/api/auth/status" && method === "GET") {
      const authEnabled = Boolean(ADMIN_PASSWORD);
      const authenticated = isAuthenticated(req);
      sendJson(res, 200, { authEnabled, authenticated });
      return;
    }

    if (pathname === "/api/login" && method === "POST") {
      if (!ADMIN_PASSWORD) {
        sendJson(res, 400, { error: "Auth not configured (ADMIN_PASSWORD not set)" });
        return;
      }
      try {
        const body = await parseBody(req);
        const password = typeof body.password === "string" ? body.password : "";
        if (password !== ADMIN_PASSWORD) {
          sendJson(res, 401, { error: "Invalid password" });
          return;
        }
        const token = generateSessionToken();
        activeSessions.add(token);
        sendJson(res, 200, { token });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    if (pathname === "/api/logout" && method === "POST") {
      const token = extractBearerToken(req);
      if (token) activeSessions.delete(token);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/portfolios" && method === "GET") {
      try {
        const portfolios = await listPortfolios();
        const withValues = await Promise.all(
          portfolios.map(async (portfolio) => {
            if (!portfolio.hasCredentials) {
              return { ...portfolio, currentValue: null };
            }
            try {
              const currentValue = await getPortfolioCurrentValue(portfolio.id);
              return { ...portfolio, currentValue };
            } catch {
              return { ...portfolio, currentValue: null };
            }
          })
        );
        sendJson(res, 200, withValues);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    if (pathname === "/api/portfolios" && method === "POST") {
      if (!requireAuth(req, res)) return;
      try {
        const body = await parseBody(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) {
          sendJson(res, 400, { error: "name is required" });
          return;
        }
        const { id } = await createPortfolio(name);
        sendJson(res, 200, { id });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    if (pathname === "/api/schwab/start-login" && method === "POST") {
      if (!requireAuth(req, res)) return;
      try {
        const body = await parseBody(req);
        const portfolioId =
          typeof body.portfolioId === "number"
            ? body.portfolioId
            : parseInt(String(body.portfolioId ?? ""), 10);
        if (Number.isNaN(portfolioId) || portfolioId <= 0) {
          sendJson(res, 400, { error: "portfolioId is required" });
          return;
        }
        const { authUrl } = await startSchwabLoginFlow(portfolioId, {
          publicOrigin: getPublicOrigin(req),
        });
        sendJson(res, 200, { authUrl });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    const verifyMatch = pathname.match(/^\/api\/portfolios\/(\d+)\/verify$/);
    if (verifyMatch && method === "GET") {
      const portfolioId = parseInt(verifyMatch[1], 10);
      try {
        const result = await verifyConnection(portfolioId);
        sendJson(res, 200, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { ok: false, message });
      }
      return;
    }

    const runDailyCheckMatch = pathname.match(
      /^\/api\/portfolios\/(\d+)\/run-daily-check$/
    );
    if (runDailyCheckMatch && method === "POST") {
      if (!requireAuth(req, res)) return;
      const portfolioId = parseInt(runDailyCheckMatch[1], 10);
      if (Number.isNaN(portfolioId) || portfolioId <= 0) {
        sendJson(res, 400, { error: "Invalid portfolio id" });
        return;
      }
      try {
        const portfolios = await listPortfolios();
        if (!portfolios.some((p) => p.id === portfolioId)) {
          sendJson(res, 404, { error: "Portfolio not found" });
          return;
        }
        const outcome = await runCheckForPortfolio(portfolioId);
        if (outcome.kind === "weekend_skip") {
          sendJson(res, 200, {
            ok: true,
            skipped: "weekend",
            message: `Daily check does not run on weekends (${DAILY_CHECK_TIMEZONE}). Set DAILY_CHECK_ALLOW_WEEKENDS=true to override.`,
          });
          return;
        }
        sendJson(res, 200, { ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    if (pathname === "/api/tradier/preview-accounts" && method === "POST") {
      if (!requireAuth(req, res)) return;
      try {
        const body = await parseBody(req);
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const sandbox = Boolean(body.sandbox);
        if (!apiKey) {
          sendJson(res, 400, { error: "apiKey is required" });
          return;
        }
        const accounts = await listTradierAccountsForKey(apiKey, sandbox);
        sendJson(res, 200, { accounts });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 400, { error: message });
      }
      return;
    }

    const tradierAccountsListMatch = pathname.match(
      /^\/api\/portfolios\/(\d+)\/tradier-accounts$/
    );
    if (tradierAccountsListMatch && method === "GET") {
      const portfolioId = parseInt(tradierAccountsListMatch[1], 10);
      if (Number.isNaN(portfolioId) || portfolioId <= 0) {
        sendJson(res, 400, { error: "Invalid portfolio id" });
        return;
      }
      try {
        const creds = await readTradierCredentials(portfolioId);
        if (!creds) {
          sendJson(res, 400, { error: "This portfolio is not connected with Tradier." });
          return;
        }
        const accounts = await listTradierAccountsForKey(creds.apiKey, creds.sandbox);
        sendJson(res, 200, { accounts });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 400, { error: message });
      }
      return;
    }

    const tradierAccountPutMatch = pathname.match(
      /^\/api\/portfolios\/(\d+)\/tradier-account$/
    );
    if (tradierAccountPutMatch && method === "PUT") {
      if (!requireAuth(req, res)) return;
      const portfolioId = parseInt(tradierAccountPutMatch[1], 10);
      if (Number.isNaN(portfolioId) || portfolioId <= 0) {
        sendJson(res, 400, { error: "Invalid portfolio id" });
        return;
      }
      try {
        const body = await parseBody(req);
        const accountId =
          typeof body.accountId === "string" ? body.accountId.trim() : "";
        if (!accountId) {
          sendJson(res, 400, { error: "accountId is required" });
          return;
        }
        const portfolios = await listPortfolios();
        if (!portfolios.some((p) => p.id === portfolioId)) {
          sendJson(res, 404, { error: "Portfolio not found" });
          return;
        }
        await updateTradierPortfolioAccountId(portfolioId, accountId);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        let status = 500;
        if (message === "Portfolio not found") status = 404;
        else if (
          message.includes("not in your Tradier profile") ||
          message.includes("No Tradier credentials") ||
          message.includes("accountId is required")
        ) {
          status = 400;
        }
        sendJson(res, status, { error: message });
      }
      return;
    }

    if (pathname === "/api/tradier/connect" && method === "POST") {
      if (!requireAuth(req, res)) return;
      let connectPortfolioId: number | undefined;
      try {
        const body = await parseBody(req);
        const portfolioId =
          typeof body.portfolioId === "number"
            ? body.portfolioId
            : parseInt(String(body.portfolioId ?? ""), 10);
        connectPortfolioId = portfolioId;
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const sandbox = Boolean(body.sandbox);
        const accountIdFromBody =
          typeof body.accountId === "string" ? body.accountId.trim() : "";
        if (Number.isNaN(portfolioId) || portfolioId <= 0) {
          sendJson(res, 400, { error: "portfolioId is required" });
          return;
        }
        if (!apiKey) {
          sendJson(res, 400, { error: "apiKey is required" });
          return;
        }
        const portfolios = await listPortfolios();
        if (!portfolios.some((p) => p.id === portfolioId)) {
          sendJson(res, 404, { error: "Portfolio not found" });
          return;
        }
        console.log(`[API] Tradier connect: portfolioId=${portfolioId} sandbox=${sandbox}`);
        let accountId: string;
        if (accountIdFromBody) {
          const choices = await listTradierAccountsForKey(apiKey, sandbox);
          if (!isTradierAccountInProfileList(accountIdFromBody, choices)) {
            sendJson(res, 400, {
              error:
                "Selected account is not in your Tradier profile for this API key.",
            });
            return;
          }
          accountId = accountIdFromBody;
        } else {
          accountId = await getTradierAccountId(apiKey, sandbox);
        }
        await writeTradierCredentials(portfolioId, {
          apiKey,
          accountId,
          sandbox,
        });
        sendJson(res, 200, { ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `[API] Tradier connect failed portfolioId=${connectPortfolioId ?? "?"}:`,
          message
        );
        sendJson(res, 400, { error: message });
      }
      return;
    }

    if (pathname === "/api/performance" && method === "GET") {
      try {
        const portfolioIdParam = url.searchParams.get("portfolioId");
        const portfolioId = portfolioIdParam ? parseInt(portfolioIdParam, 10) : undefined;
        const validPortfolioId =
          portfolioId != null && Number.isInteger(portfolioId) && portfolioId > 0
            ? portfolioId
            : undefined;
        const performance = await readMonthlyPerformance(validPortfolioId);
        const closedTrades = await readClosedTrades(validPortfolioId, 50);
        const byStrategy = await readPerformanceByStrategy(validPortfolioId);
        const open = await readOpenPerformanceSummary(validPortfolioId);
        sendJson(res, 200, { monthly: performance, closedTrades, byStrategy, open });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    if (pathname === "/api/statistics" && method === "GET") {
      try {
        const stats = await readJobStatistics();
        const portfolios = await listPortfolios();
        const connectedCount = portfolios.filter((p) => p.hasCredentials).length;
        sendJson(res, 200, {
          lastProcessedDate: stats.lastProcessedDate,
          lastProcessedTimestamp: stats.lastProcessedTimestamp,
          portfolioCount: portfolios.length,
          connectedCount,
          portfolioUrlEnvOverride: stats.portfolioUrlEnvOverride,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    const auditTradesMatch = pathname.match(/^\/api\/portfolios\/(\d+)\/audit-trades$/);
    if (auditTradesMatch && method === "POST") {
      if (!requireAuth(req, res)) return;
      const portfolioId = parseInt(auditTradesMatch[1], 10);
      if (Number.isNaN(portfolioId) || portfolioId <= 0) {
        sendJson(res, 400, { error: "Invalid portfolio id" });
        return;
      }
      try {
        const body = await parseBody(req);
        const mode = body.mode === "history" ? "history" : "daily";
        const slugRaw = typeof body.slug === "string" ? body.slug.trim() : "";
        if (!slugRaw) {
          sendJson(res, 400, { error: "slug is required" });
          return;
        }
        const slug = parseAndNormalizeSystemTraderSlug(slugRaw);
        const portfolios = await listPortfolios();
        const portfolio = portfolios.find((p) => p.id === portfolioId);
        if (!portfolio) {
          sendJson(res, 404, { error: "Portfolio not found" });
          return;
        }
        if (!portfolio.systemtraderSlugs.includes(slug)) {
          sendJson(res, 400, {
            error: `Portfolio is not configured for strategy "${slug}"`,
          });
          return;
        }
        const toleranceShares =
          typeof body.toleranceShares === "number"
            ? Math.max(0, Math.floor(body.toleranceShares))
            : parseInt(String(body.toleranceShares ?? "0"), 10) || 0;
        const executionLagDays =
          typeof body.executionLagDays === "number"
            ? Math.max(0, Math.floor(body.executionLagDays))
            : parseInt(String(body.executionLagDays ?? "1"), 10);
        const auditOptions = {
          toleranceShares: Number.isFinite(toleranceShares) ? toleranceShares : 0,
          executionLagDays: Number.isFinite(executionLagDays) ? executionLagDays : 1,
        };
        const date =
          typeof body.date === "string" && body.date.trim()
            ? body.date.trim()
            : undefined;
        const from =
          typeof body.from === "string" && body.from.trim() ? body.from.trim() : undefined;
        const to =
          typeof body.to === "string" && body.to.trim() ? body.to.trim() : undefined;

        console.log(
          `[API] Trade audit: portfolio=${portfolioId} slug=${slug} mode=${mode}`
        );

        let report;
        try {
          if (mode === "history") {
            const fromDate = from ?? date;
            const toDate = to ?? from ?? date;
            if (!fromDate || !toDate) {
              sendJson(res, 400, { error: "from and to dates are required for history mode" });
              return;
            }
            report = await auditHistory(portfolioId, slug, fromDate, toDate, auditOptions);
          } else {
            report = await auditDaily(portfolioId, slug, date, auditOptions);
          }
        } finally {
          await closeBrowser();
        }

        sendJson(res, 200, {
          report,
          hasFailures: auditReportHasFailures(report),
        });
      } catch (e) {
        await closeBrowser().catch(() => undefined);
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[API] Trade audit failed portfolioId=${portfolioId}:`, message);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    const strategyMatch = pathname.match(
      /^\/api\/portfolios\/(\d+)\/systemtrader-strategy$/
    );
    if (strategyMatch && method === "PUT") {
      if (!requireAuth(req, res)) return;
      try {
        const portfolioId = parseInt(strategyMatch[1], 10);
        if (Number.isNaN(portfolioId) || portfolioId <= 0) {
          sendJson(res, 400, { error: "Invalid portfolio id" });
          return;
        }
        const body = await parseBody(req);
        const raw = body.slugs;
        if (!Array.isArray(raw)) {
          sendJson(res, 400, { error: "slugs must be a non-empty array" });
          return;
        }
        const slugs = raw
          .map((x) => (typeof x === "string" ? x.trim() : ""))
          .filter((s) => s.length > 0);
        if (slugs.length === 0) {
          sendJson(res, 400, { error: "slugs must be a non-empty array" });
          return;
        }
        const portfolios = await listPortfolios();
        if (!portfolios.some((p) => p.id === portfolioId)) {
          sendJson(res, 404, { error: "Portfolio not found" });
          return;
        }
        await setPortfolioSystemTraderStrategies(portfolioId, slugs);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        let status = 500;
        if (message === "Portfolio not found") status = 404;
        else if (
          message.includes("Invalid strategy slug") ||
          message.includes("Unknown strategy slug") ||
          message.includes("At least one strategy")
        ) {
          status = 400;
        }
        sendJson(res, status, { error: message });
      }
      return;
    }

    const positionsMatch = pathname.match(/^\/api\/portfolios\/(\d+)\/positions$/);
    if (positionsMatch && method === "GET") {
      const portfolioId = parseInt(positionsMatch[1], 10);
      if (portfolioId <= 0) {
        sendJson(res, 400, { error: "Invalid portfolio id" });
        return;
      }
      try {
        const positions = await getPortfolioPositions(portfolioId);
        sendJson(res, 200, positions);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 503, { error: message });
      }
      return;
    }

    const holdingsByStrategyMatch = pathname.match(
      /^\/api\/portfolios\/(\d+)\/holdings-by-strategy$/
    );
    if (holdingsByStrategyMatch && method === "GET") {
      const portfolioId = parseInt(holdingsByStrategyMatch[1], 10);
      if (portfolioId <= 0) {
        sendJson(res, 400, { error: "Invalid portfolio id" });
        return;
      }
      try {
        const report = await getHoldingsByStrategy(portfolioId);
        sendJson(res, 200, report);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 503, { error: message });
      }
      return;
    }

    if (pathname.startsWith("/api/")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    serveUiFallback(res);
  });

  server.listen(UI_PORT, "0.0.0.0", () => {
    console.log(`UI server listening at http://localhost:${UI_PORT}`);
    const redirectUri = process.env.SCHWAB_REDIRECT_URI?.trim();
    if (redirectUri) {
      console.log(`[Schwab OAuth] SCHWAB_REDIRECT_URI=${redirectUri}`);
      console.log(
        `[Schwab OAuth] Incoming callback paths: ${schwabCallbackPathnames().join(", ")}`
      );
    }
  });

  return server;
}

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
} from "./state";
import { startSchwabLoginFlow, handleSchwabCallback } from "./schwab-oauth";
import {
  getTradierAccountId,
  isTradierAccountInProfileList,
  listTradierAccountsForKey,
} from "./tradier-client";
import { verifyConnection, getPortfolioPositions } from "./trader";

const UI_PORT = parseInt(process.env.UI_PORT || "3000", 10);

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

export function startUiServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${UI_PORT}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

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

    if (pathname === "/api/portfolios" && method === "GET") {
      try {
        const portfolios = await listPortfolios();
        sendJson(res, 200, portfolios);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    if (pathname === "/api/portfolios" && method === "POST") {
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
        const { authUrl } = await startSchwabLoginFlow(portfolioId);
        sendJson(res, 200, { authUrl });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    const schwabRedirectUri = process.env.SCHWAB_REDIRECT_URI?.trim();
    const schwabCallbackPath =
      schwabRedirectUri &&
      (() => {
        try {
          return new URL(schwabRedirectUri).pathname;
        } catch {
          return null;
        }
      })();
    if (
      schwabCallbackPath &&
      pathname === schwabCallbackPath &&
      method === "GET"
    ) {
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
          `<html><body><h1>Callback error</h1><p>${message}</p></body></html>`
        );
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

    if (pathname === "/api/tradier/preview-accounts" && method === "POST") {
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

    const strategyMatch = pathname.match(
      /^\/api\/portfolios\/(\d+)\/systemtrader-strategy$/
    );
    if (strategyMatch && method === "PUT") {
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

    if (pathname.startsWith("/api/")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    serveUiFallback(res);
  });

  server.listen(UI_PORT, "0.0.0.0", () => {
    console.log(`UI server listening at http://localhost:${UI_PORT}`);
  });

  return server;
}

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  listPortfolios,
  createPortfolio,
  readState,
} from "./state";
import { startSchwabLoginFlow, isSchwabLoginInProgress } from "./schwab-oauth";
import { verifySchwabConnection, getPortfolioPositions } from "./trader";

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
        if (isSchwabLoginInProgress()) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "A Schwab login is already in progress" }));
          return;
        }
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

    const verifyMatch = pathname.match(/^\/api\/portfolios\/(\d+)\/verify$/);
    if (verifyMatch && method === "GET") {
      const portfolioId = parseInt(verifyMatch[1], 10);
      try {
        const result = await verifySchwabConnection(portfolioId);
        sendJson(res, 200, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { ok: false, message });
      }
      return;
    }

    if (pathname === "/api/statistics" && method === "GET") {
      try {
        const state = await readState();
        const portfolios = await listPortfolios();
        const connectedCount = portfolios.filter((p) => p.hasCredentials).length;
        sendJson(res, 200, {
          lastProcessedDate: state.lastProcessedDate,
          lastProcessedTimestamp: state.lastProcessedTimestamp,
          portfolioCount: portfolios.length,
          connectedCount,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        sendJson(res, 500, { error: message });
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

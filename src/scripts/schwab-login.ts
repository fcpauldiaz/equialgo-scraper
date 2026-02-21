/**
 * Schwab OAuth login script.
 * Starts a local HTTPS server on 127.0.0.1, opens the browser for login,
 * then saves tokens and account number to the database (schwab_credentials table).
 *
 * Prerequisites in .env: SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, DATABASE_URL, DATABASE_AUTH_TOKEN
 * Callback URL in Schwab app must be: https://127.0.0.1:8765/callback
 *
 * Run: pnpm run build && pnpm run schwab-login
 */

import "dotenv/config";
import * as https from "https";
import { exec } from "child_process";
// @ts-ignore - no types
import selfsigned from "selfsigned";
import { initializeDatabase, writeSchwabCredentials } from "../state";

const REDIRECT_PORT = parseInt(process.env.SCHWAB_REDIRECT_PORT || "8765", 10);
const REDIRECT_PATH = "/callback";
const HOST = "127.0.0.1";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.warn("Could not open browser:", err.message);
  });
}

async function main(): Promise<void> {
  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "Missing SCHWAB_CLIENT_ID or SCHWAB_CLIENT_SECRET in .env"
    );
    process.exit(1);
  }

  if (!process.env.DATABASE_URL || !process.env.DATABASE_AUTH_TOKEN) {
    console.error(
      "Missing DATABASE_URL or DATABASE_AUTH_TOKEN in .env (required to save credentials to the database)"
    );
    process.exit(1);
  }

  const redirectUri = `https://${HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;
  console.log("Using redirect URI:", redirectUri);
  console.log(
    "Ensure this exact URI is added to your Schwab app's callback URLs.\n"
  );

  const attrs = [{ name: "commonName", value: HOST }];
  const pems = await selfsigned.generate(attrs, {
    extensions: [
      { name: "subjectAltName", altNames: [{ type: 2, value: HOST }, { type: 7, ip: "127.0.0.1" }] },
    ],
  });
  const httpsOptions = {
    key: pems.private,
    cert: pems.cert,
  };

  const importDynamic = new Function("specifier", "return import(specifier)");
  const schwabApi = await importDynamic("@sudowealth/schwab-api");
  const { createSchwabAuth, createApiClient } = schwabApi;

  const auth = createSchwabAuth({
    oauthConfig: {
      clientId,
      clientSecret,
      redirectUri,
    },
  });

  const urlResult = await auth.getAuthorizationUrl();
  const authUrl = urlResult?.authUrl ?? (urlResult as any)?.authUrl;
  if (!authUrl || typeof authUrl !== "string") {
    console.error("Failed to get authorization URL from Schwab auth. Got:", urlResult);
    process.exit(1);
  }

  const server = https.createServer(httpsOptions, async (req, res) => {
    const url = new URL(req.url || "/", `https://${HOST}:${REDIRECT_PORT}`);
    if (url.pathname !== REDIRECT_PATH) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    console.log("Callback received from Schwab.");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    const errorParam = url.searchParams.get("error");

    if (errorParam) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h1>Login failed</h1><p>Error: ${errorParam}</p><p>${url.searchParams.get("error_description") || ""}</p></body></html>`
      );
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      const tip = `Make sure your Schwab app's Callback URL is exactly: <strong>${redirectUri}</strong> (no trailing slash, correct port).`;
      res.end(
        `<html><body><h1>Missing code</h1><p>No authorization code in callback URL.</p><p>${tip}</p><p>If you see the Schwab login page again after signing in, the redirect URI may not match.</p></body></html>`
      );
      server.close();
      process.exit(1);
    }

    try {
      const tokens = await auth.exchangeCode(code, state);
      const accessToken = (tokens as any).accessToken ?? (tokens as any).access_token;
      const refreshToken = (tokens as any).refreshToken ?? (tokens as any).refresh_token;

      if (!accessToken || !refreshToken) {
        throw new Error("Tokens missing accessToken or refreshToken");
      }

      const apiClient = createApiClient({
        auth,
        middleware: {
          rateLimit: { maxRequests: 120, windowMs: 60_000 },
          retry: { maxAttempts: 3, baseDelayMs: 1000 },
        },
      });

      let accountNumber: string | undefined;
      try {
        const accounts = await apiClient.trader.accounts.getAccounts();
        const first = (accounts as any)?.[0] ?? (accounts as any)?.accounts?.[0];
        if (first?.securitiesAccount?.accountNumber) {
          accountNumber = String(first.securitiesAccount.accountNumber);
          console.log("Detected account number (hash):", accountNumber);
        }
      } catch (e) {
        console.warn("Could not fetch accounts (you can set SCHWAB_ACCOUNT_NUMBER in .env later):", (e as Error).message);
      }

      await initializeDatabase();
      await writeSchwabCredentials({
        accessToken,
        refreshToken,
        redirectUri,
        ...(accountNumber && { accountNumber }),
      });

      console.log("Credentials saved to the database.");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;max-width:480px;margin:2em auto;padding:1em;"><h1 style="color:green;">✓ Success</h1><p>Credentials saved to the database.</p><p>You can close this tab and run <code>pnpm run verify:schwab</code> to confirm.</p></body></html>`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Token exchange failed:", msg);
      const redirectTip = `Your Schwab app Callback URL must be exactly: <strong>${redirectUri}</strong> (no trailing slash).`;
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;max-width:520px;margin:2em auto;padding:1em;"><h1 style="color:red;">Token exchange failed</h1><p>${msg}</p><p>${redirectTip}</p><p>If you keep seeing the Schwab login page after signing in, the callback URL in your Schwab app does not match.</p></body></html>`
      );
      process.exit(1);
    } finally {
      server.close();
    }
  });

  server.listen(REDIRECT_PORT, HOST, () => {
    console.log("HTTPS server listening at", redirectUri);
    console.log("Opening browser for Schwab login...");
    console.log(
      "If the browser warns about the certificate, choose Advanced → Proceed to 127.0.0.1 (self-signed cert is expected)."
    );
    console.log("Complete sign-in in the browser; you will be redirected back here. Do not close this terminal.\n");
    openBrowser(authUrl);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

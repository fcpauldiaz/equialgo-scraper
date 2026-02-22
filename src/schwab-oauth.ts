import * as https from "https";
// @ts-ignore - no types
import selfsigned from "selfsigned";
import { writeSchwabCredentials } from "./state";

const REDIRECT_PORT = parseInt(process.env.SCHWAB_REDIRECT_PORT || "8765", 10);
const REDIRECT_PATH = "/callback";
const HOST = "127.0.0.1";

let loginInProgress = false;

export function isSchwabLoginInProgress(): boolean {
  return loginInProgress;
}

export interface StartSchwabLoginResult {
  authUrl: string;
  flowComplete: Promise<void>;
}

export async function startSchwabLoginFlow(
  portfolioId: number
): Promise<StartSchwabLoginResult> {
  if (loginInProgress) {
    throw new Error("A Schwab login is already in progress");
  }

  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET are required");
  }

  const redirectUri = `https://${HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;

  const attrs = [{ name: "commonName", value: HOST }];
  const pems = await selfsigned.generate(attrs, {
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: HOST },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
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
  let authUrl =
    urlResult?.authUrl ?? (urlResult as { authUrl?: string })?.authUrl;
  if (!authUrl || typeof authUrl !== "string") {
    throw new Error("Failed to get authorization URL from Schwab auth");
  }
  const stateParam = String(portfolioId);
  authUrl = authUrl.includes("?")
    ? `${authUrl}&state=${encodeURIComponent(stateParam)}`
    : `${authUrl}?state=${encodeURIComponent(stateParam)}`;

  loginInProgress = true;
  let resolveFlowComplete: () => void;
  const flowComplete = new Promise<void>((r) => {
    resolveFlowComplete = r;
  });

  const server = https.createServer(httpsOptions, async (req, res) => {
    const url = new URL(req.url || "/", `https://${HOST}:${REDIRECT_PORT}`);
    if (url.pathname !== REDIRECT_PATH) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");
    const resolvedPortfolioId = state ? parseInt(state, 10) : portfolioId;
    const isNaNPortfolioId = Number.isNaN(resolvedPortfolioId);

    if (errorParam) {
      loginInProgress = false;
      resolveFlowComplete();
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h1>Login failed</h1><p>Error: ${errorParam}</p><p>${url.searchParams.get("error_description") || ""}</p><script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: false }, '*');</script></body></html>`
      );
      server.close();
      return;
    }

    if (!code) {
      loginInProgress = false;
      resolveFlowComplete();
      const tip = `Make sure your Schwab app's Callback URL is exactly: <strong>${redirectUri}</strong> (no trailing slash, correct port).`;
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h1>Missing code</h1><p>No authorization code in callback URL.</p><p>${tip}</p><script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: false }, '*');</script></body></html>`
      );
      server.close();
      return;
    }

    if (isNaNPortfolioId || resolvedPortfolioId <= 0) {
      loginInProgress = false;
      resolveFlowComplete();
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        `<html><body><h1>Invalid state</h1><p>Could not determine portfolio.</p><script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: false }, '*');</script></body></html>`
      );
      server.close();
      return;
    }

    try {
      const tokens = await auth.exchangeCode(code, state ?? undefined);
      const accessToken =
        (tokens as { accessToken?: string; access_token?: string }).accessToken ??
        (tokens as { access_token?: string }).access_token;
      const refreshToken =
        (tokens as { refreshToken?: string; refresh_token?: string })
          .refreshToken ?? (tokens as { refresh_token?: string }).refresh_token;

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
        const first =
          (accounts as { securitiesAccount?: { accountNumber?: string } }[])?.[0] ??
          (accounts as { accounts?: { securitiesAccount?: { accountNumber?: string } }[] })
            ?.accounts?.[0];
        if (first?.securitiesAccount?.accountNumber) {
          accountNumber = String(first.securitiesAccount.accountNumber);
        }
      } catch {
        // optional
      }

      await writeSchwabCredentials(resolvedPortfolioId, {
        accessToken,
        refreshToken,
        redirectUri,
        ...(accountNumber && { accountNumber }),
      });

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;max-width:480px;margin:2em auto;padding:1em;"><h1 style="color:green;">✓ Success</h1><p>Credentials saved for this portfolio.</p><p>You can close this tab.</p><script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: true }, '*');</script></body></html>`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const redirectTip = `Your Schwab app Callback URL must be exactly: <strong>${redirectUri}</strong> (no trailing slash).`;
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;max-width:520px;margin:2em auto;padding:1em;"><h1 style="color:red;">Token exchange failed</h1><p>${msg}</p><p>${redirectTip}</p><script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: false }, '*');</script></body></html>`
      );
    } finally {
      loginInProgress = false;
      resolveFlowComplete();
      server.close();
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(REDIRECT_PORT, HOST, () => {
      resolve({ authUrl, flowComplete });
    });
    server.on("error", (err) => {
      loginInProgress = false;
      reject(err);
    });
  });
}

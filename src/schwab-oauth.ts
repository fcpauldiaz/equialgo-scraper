import * as https from "https";
// @ts-ignore - no types
import selfsigned from "selfsigned";
import { writeSchwabCredentials } from "./state";
import { clearSchwabCachesForPortfolio } from "./trader";

const REDIRECT_PORT = parseInt(process.env.SCHWAB_REDIRECT_PORT || "8765", 10);
const REDIRECT_PATH = "/callback";
const HOST = "127.0.0.1";

const DEFAULT_REDIRECT_URI = `https://${HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;

let loginInProgress = false;
let pendingResolveFlowComplete: (() => void) | null = null;
let pendingPortfolioId: number | null = null;

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
    pendingResolveFlowComplete?.();
    pendingResolveFlowComplete = null;
    loginInProgress = false;
  }

  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET are required");
  }

  const envRedirectUri = process.env.SCHWAB_REDIRECT_URI?.trim();
  const useRemoteCallback = Boolean(envRedirectUri);
  const redirectUri = useRemoteCallback ? envRedirectUri : DEFAULT_REDIRECT_URI;
  const redirectLabel = useRemoteCallback && redirectUri
    ? "remote (" + new URL(redirectUri).origin + ")"
    : "local (127.0.0.1:" + REDIRECT_PORT + ")";
  console.log(`[Schwab OAuth] Starting login flow for portfolio ${portfolioId}, redirectUri=${redirectLabel}`);

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

  if (useRemoteCallback) {
    pendingPortfolioId = portfolioId;
    console.log("[Schwab OAuth] Using remote callback; pendingPortfolioId set to", portfolioId);
    pendingResolveFlowComplete = () => {
      loginInProgress = false;
      pendingPortfolioId = null;
      resolveFlowComplete();
      pendingResolveFlowComplete = null;
    };
    return Promise.resolve({ authUrl, flowComplete });
  }

  const server = https.createServer(httpsOptions, async (req, res) => {
    const url = new URL(req.url || "/", `https://${HOST}:${REDIRECT_PORT}`);
    if (url.pathname !== REDIRECT_PATH) {
      console.warn("[Schwab OAuth] Local callback: path not /callback", url.pathname);
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");
    console.log(
      "[Schwab OAuth] Local callback received",
      { hasCode: Boolean(code), stateLength: state?.length ?? 0, error: errorParam ?? null }
    );
    let resolvedPortfolioId = state ? parseInt(state, 10) : portfolioId;
    if (Number.isNaN(resolvedPortfolioId) || resolvedPortfolioId <= 0) {
      resolvedPortfolioId = portfolioId;
      console.log("[Schwab OAuth] Local callback: state not a portfolio id, using flow portfolioId", portfolioId);
    }

    if (errorParam) {
      console.warn("[Schwab OAuth] Local callback: OAuth error", errorParam, url.searchParams.get("error_description") ?? "");
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
      console.warn("[Schwab OAuth] Local callback: missing code in URL");
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

    if (resolvedPortfolioId <= 0) {
      console.warn("[Schwab OAuth] Local callback: invalid resolvedPortfolioId", resolvedPortfolioId);
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
      console.log("[Schwab OAuth] Local callback: token exchange succeeded for portfolio", resolvedPortfolioId);
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
        const raw = await apiClient.trader.accounts.getAccounts();
        const list = Array.isArray(raw)
          ? raw
          : (raw as { accounts?: unknown[] })?.accounts;
        const first = Array.isArray(list) ? list[0] : undefined;
        const item = first as { accountNumber?: string; securitiesAccount?: { accountNumber?: string } } | undefined;
        if (item?.securitiesAccount?.accountNumber) {
          accountNumber = String(item.securitiesAccount.accountNumber);
        } else if (item?.accountNumber) {
          accountNumber = String(item.accountNumber);
        }
        if (!accountNumber?.trim()) {
          console.warn("Schwab getAccounts did not return an account number; Verify and trading may fail until you re-link this portfolio.");
        }
      } catch (e) {
        console.warn("Could not fetch account number from Schwab getAccounts:", (e as Error).message);
      }

      await writeSchwabCredentials(resolvedPortfolioId, {
        accessToken,
        refreshToken,
        redirectUri,
        ...(accountNumber?.trim() && { accountNumber: accountNumber.trim() }),
      });
      clearSchwabCachesForPortfolio(resolvedPortfolioId);
      console.log("[Schwab OAuth] Local callback: credentials saved for portfolio", resolvedPortfolioId);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:sans-serif;max-width:480px;margin:2em auto;padding:1em;"><h1 style="color:green;">✓ Success</h1><p>Credentials saved for this portfolio.</p><p>You can close this tab.</p><script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: true }, '*');</script></body></html>`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[Schwab OAuth] Local callback: token exchange failed", msg);
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
      console.log("[Schwab OAuth] Local callback server listening on", `${HOST}:${REDIRECT_PORT}`);
      resolve({ authUrl, flowComplete });
    });
    server.on("error", (err) => {
      console.warn("[Schwab OAuth] Local callback server error", (err as Error).message);
      loginInProgress = false;
      reject(err);
    });
  });
}

const POST_SCRIPT =
  '<script>if (window.opener) window.opener.postMessage({ type: \'schwab-login-done\', success: false }, \'*\');</script>';

export interface HandleSchwabCallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  error_description?: string | null;
}

export interface HandleSchwabCallbackResult {
  html: string;
}

export async function handleSchwabCallback(
  params: HandleSchwabCallbackParams
): Promise<HandleSchwabCallbackResult> {
  console.log(
    "[Schwab OAuth] Remote callback received",
    { hasCode: Boolean(params.code), stateLength: params.state?.length ?? 0, error: params.error ?? null }
  );
  const redirectUri = process.env.SCHWAB_REDIRECT_URI?.trim();
  if (!redirectUri) {
    console.warn("[Schwab OAuth] Remote callback: SCHWAB_REDIRECT_URI not set");
    return {
      html: `<html><body><h1>Configuration error</h1><p>SCHWAB_REDIRECT_URI is not set. Use this callback only when running with a custom redirect URI.</p>${POST_SCRIPT}</body></html>`,
    };
  }

  const resolveFlow = () => {
    pendingResolveFlowComplete?.();
    pendingResolveFlowComplete = null;
    loginInProgress = false;
  };

  if (params.error) {
    console.warn("[Schwab OAuth] Remote callback: OAuth error", params.error, params.error_description ?? "");
    resolveFlow();
    return {
      html: `<html><body><h1>Login failed</h1><p>Error: ${params.error}</p><p>${params.error_description ?? ""}</p>${POST_SCRIPT}</body></html>`,
    };
  }

  if (!params.code) {
    console.warn("[Schwab OAuth] Remote callback: missing code");
    resolveFlow();
    const tip = `Callback URL must be exactly: <strong>${redirectUri}</strong> (no trailing slash).`;
    return {
      html: `<html><body><h1>Missing code</h1><p>No authorization code in callback URL.</p><p>${tip}</p>${POST_SCRIPT}</body></html>`,
    };
  }

  let resolvedPortfolioId = params.state ? parseInt(params.state, 10) : 0;
  if (Number.isNaN(resolvedPortfolioId) || resolvedPortfolioId <= 0) {
    resolvedPortfolioId = pendingPortfolioId ?? 0;
    console.log("[Schwab OAuth] Remote callback: state not a portfolio id, using pendingPortfolioId", pendingPortfolioId);
  }
  if (resolvedPortfolioId <= 0) {
    console.warn("[Schwab OAuth] Remote callback: could not resolve portfolio (state not numeric, no pendingPortfolioId)");
    resolveFlow();
    return {
      html: `<html><body><h1>Invalid state</h1><p>Could not determine portfolio. The OAuth provider may have overwritten the state parameter. Try Re-authorize again.</p>${POST_SCRIPT}</body></html>`,
    };
  }

  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn("[Schwab OAuth] Remote callback: SCHWAB_CLIENT_ID or SCHWAB_CLIENT_SECRET missing");
    resolveFlow();
    return {
      html: `<html><body><h1>Configuration error</h1><p>SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET are required.</p>${POST_SCRIPT}</body></html>`,
    };
  }

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

  try {
    const tokens = await auth.exchangeCode(params.code, params.state ?? undefined);
    console.log("[Schwab OAuth] Remote callback: token exchange succeeded for portfolio", resolvedPortfolioId);
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
      const raw = await apiClient.trader.accounts.getAccounts();
      const list = Array.isArray(raw)
        ? raw
        : (raw as { accounts?: unknown[] })?.accounts;
      const first = Array.isArray(list) ? list[0] : undefined;
      const item = first as { accountNumber?: string; securitiesAccount?: { accountNumber?: string } } | undefined;
      if (item?.securitiesAccount?.accountNumber) {
        accountNumber = String(item.securitiesAccount.accountNumber);
      } else if (item?.accountNumber) {
        accountNumber = String(item.accountNumber);
      }
    } catch {
      // optional
    }

    await writeSchwabCredentials(resolvedPortfolioId, {
      accessToken,
      refreshToken,
      redirectUri,
      ...(accountNumber?.trim() && { accountNumber: accountNumber.trim() }),
    });
    clearSchwabCachesForPortfolio(resolvedPortfolioId);
    console.log("[Schwab OAuth] Remote callback: credentials saved for portfolio", resolvedPortfolioId);

    resolveFlow();
    return {
      html: `<html><body style="font-family:sans-serif;max-width:480px;margin:2em auto;padding:1em;"><h1 style="color:green;">✓ Success</h1><p>Credentials saved for this portfolio.</p><p>You can close this tab.</p><script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: true }, '*');</script></body></html>`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[Schwab OAuth] Remote callback: token exchange failed", msg);
    resolveFlow();
    return {
      html: `<html><body style="font-family:sans-serif;max-width:520px;margin:2em auto;padding:1em;"><h1 style="color:red;">Token exchange failed</h1><p>${msg}</p><p>Your Schwab app Callback URL must be exactly: <strong>${redirectUri}</strong></p><script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: false }, '*');</script></body></html>`,
    };
  }
}

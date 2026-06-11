import * as https from "https";
// @ts-ignore - no types
import selfsigned from "selfsigned";
import { renderSchwabOAuthPage } from "./schwab-oauth-page";
import { writeSchwabCredentials } from "./state";
import { clearSchwabCachesForPortfolio } from "./trader";

const REDIRECT_PORT = parseInt(process.env.SCHWAB_REDIRECT_PORT || "8765", 10);
const REDIRECT_PATH = "/callback";
const HOST = "127.0.0.1";

const DEFAULT_REDIRECT_URI = `https://${HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;

/** OAuth callback path served by the UI server (must match Schwab app registration). */
export const SCHWAB_CANONICAL_CALLBACK_PATH = "/callback";

let loginInProgress = false;
let pendingResolveFlowComplete: (() => void) | null = null;
let pendingPortfolioId: number | null = null;
let pendingRedirectUri: string | null = null;
let localCallbackServer: https.Server | null = null;

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function resolveSchwabRedirectUri(publicOrigin?: string): string {
  const fromEnv = process.env.SCHWAB_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  const origin = publicOrigin?.trim().replace(/\/+$/, "");
  if (origin) return `${origin}${SCHWAB_CANONICAL_CALLBACK_PATH}`;
  return DEFAULT_REDIRECT_URI;
}

function isRemoteSchwabRedirectUri(redirectUri: string): boolean {
  try {
    const { hostname } = new URL(redirectUri);
    return hostname !== HOST && hostname !== "localhost";
  } catch {
    return redirectUri !== DEFAULT_REDIRECT_URI;
  }
}

export function schwabCallbackPathnames(): string[] {
  const paths = new Set<string>([
    normalizePathname(SCHWAB_CANONICAL_CALLBACK_PATH),
    normalizePathname(REDIRECT_PATH),
  ]);
  const override = process.env.SCHWAB_CALLBACK_INCOMING_PATH?.trim();
  if (override) {
    paths.add(
      normalizePathname(override.startsWith("/") ? override : `/${override}`)
    );
  }
  const fromEnv = process.env.SCHWAB_REDIRECT_URI?.trim();
  if (fromEnv) {
    try {
      paths.add(normalizePathname(new URL(fromEnv).pathname));
    } catch {
      // ignore invalid SCHWAB_REDIRECT_URI
    }
  }
  return Array.from(paths);
}

export function isSchwabCallbackPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return schwabCallbackPathnames().includes(normalized);
}

function clearPendingRemoteFlow(): void {
  pendingPortfolioId = null;
  pendingRedirectUri = null;
}

function closeExistingLocalCallbackServer(): Promise<void> {
  const s = localCallbackServer;
  if (!s) return Promise.resolve();
  localCallbackServer = null;
  return new Promise((resolve) => {
    s.close(() => resolve());
  });
}

export function isSchwabLoginInProgress(): boolean {
  return loginInProgress;
}

export interface StartSchwabLoginResult {
  authUrl: string;
  flowComplete: Promise<void>;
}

export interface StartSchwabLoginOptions {
  /** Public site origin, e.g. https://equialgo.example.com (from reverse-proxy headers). */
  publicOrigin?: string;
}

export async function startSchwabLoginFlow(
  portfolioId: number,
  options?: StartSchwabLoginOptions
): Promise<StartSchwabLoginResult> {
  if (loginInProgress) {
    pendingResolveFlowComplete?.();
    pendingResolveFlowComplete = null;
    loginInProgress = false;
  }

  await closeExistingLocalCallbackServer();

  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET are required");
  }

  const envRedirectUri = process.env.SCHWAB_REDIRECT_URI?.trim();
  const redirectUri = resolveSchwabRedirectUri(options?.publicOrigin);
  const useRemoteCallback = isRemoteSchwabRedirectUri(redirectUri);
  const redirectLabel = useRemoteCallback
    ? "remote (" + new URL(redirectUri).origin + ")"
    : "local (127.0.0.1:" + REDIRECT_PORT + ")";
  console.log(
    `[Schwab OAuth] Starting login flow for portfolio ${portfolioId}, redirectUri=${redirectLabel}` +
      (envRedirectUri ? "" : options?.publicOrigin ? " (auto from request origin)" : "")
  );

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
    pendingRedirectUri = redirectUri;
    console.log(
      "[Schwab OAuth] Using remote callback; pendingPortfolioId=",
      portfolioId,
      "redirectUri=",
      redirectUri
    );
    pendingResolveFlowComplete = () => {
      loginInProgress = false;
      clearPendingRemoteFlow();
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
        renderSchwabOAuthPage({
          variant: "error",
          title: "Login failed",
          message: "Schwab returned an error during authorization.",
          detail: [errorParam, url.searchParams.get("error_description") ?? ""]
            .filter(Boolean)
            .join(" — "),
          notifySuccess: false,
        })
      );
      server.close();
      return;
    }

    if (!code) {
      console.warn("[Schwab OAuth] Local callback: missing code in URL");
      loginInProgress = false;
      resolveFlowComplete();
      const tip = `Callback URL must be exactly: ${redirectUri} (no trailing slash, correct port).`;
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        renderSchwabOAuthPage({
          variant: "error",
          title: "Missing code",
          message: "No authorization code was returned in the callback URL.",
          detail: tip,
          notifySuccess: false,
        })
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
        renderSchwabOAuthPage({
          variant: "error",
          title: "Invalid state",
          message: "Could not determine which portfolio to link.",
          notifySuccess: false,
        })
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
        renderSchwabOAuthPage({
          variant: "success",
          title: "Connected",
          message: "Schwab credentials were saved for this portfolio.",
          notifySuccess: true,
        })
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[Schwab OAuth] Local callback: token exchange failed", msg);
      const redirectTip = `Schwab app callback URL must be exactly: ${redirectUri} (no trailing slash).`;
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(
        renderSchwabOAuthPage({
          variant: "error",
          title: "Token exchange failed",
          message: "Could not complete Schwab authorization.",
          detail: `${msg}\n\n${redirectTip}`,
          notifySuccess: false,
        })
      );
    } finally {
      loginInProgress = false;
      resolveFlowComplete();
      if (localCallbackServer === server) {
        localCallbackServer = null;
      }
      server.close();
    }
  });

  localCallbackServer = server;

  return new Promise((resolve, reject) => {
    server.listen(REDIRECT_PORT, HOST, () => {
      console.log("[Schwab OAuth] Local callback server listening on", `${HOST}:${REDIRECT_PORT}`);
      resolve({ authUrl, flowComplete });
    });
    server.on("error", (err) => {
      console.warn("[Schwab OAuth] Local callback server error", (err as Error).message);
      if (localCallbackServer === server) {
        localCallbackServer = null;
      }
      loginInProgress = false;
      reject(err);
    });
  });
}

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
  const redirectUri =
    process.env.SCHWAB_REDIRECT_URI?.trim() || pendingRedirectUri?.trim() || "";
  if (!redirectUri) {
    console.warn("[Schwab OAuth] Remote callback: no redirect URI (env or pending flow)");
    return {
      html: renderSchwabOAuthPage({
        variant: "error",
        title: "Configuration error",
        message: "Could not determine the Schwab callback URL for token exchange.",
        detail:
          "Set SCHWAB_REDIRECT_URI on the server, or start authorization from the EquiAlgo dashboard (not a stale tab).",
        notifySuccess: false,
      }),
    };
  }

  const resolveFlow = () => {
    pendingResolveFlowComplete?.();
    pendingResolveFlowComplete = null;
    clearPendingRemoteFlow();
    loginInProgress = false;
  };

  if (params.error) {
    console.warn("[Schwab OAuth] Remote callback: OAuth error", params.error, params.error_description ?? "");
    resolveFlow();
    return {
      html: renderSchwabOAuthPage({
        variant: "error",
        title: "Login failed",
        message: "Schwab returned an error during authorization.",
        detail: [params.error, params.error_description ?? ""].filter(Boolean).join(" — "),
        notifySuccess: false,
      }),
    };
  }

  if (!params.code) {
    console.warn("[Schwab OAuth] Remote callback: missing code");
    resolveFlow();
    const tip = `Callback URL must be exactly: ${redirectUri} (no trailing slash).`;
    return {
      html: renderSchwabOAuthPage({
        variant: "error",
        title: "Missing code",
        message: "No authorization code was returned in the callback URL.",
        detail: tip,
        notifySuccess: false,
      }),
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
      html: renderSchwabOAuthPage({
        variant: "error",
        title: "Invalid state",
        message: "Could not determine which portfolio to link.",
        detail: "Try Re-authorize again from the EquiAlgo dashboard.",
        notifySuccess: false,
      }),
    };
  }

  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn("[Schwab OAuth] Remote callback: SCHWAB_CLIENT_ID or SCHWAB_CLIENT_SECRET missing");
    resolveFlow();
    return {
      html: renderSchwabOAuthPage({
        variant: "error",
        title: "Configuration error",
        message: "Schwab API credentials are not configured on the server.",
        detail: "Set SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET.",
        notifySuccess: false,
      }),
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
      html: renderSchwabOAuthPage({
        variant: "success",
        title: "Connected",
        message: "Schwab credentials were saved for this portfolio.",
        notifySuccess: true,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[Schwab OAuth] Remote callback: token exchange failed", msg);
    resolveFlow();
    return {
      html: renderSchwabOAuthPage({
        variant: "error",
        title: "Token exchange failed",
        message: "Could not complete Schwab authorization.",
        detail: `${msg}\n\nSchwab app callback URL must be exactly: ${redirectUri}`,
        notifySuccess: false,
      }),
    };
  }
}

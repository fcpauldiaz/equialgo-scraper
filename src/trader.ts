import {
  readSchwabCredentials,
  writeSchwabCredentials,
  readTradierCredentials,
  writeTradierCredentials,
  getPortfolioBrokerage,
  type SchwabCredentials,
} from "./state";
import {
  getTradierAccountId,
  getTradierPositions,
  placeTradierOrder,
} from "./tradier-client";
import {
  ProcessedSignals,
  TradeExecutionResult,
  TradeExecutionSummary,
  PortfolioAction,
} from "./types";

type SchwabApiClient = any;
type TokenData = {
  accessToken: string;
  refreshToken?: string;
};

let schwabApiModule: any = null;

async function getSchwabApiModule() {
  if (!schwabApiModule) {
    // In Jest, use require() so jest.mock('@sudowealth/schwab-api') applies. Everywhere else
    // use dynamic import() because @sudowealth/schwab-api is ESM-only (require() throws ERR_REQUIRE_ESM).
    if (typeof process !== "undefined" && process.env.JEST_WORKER_ID !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      schwabApiModule = require("@sudowealth/schwab-api");
    } else {
      const importDynamic = new Function("specifier", "return import(specifier)");
      schwabApiModule = await importDynamic("@sudowealth/schwab-api");
    }
  }
  return schwabApiModule;
}

function isSchwabAuthError(error: any): boolean {
  return error && error.name === "SchwabAuthError" && typeof error.code === "string";
}

const ENABLE_TRADING = process.env.SCHWAB_ENABLE_TRADING === "true";
const ORDER_TYPE = (process.env.SCHWAB_ORDER_TYPE || "MARKET") as "MARKET" | "LIMIT";
const TRADIER_ENABLE_TRADING = process.env.TRADIER_ENABLE_TRADING === "true";
const TRADIER_ORDER_TYPE = (process.env.TRADIER_ORDER_TYPE || "market") as "market" | "limit";

const SCHWAB_API_BASE_URL =
  process.env.SCHWAB_API_BASE_URL ?? "https://api.schwabapi.com";
const SCHWAB_PLACE_ORDER_PATH = "/trader/v1/accounts/{accountNumber}/orders";

const schwabClientByPortfolio = new Map<number, SchwabApiClient>();
const accountHashByPortfolio = new Map<number, string>();

async function resolveTradierAccountId(
  portfolioId: number,
  creds: { apiKey: string; accountId?: string; sandbox: boolean }
): Promise<string> {
  if (creds.accountId?.trim()) {
    return creds.accountId.trim();
  }
  const accountId = await getTradierAccountId(creds.apiKey, creds.sandbox);
  await writeTradierCredentials(portfolioId, {
    apiKey: creds.apiKey,
    accountId,
    sandbox: creds.sandbox,
  });
  return accountId;
}

type AccountNumberEntry = { accountNumber: string; hashValue: string };

function parseAccountNumbersResponse(raw: unknown): AccountNumberEntry[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item: unknown) => {
      const o = item as { accountNumber?: string; hashValue?: string };
      if (o?.accountNumber != null && o?.hashValue != null) {
        return { accountNumber: String(o.accountNumber), hashValue: String(o.hashValue) };
      }
      return null;
    })
    .filter((e): e is AccountNumberEntry => e !== null);
}

async function getAccountHashFromApi(portfolioId: number): Promise<string> {
  const cached = accountHashByPortfolio.get(portfolioId);
  if (cached) {
    return cached;
  }
  const schwab = await initializeSchwabClient(portfolioId);
  const raw = await schwab.trader.accounts.getAccountNumbers();
  const entries = parseAccountNumbersResponse(raw);
  console.log(
    "Account numbers (hash) from getAccountNumbers():",
    entries.length ? entries.map((e) => ({ accountNumber: e.accountNumber, hashPrefix: e.hashValue.length > 8 ? e.hashValue.slice(0, 8) + "…" : "…" })) : "(none)"
  );
  const first = entries[0];
  if (!first?.hashValue?.trim()) {
    throw new Error(
      "Schwab getAccountNumbers() did not return a hash for this portfolio. Re-run Schwab OAuth login."
    );
  }
  accountHashByPortfolio.set(portfolioId, first.hashValue);
  return first.hashValue;
}

interface Position {
  symbol: string;
  longQuantity: number;
  shortQuantity: number;
  currentDayProfitLoss?: number;
  currentDayProfitLossPercentage?: number;
  longOpenProfitLoss?: number;
  marketValue?: number;
}

async function initializeSchwabClient(portfolioId: number): Promise<SchwabApiClient> {
  const cached = schwabClientByPortfolio.get(portfolioId);
  if (cached) {
    return cached;
  }

  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  const credentialsFromDb = await readSchwabCredentials(portfolioId);
  if (!credentialsFromDb?.accessToken || !credentialsFromDb?.refreshToken) {
    throw new Error(
      "Schwab credentials are required for this portfolio. Complete the Schwab OAuth login (UI or pnpm run schwab-login)."
    );
  }
  const redirectUri =
    process.env.SCHWAB_REDIRECT_URI ||
    credentialsFromDb.redirectUri ||
    "https://127.0.0.1:8765/callback";

  if (!clientId || !clientSecret) {
    throw new Error(
      "SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET (in .env or app config) are required"
    );
  }

  const schwabApi = await getSchwabApiModule();
  const { createSchwabAuth, createApiClient } = schwabApi;

  const auth = createSchwabAuth({
    oauthConfig: {
      clientId,
      clientSecret,
      redirectUri,
      load: async (): Promise<TokenData | null> => {
        const creds = await readSchwabCredentials(portfolioId);
        if (creds?.accessToken && creds?.refreshToken) {
          return {
            accessToken: creds.accessToken,
            refreshToken: creds.refreshToken,
          };
        }
        return null;
      },
      save: async (tokens: TokenData): Promise<void> => {
        try {
          const current = await readSchwabCredentials(portfolioId);
          await writeSchwabCredentials(portfolioId, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? current?.refreshToken ?? "",
            redirectUri: current?.redirectUri,
            accountNumber: current?.accountNumber,
          });
        } catch (e) {
          console.warn("Could not update Schwab credentials in database:", (e as Error).message);
        }
      },
    },
  });

  const client = createApiClient({
    auth,
    middleware: {
      rateLimit: { maxRequests: 120, windowMs: 60_000 },
      retry: { maxAttempts: 3, baseDelayMs: 1000 },
    },
  });

  schwabClientByPortfolio.set(portfolioId, client);
  return client;
}

async function refreshTokensIfNeeded(portfolioId: number): Promise<TokenData> {
  const creds = await readSchwabCredentials(portfolioId);
  const refreshToken = creds?.refreshToken;
  if (!refreshToken) {
    throw new Error("No refresh token for this portfolio; re-run Schwab OAuth login.");
  }

  const schwabApi = await getSchwabApiModule();
  const { createSchwabAuth } = schwabApi;
  const redirectUri =
    process.env.SCHWAB_REDIRECT_URI ??
    creds?.redirectUri ??
    "https://127.0.0.1:8765/callback";

  const auth = createSchwabAuth({
    oauthConfig: {
      clientId: process.env.SCHWAB_CLIENT_ID!,
      clientSecret: process.env.SCHWAB_CLIENT_SECRET!,
      redirectUri,
      load: async (): Promise<TokenData | null> => {
        const c = await readSchwabCredentials(portfolioId);
        if (c?.accessToken && c?.refreshToken) {
          return { accessToken: c.accessToken, refreshToken: c.refreshToken };
        }
        return null;
      },
      save: async (tokens: TokenData): Promise<void> => {
        const current = await readSchwabCredentials(portfolioId);
        await writeSchwabCredentials(portfolioId, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? current?.refreshToken ?? "",
          redirectUri: current?.redirectUri,
          accountNumber: current?.accountNumber,
        });
      },
    },
  });

  try {
    const newTokens = await auth.refresh(refreshToken);
    console.log("Tokens refreshed successfully");
    const current = await readSchwabCredentials(portfolioId);
    await writeSchwabCredentials(portfolioId, {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken ?? current?.refreshToken ?? "",
      redirectUri: current?.redirectUri,
      accountNumber: current?.accountNumber,
    });
    schwabClientByPortfolio.delete(portfolioId);
    accountHashByPortfolio.delete(portfolioId);
    return newTokens;
  } catch (error: unknown) {
    if (isSchwabAuthError(error) && (error as { code?: string }).code === "TOKEN_EXPIRED") {
      throw new Error(
        "Refresh token expired. Please re-authenticate through Schwab's OAuth flow."
      );
    }
    throw error;
  }
}

type PlaceOrderResponseBody = { orderId?: number };

async function placeOrderViaDirectPost(
  portfolioId: number,
  accountNumber: string,
  orderBody: Record<string, unknown>
): Promise<PlaceOrderResponseBody> {
  const path = SCHWAB_PLACE_ORDER_PATH.replace("{accountNumber}", encodeURIComponent(accountNumber));
  const url = `${SCHWAB_API_BASE_URL}${path}`;

  const doPost = async (accessToken: string): Promise<PlaceOrderResponseBody> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderBody),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }

    if (!res.ok) {
      const message =
        json && typeof json === "object" && "message" in json
          ? String((json as { message: unknown }).message)
          : text || res.statusText;
      const err = new Error(
        `Schwab place order failed: ${res.status} ${res.statusText}${message ? ` - ${message}` : ""}`
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    return (json as PlaceOrderResponseBody) ?? {};
  };

  let creds = await readSchwabCredentials(portfolioId);
  if (!creds?.accessToken) {
    throw new Error("Schwab credentials missing or no access token.");
  }

  try {
    return await doPost(creds.accessToken);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) {
      await refreshTokensIfNeeded(portfolioId);
      creds = await readSchwabCredentials(portfolioId);
      if (creds?.accessToken) {
        return await doPost(creds.accessToken);
      }
    }
    throw err;
  }
}

async function getCurrentPositions(
  portfolioId: number
): Promise<Map<string, Position>> {
  const brokerage = await getPortfolioBrokerage(portfolioId);
  if (brokerage === "tradier") {
    const creds = await readTradierCredentials(portfolioId);
    if (!creds) {
      throw new Error("Tradier credentials are required for this portfolio. Connect via Tradier in the UI.");
    }
    const accountId = await resolveTradierAccountId(portfolioId, creds);
    const positions = await getTradierPositions(creds.apiKey, accountId, creds.sandbox);
    const positionsMap = new Map<string, Position>();
    for (const p of positions) {
      positionsMap.set(p.symbol, {
        symbol: p.symbol,
        longQuantity: p.longQuantity,
        shortQuantity: 0,
      });
    }
    return positionsMap;
  }

  const schwab = await initializeSchwabClient(portfolioId);
  const positionsMap = new Map<string, Position>();

  const accountNumber = await getAccountHashFromApi(portfolioId);
  try {
    const account = await schwab.trader.accounts.getAccountByNumber({
      pathParams: { accountNumber },
      queryParams: { fields: "positions" },
    });

    if (account.securitiesAccount?.positions && Array.isArray(account.securitiesAccount.positions)) {
      for (const position of account.securitiesAccount.positions) {
        if (position.instrument?.symbol) {
          const p = position as {
            longQuantity?: number;
            shortQuantity?: number;
            currentDayProfitLoss?: number;
            currentDayProfitLossPercentage?: number;
            longOpenProfitLoss?: number;
            marketValue?: number;
          };
          const longQuantity = p.longQuantity ?? 0;
          const shortQuantity = p.shortQuantity ?? 0;
          positionsMap.set(position.instrument.symbol, {
            symbol: position.instrument.symbol,
            longQuantity,
            shortQuantity,
            currentDayProfitLoss: p.currentDayProfitLoss,
            currentDayProfitLossPercentage: p.currentDayProfitLossPercentage,
            longOpenProfitLoss: p.longOpenProfitLoss,
            marketValue: p.marketValue,
          });
        }
      }
    }
  } catch (error: unknown) {
    if (isSchwabAuthError(error) && (error as { code?: string }).code === "TOKEN_EXPIRED") {
      await refreshTokensIfNeeded(portfolioId);
      return getCurrentPositions(portfolioId);
    }
    console.error("Error fetching positions:", error);
    throw error;
  }

  return positionsMap;
}

export type VerifyConnectionResult = {
  ok: boolean;
  message: string;
  positionsCount?: number;
};

export async function verifyConnection(portfolioId: number): Promise<VerifyConnectionResult> {
  try {
    const brokerage = await getPortfolioBrokerage(portfolioId);
    if (!brokerage) {
      return { ok: false, message: "No credentials. Link this portfolio via Schwab or Tradier." };
    }
    const positions = await getCurrentPositions(portfolioId);
    const label = brokerage === "schwab" ? "Schwab" : "Tradier";
    return {
      ok: true,
      message: `${label} API connected`,
      positionsCount: positions.size,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

export async function verifySchwabConnection(portfolioId: number): Promise<VerifyConnectionResult> {
  return verifyConnection(portfolioId);
}

export type PortfolioPosition = {
  symbol: string;
  longQuantity: number;
  currentDayProfitLoss?: number;
  currentDayProfitLossPercentage?: number;
  longOpenProfitLoss?: number;
  marketValue?: number;
};

export async function getPortfolioPositions(
  portfolioId: number
): Promise<PortfolioPosition[]> {
  const map = await getCurrentPositions(portfolioId);
  return Array.from(map.values()).map((p) => ({
    symbol: p.symbol,
    longQuantity: p.longQuantity,
    currentDayProfitLoss: p.currentDayProfitLoss,
    currentDayProfitLossPercentage: p.currentDayProfitLossPercentage,
    longOpenProfitLoss: p.longOpenProfitLoss,
    marketValue: p.marketValue,
  }));
}

async function placeBuyOrder(
  portfolioId: number,
  symbol: string,
  shares: number,
  price: number
): Promise<TradeExecutionResult> {
  if (shares <= 0) {
    return {
      symbol,
      action: "BUY",
      shares,
      price,
      success: false,
      error: "Invalid share quantity: must be greater than 0",
    };
  }

  const brokerage = await getPortfolioBrokerage(portfolioId);
  if (brokerage === "tradier") {
    if (!TRADIER_ENABLE_TRADING) {
      return {
        symbol,
        action: "BUY",
        shares,
        price,
        success: false,
        error: "Trading is disabled (TRADIER_ENABLE_TRADING=false)",
      };
    }
    const creds = await readTradierCredentials(portfolioId);
    if (!creds) {
      return {
        symbol,
        action: "BUY",
        shares,
        price,
        success: false,
        error: "Tradier credentials missing for this portfolio.",
      };
    }
    try {
      const accountId = await resolveTradierAccountId(portfolioId, creds);
      const { orderId } = await placeTradierOrder(
        creds.apiKey,
        accountId,
        creds.sandbox,
        "buy",
        symbol,
        shares,
        price,
        TRADIER_ORDER_TYPE
      );
      return {
        symbol,
        action: "BUY",
        shares,
        price,
        success: true,
        orderId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to place Tradier BUY order for ${symbol}:`, errorMessage);
      return {
        symbol,
        action: "BUY",
        shares,
        price,
        success: false,
        error: errorMessage,
      };
    }
  }

  if (!ENABLE_TRADING) {
    return {
      symbol,
      action: "BUY",
      shares,
      price,
      success: false,
      error: "Trading is disabled (SCHWAB_ENABLE_TRADING=false)",
    };
  }

  const accountNumber = await getAccountHashFromApi(portfolioId);

  try {
    const orderBody: {
      orderType: "MARKET" | "LIMIT";
      session: "NORMAL";
      duration: "DAY";
      orderStrategyType: "SINGLE";
      orderLegCollection: Array<{
        instruction: "BUY";
        quantity: number;
        instrument: {
          symbol: string;
          assetType: "EQUITY";
        };
      }>;
      price?: number;
    } = {
      orderType: ORDER_TYPE,
      session: "NORMAL",
      duration: "DAY",
      orderStrategyType: "SINGLE",
      orderLegCollection: [
        {
          instruction: "BUY",
          quantity: shares,
          instrument: {
            symbol,
            assetType: "EQUITY",
          },
        },
      ],
    };

    if (ORDER_TYPE === "LIMIT") {
      orderBody.price = price;
    }

    const response = await placeOrderViaDirectPost(
      portfolioId,
      accountNumber,
      orderBody as Record<string, unknown>
    );

    return {
      symbol,
      action: "BUY",
      shares,
      price,
      success: true,
      orderId: response.orderId?.toString(),
    };
  } catch (error: unknown) {
    if (isSchwabAuthError(error) && (error as { code?: string }).code === "TOKEN_EXPIRED") {
      await refreshTokensIfNeeded(portfolioId);
      return placeBuyOrder(portfolioId, symbol, shares, price);
    }

    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(`Failed to place BUY order for ${symbol}:`, errorMessage);

    return {
      symbol,
      action: "BUY",
      shares,
      price,
      success: false,
      error: errorMessage,
    };
  }
}

async function placeSellOrder(
  portfolioId: number,
  symbol: string,
  shares: number,
  price: number
): Promise<TradeExecutionResult> {
  if (shares <= 0) {
    return {
      symbol,
      action: "SELL",
      shares,
      price,
      success: false,
      error: "Invalid share quantity: must be greater than 0",
    };
  }

  const brokerage = await getPortfolioBrokerage(portfolioId);
  if (brokerage === "tradier") {
    if (!TRADIER_ENABLE_TRADING) {
      return {
        symbol,
        action: "SELL",
        shares,
        price,
        success: false,
        error: "Trading is disabled (TRADIER_ENABLE_TRADING=false)",
      };
    }
    const creds = await readTradierCredentials(portfolioId);
    if (!creds) {
      return {
        symbol,
        action: "SELL",
        shares,
        price,
        success: false,
        error: "Tradier credentials missing for this portfolio.",
      };
    }
    try {
      const accountId = await resolveTradierAccountId(portfolioId, creds);
      const { orderId } = await placeTradierOrder(
        creds.apiKey,
        accountId,
        creds.sandbox,
        "sell",
        symbol,
        shares,
        price,
        TRADIER_ORDER_TYPE
      );
      return {
        symbol,
        action: "SELL",
        shares,
        price,
        success: true,
        orderId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to place Tradier SELL order for ${symbol}:`, errorMessage);
      return {
        symbol,
        action: "SELL",
        shares,
        price,
        success: false,
        error: errorMessage,
      };
    }
  }

  if (!ENABLE_TRADING) {
    return {
      symbol,
      action: "SELL",
      shares,
      price,
      success: false,
      error: "Trading is disabled (SCHWAB_ENABLE_TRADING=false)",
    };
  }

  const accountNumber = await getAccountHashFromApi(portfolioId);

  try {
    const orderBody: {
      orderType: "MARKET" | "LIMIT";
      session: "NORMAL";
      duration: "DAY";
      orderStrategyType: "SINGLE";
      orderLegCollection: Array<{
        instruction: "SELL";
        quantity: number;
        instrument: {
          symbol: string;
          assetType: "EQUITY";
        };
      }>;
      price?: number;
    } = {
      orderType: ORDER_TYPE,
      session: "NORMAL",
      duration: "DAY",
      orderStrategyType: "SINGLE",
      orderLegCollection: [
        {
          instruction: "SELL",
          quantity: shares,
          instrument: {
            symbol,
            assetType: "EQUITY",
          },
        },
      ],
    };

    if (ORDER_TYPE === "LIMIT") {
      orderBody.price = price;
    }

    const response = await placeOrderViaDirectPost(
      portfolioId,
      accountNumber,
      orderBody as Record<string, unknown>
    );

    return {
      symbol,
      action: "SELL",
      shares,
      price,
      success: true,
      orderId: response.orderId?.toString(),
    };
  } catch (error: unknown) {
    if (isSchwabAuthError(error) && (error as { code?: string }).code === "TOKEN_EXPIRED") {
      await refreshTokensIfNeeded(portfolioId);
      return placeSellOrder(portfolioId, symbol, shares, price);
    }

    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(`Failed to place SELL order for ${symbol}:`, errorMessage);

    return {
      symbol,
      action: "SELL",
      shares,
      price,
      success: false,
      error: errorMessage,
    };
  }
}

export async function executeTrades(
  portfolioId: number,
  signals: ProcessedSignals
): Promise<TradeExecutionSummary> {
  const summary: TradeExecutionSummary = {
    successful: [],
    failed: [],
    skipped: [],
  };

  const brokerage = await getPortfolioBrokerage(portfolioId);
  const tradingDisabled =
    (brokerage === "schwab" && !ENABLE_TRADING) ||
    (brokerage === "tradier" && !TRADIER_ENABLE_TRADING);
  if (brokerage && tradingDisabled) {
    console.log(
      `Trading is disabled for ${brokerage}. Set ${brokerage === "schwab" ? "SCHWAB" : "TRADIER"}_ENABLE_TRADING=true to enable.`
    );
    return summary;
  }
  if (!brokerage) {
    return summary;
  }

  console.log("Executing trades for signals...");

  let positions: Map<string, Position>;
  try {
    positions = await getCurrentPositions(portfolioId);
    console.log(`Fetched ${positions.size} current positions`);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error("Failed to fetch positions:", errorMessage);
    summary.failed.push({
      symbol: "ALL",
      action: "BUY",
      shares: 0,
      price: 0,
      success: false,
      error: `Failed to fetch positions: ${errorMessage}`,
    });
    return summary;
  }

  for (const signal of signals.enterSignals) {
    const position = positions.get(signal.symbol);
    if (position && position.longQuantity > 0) {
      summary.skipped.push({
        symbol: signal.symbol,
        reason: `Already holding ${position.longQuantity} shares`,
      });
      continue;
    }

    const result = await placeBuyOrder(
      portfolioId,
      signal.symbol,
      signal.shares,
      signal.current_price
    );

    if (result.success) {
      summary.successful.push(result);
      console.log(
        `✓ BUY order placed: ${signal.symbol} - ${signal.shares} shares @ $${signal.current_price.toFixed(2)}`
      );
    } else {
      summary.failed.push(result);
      console.error(
        `✗ BUY order failed: ${signal.symbol} - ${result.error}`
      );
    }
  }

  for (const signal of signals.exitSignals) {
    const position = positions.get(signal.symbol);
    if (!position || position.longQuantity === 0) {
      summary.skipped.push({
        symbol: signal.symbol,
        reason: "No position to exit",
      });
      continue;
    }

    const sharesToSell = position.longQuantity;

    const result = await placeSellOrder(
      portfolioId,
      signal.symbol,
      sharesToSell,
      signal.current_price
    );

    if (result.success) {
      summary.successful.push(result);
      console.log(
        `✓ SELL order placed: ${signal.symbol} - ${sharesToSell} shares @ $${signal.current_price.toFixed(2)}`
      );
    } else {
      summary.failed.push(result);
      console.error(
        `✗ SELL order failed: ${signal.symbol} - ${result.error}`
      );
    }
  }

  console.log(
    `Trade execution complete: ${summary.successful.length} successful, ${summary.failed.length} failed, ${summary.skipped.length} skipped`
  );

  return summary;
}

export async function executeTradesFromActions(
  actions: PortfolioAction[],
  portfolioId: number
): Promise<TradeExecutionSummary> {
  const summary: TradeExecutionSummary = {
    successful: [],
    failed: [],
    skipped: [],
  };

  const brokerage = await getPortfolioBrokerage(portfolioId);
  const tradingDisabled =
    (brokerage === "schwab" && !ENABLE_TRADING) ||
    (brokerage === "tradier" && !TRADIER_ENABLE_TRADING);
  if (brokerage && tradingDisabled) {
    console.log(
      `Trading is disabled for ${brokerage}. Set ${brokerage === "schwab" ? "SCHWAB" : "TRADIER"}_ENABLE_TRADING=true to enable.`
    );
    return summary;
  }
  if (!brokerage) {
    return summary;
  }

  if (actions.length === 0) {
    console.log("No actions to execute");
    return summary;
  }

  console.log(`Executing ${actions.length} trades from scraped actions (portfolio ${portfolioId})...`);

  for (const action of actions) {
    const result =
      action.action === "BUY"
        ? await placeBuyOrder(portfolioId, action.symbol, action.shares, action.price)
        : await placeSellOrder(portfolioId, action.symbol, action.shares, action.price);

    if (result.success) {
      summary.successful.push(result);
      console.log(
        `✓ ${action.action} order placed: ${action.symbol} - ${action.shares} shares @ $${action.price.toFixed(2)}`
      );
    } else {
      summary.failed.push(result);
      console.error(
        `✗ ${action.action} order failed: ${action.symbol} - ${result.error}`
      );
    }
  }

  console.log(
    `Trade execution complete: ${summary.successful.length} successful, ${summary.failed.length} failed, ${summary.skipped.length} skipped`
  );

  return summary;
}

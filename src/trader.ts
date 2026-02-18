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
const ACCOUNT_NUMBER = process.env.SCHWAB_ACCOUNT_NUMBER;
const ORDER_TYPE = (process.env.SCHWAB_ORDER_TYPE || "MARKET") as "MARKET" | "LIMIT";

let schwabClient: SchwabApiClient | null = null;

interface Position {
  symbol: string;
  longQuantity: number;
  shortQuantity: number;
}

async function initializeSchwabClient(): Promise<SchwabApiClient> {
  if (schwabClient) {
    return schwabClient;
  }

  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  const redirectUri = process.env.SCHWAB_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, and SCHWAB_REDIRECT_URI environment variables are required"
    );
  }

  if (!ACCOUNT_NUMBER) {
    throw new Error("SCHWAB_ACCOUNT_NUMBER environment variable is required");
  }

  const schwabApi = await getSchwabApiModule();
  const { createSchwabAuth, createApiClient } = schwabApi;

  const auth = createSchwabAuth({
    oauthConfig: {
      clientId,
      clientSecret,
      redirectUri,
      load: async (): Promise<TokenData | null> => {
        const accessToken = process.env.SCHWAB_ACCESS_TOKEN;
        const refreshToken = process.env.SCHWAB_REFRESH_TOKEN;
        if (accessToken && refreshToken) {
          return {
            accessToken,
            refreshToken,
          };
        }
        return null;
      },
      save: async (tokens: TokenData): Promise<void> => {
        process.env.SCHWAB_ACCESS_TOKEN = tokens.accessToken;
        if (tokens.refreshToken) {
          process.env.SCHWAB_REFRESH_TOKEN = tokens.refreshToken;
        }
      },
    },
  });

  schwabClient = createApiClient({
    auth,
    middleware: {
      rateLimit: { maxRequests: 120, windowMs: 60_000 },
      retry: { maxAttempts: 3, baseDelayMs: 1000 },
    },
  });

  return schwabClient;
}

async function refreshTokensIfNeeded() {
  const refreshToken = process.env.SCHWAB_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("SCHWAB_REFRESH_TOKEN is required for token refresh");
  }

  const schwabApi = await getSchwabApiModule();
  const { createSchwabAuth } = schwabApi;

  const auth = createSchwabAuth({
    oauthConfig: {
      clientId: process.env.SCHWAB_CLIENT_ID!,
      clientSecret: process.env.SCHWAB_CLIENT_SECRET!,
      redirectUri: process.env.SCHWAB_REDIRECT_URI!,
      load: async (): Promise<TokenData | null> => {
        const accessToken = process.env.SCHWAB_ACCESS_TOKEN;
        if (accessToken && refreshToken) {
          return {
            accessToken,
            refreshToken,
          };
        }
        return null;
      },
      save: async (tokens: TokenData): Promise<void> => {
        process.env.SCHWAB_ACCESS_TOKEN = tokens.accessToken;
        if (tokens.refreshToken) {
          process.env.SCHWAB_REFRESH_TOKEN = tokens.refreshToken;
        }
      },
    },
  });

  try {
    const newTokens = await auth.refresh(refreshToken);
    console.log("Tokens refreshed successfully");
    if (newTokens.refreshToken) {
      process.env.SCHWAB_ACCESS_TOKEN = newTokens.accessToken;
      process.env.SCHWAB_REFRESH_TOKEN = newTokens.refreshToken;
    }
    return newTokens;
  } catch (error: any) {
    if (isSchwabAuthError(error) && error.code === "TOKEN_EXPIRED") {
      throw new Error(
        "Refresh token expired. Please re-authenticate through Schwab's OAuth flow."
      );
    }
    throw error;
  }
}

async function getCurrentPositions(): Promise<Map<string, Position>> {
  const schwab = await initializeSchwabClient();
  const positionsMap = new Map<string, Position>();

  try {
    const account = await schwab.trader.accounts.getAccountByNumber({
      pathParams: { accountNumber: ACCOUNT_NUMBER! },
      queryParams: { fields: "positions" },
    });

    if (account.securitiesAccount?.positions && Array.isArray(account.securitiesAccount.positions)) {
      for (const position of account.securitiesAccount.positions) {
        if (position.instrument?.symbol) {
          const longQuantity = (position as any).longQuantity || 0;
          const shortQuantity = position.shortQuantity || 0;
          positionsMap.set(position.instrument.symbol, {
            symbol: position.instrument.symbol,
            longQuantity,
            shortQuantity,
          });
        }
      }
    }
  } catch (error: any) {
    if (isSchwabAuthError(error)) {
      if (error.code === "TOKEN_EXPIRED") {
        await refreshTokensIfNeeded();
        return getCurrentPositions();
      }
    }
    console.error("Error fetching positions:", error);
    throw error;
  }

  return positionsMap;
}

async function placeBuyOrder(
  symbol: string,
  shares: number,
  price: number
): Promise<TradeExecutionResult> {
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

  const schwab = await initializeSchwabClient();

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

    const response = await schwab.trader.orders.placeOrderForAccount({
      pathParams: { accountNumber: ACCOUNT_NUMBER! },
      body: orderBody as any,
    });

    return {
      symbol,
      action: "BUY",
      shares,
      price,
      success: true,
      orderId: response.orderId?.toString(),
    };
  } catch (error: any) {
    if (isSchwabAuthError(error)) {
      if (error.code === "TOKEN_EXPIRED") {
        await refreshTokensIfNeeded();
        return placeBuyOrder(symbol, shares, price);
      }
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
  symbol: string,
  shares: number,
  price: number
): Promise<TradeExecutionResult> {
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

  const schwab = await initializeSchwabClient();

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

    const response = await schwab.trader.orders.placeOrderForAccount({
      pathParams: { accountNumber: ACCOUNT_NUMBER! },
      body: orderBody as any,
    });

    return {
      symbol,
      action: "SELL",
      shares,
      price,
      success: true,
      orderId: response.orderId?.toString(),
    };
  } catch (error: any) {
    if (isSchwabAuthError(error)) {
      if (error.code === "TOKEN_EXPIRED") {
        await refreshTokensIfNeeded();
        return placeSellOrder(symbol, shares, price);
      }
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
  signals: ProcessedSignals
): Promise<TradeExecutionSummary> {
  const summary: TradeExecutionSummary = {
    successful: [],
    failed: [],
    skipped: [],
  };

  if (!ENABLE_TRADING) {
    console.log("Trading is disabled. Set SCHWAB_ENABLE_TRADING=true to enable.");
    return summary;
  }

  console.log("Executing trades for signals...");

  let positions: Map<string, Position>;
  try {
    positions = await getCurrentPositions();
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
  actions: PortfolioAction[]
): Promise<TradeExecutionSummary> {
  const summary: TradeExecutionSummary = {
    successful: [],
    failed: [],
    skipped: [],
  };

  if (!ENABLE_TRADING) {
    console.log("Trading is disabled. Set SCHWAB_ENABLE_TRADING=true to enable.");
    return summary;
  }

  if (actions.length === 0) {
    console.log("No actions to execute");
    return summary;
  }

  console.log(`Executing ${actions.length} trades from scraped actions...`);

  for (const action of actions) {
    const result =
      action.action === "BUY"
        ? await placeBuyOrder(action.symbol, action.shares, action.price)
        : await placeSellOrder(action.symbol, action.shares, action.price);

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

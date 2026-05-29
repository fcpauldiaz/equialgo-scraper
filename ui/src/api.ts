export interface AuthStatus {
  authEnabled: boolean;
  authenticated: boolean;
}

export async function fetchAuthStatus(token: string | null): Promise<AuthStatus> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const r = await fetch("/api/auth/status", { headers });
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

export async function login(password: string): Promise<{ token: string }> {
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok) throw new Error(data.error || r.statusText);
  return { token: data.token! };
}

export async function logout(token: string): Promise<void> {
  await fetch("/api/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

let _authToken: string | null = localStorage.getItem("equialgo_token");

export function getAuthToken(): string | null {
  return _authToken;
}

export function setAuthToken(token: string | null): void {
  _authToken = token;
  if (token) {
    localStorage.setItem("equialgo_token", token);
  } else {
    localStorage.removeItem("equialgo_token");
  }
}

export function authHeaders(): Record<string, string> {
  return _authToken ? { Authorization: `Bearer ${_authToken}` } : {};
}

export type PortfolioBrokerage = "schwab" | "tradier" | null;

export interface PortfolioStrategyRun {
  slug: string;
  lastProcessedDate: string | null;
  lastProcessedTimestamp: number | null;
}

export interface PortfolioItem {
  id: number;
  name: string;
  hasCredentials: boolean;
  brokerage: PortfolioBrokerage;
  /** Present when linked via Tradier: last 4 characters of account id */
  tradierAccountLast4: string | null;
  /** Full Tradier account id when linked (for picker); null if not tradier */
  tradierAccountNumber: string | null;
  systemtraderSlugs: string[];
  strategyRuns: PortfolioStrategyRun[];
}

export interface TradierAccountChoice {
  accountNumber: string;
  status?: string;
  classification?: string;
  type?: string;
}

export async function fetchPortfolios(): Promise<PortfolioItem[]> {
  const r = await fetch("/api/portfolios");
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

export async function createPortfolio(name: string): Promise<{ id: number }> {
  const r = await fetch("/api/portfolios", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || r.statusText);
  }
  return r.json();
}

export async function startSchwabLogin(portfolioId: number): Promise<{ authUrl: string }> {
  const r = await fetch("/api/schwab/start-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ portfolioId }),
  });
  if (r.status === 409) {
    throw new Error("A Schwab login is already in progress. Complete or cancel it first.");
  }
  if (!r.ok) {
    const text = await r.text();
    throw new Error(text || r.statusText);
  }
  return r.json();
}

export async function fetchTradierPreviewAccounts(
  apiKey: string,
  sandbox: boolean
): Promise<{ accounts: TradierAccountChoice[] }> {
  const r = await fetch("/api/tradier/preview-accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ apiKey, sandbox }),
  });
  const data = (await r.json().catch(() => ({}))) as {
    accounts?: TradierAccountChoice[];
    error?: string;
  };
  if (!r.ok) {
    throw new Error(data.error || r.statusText);
  }
  return { accounts: data.accounts ?? [] };
}

export async function fetchTradierAccountsForPortfolio(
  portfolioId: number
): Promise<{ accounts: TradierAccountChoice[] }> {
  const r = await fetch(`/api/portfolios/${portfolioId}/tradier-accounts`);
  const data = (await r.json().catch(() => ({}))) as {
    accounts?: TradierAccountChoice[];
    error?: string;
  };
  if (!r.ok) {
    throw new Error(data.error || r.statusText);
  }
  return { accounts: data.accounts ?? [] };
}

export async function updateTradierPortfolioAccount(
  portfolioId: number,
  accountId: string
): Promise<{ ok: boolean }> {
  const r = await fetch(`/api/portfolios/${portfolioId}/tradier-account`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ accountId }),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) {
    throw new Error(data.error || r.statusText);
  }
  return { ok: true };
}

export async function connectTradier(
  portfolioId: number,
  apiKey: string,
  sandbox?: boolean,
  accountId?: string
): Promise<{ ok: boolean }> {
  const trimmed = accountId?.trim();
  const body: Record<string, unknown> = {
    portfolioId,
    apiKey,
    sandbox: Boolean(sandbox),
  };
  if (trimmed) {
    body.accountId = trimmed;
  }
  const r = await fetch("/api/tradier/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!r.ok) {
    throw new Error(data.error || r.statusText);
  }
  return { ok: data.ok ?? true };
}

export interface VerifyResult {
  ok: boolean;
  message: string;
  positionsCount?: number;
}

export async function verifyPortfolio(portfolioId: number): Promise<VerifyResult> {
  const r = await fetch(`/api/portfolios/${portfolioId}/verify`);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

export type RunPortfolioDailyCheckResult = {
  ok: boolean;
  skipped?: "weekend";
  message?: string;
};

export async function runPortfolioDailyCheck(
  portfolioId: number
): Promise<RunPortfolioDailyCheckResult> {
  const r = await fetch(`/api/portfolios/${portfolioId}/run-daily-check`, {
    method: "POST",
    headers: authHeaders(),
  });
  const data = (await r.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    skipped?: string;
    message?: string;
  };
  if (!r.ok) {
    throw new Error(data.error || r.statusText);
  }
  return {
    ok: data.ok ?? true,
    skipped: data.skipped === "weekend" ? "weekend" : undefined,
    message: typeof data.message === "string" ? data.message : undefined,
  };
}

export interface Statistics {
  lastProcessedDate: string | null;
  lastProcessedTimestamp: number | null;
  portfolioCount: number;
  connectedCount: number;
  portfolioUrlEnvOverride: boolean;
}

export const SYSTEMTRADER_STRATEGY_SLUGS = [
  "gemini",
  "scorpio",
  "vega",
  "mars",
  "jupiter",
  "mercury",
  "saturn",
  "taurus",
] as const;

export async function fetchStatistics(): Promise<Statistics> {
  const r = await fetch("/api/statistics");
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

export async function updatePortfolioSystemTraderStrategies(
  portfolioId: number,
  slugs: string[]
): Promise<{ ok: boolean }> {
  const r = await fetch(`/api/portfolios/${portfolioId}/systemtrader-strategy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ slugs }),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) {
    throw new Error(data.error || r.statusText);
  }
  return { ok: true };
}

export interface MonthlyPerformance {
  month: string;
  realizedPnL: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalBought: number;
  totalSold: number;
}

export interface ClosedTrade {
  symbol: string;
  portfolioId: number;
  buyPrice: number;
  sellPrice: number;
  shares: number;
  pnl: number;
  pnlPercent: number;
  closedAt: number;
}

export interface PerformanceData {
  monthly: MonthlyPerformance[];
  closedTrades: ClosedTrade[];
}

export async function fetchPerformance(
  portfolioId?: number
): Promise<PerformanceData> {
  const params = portfolioId != null ? `?portfolioId=${portfolioId}` : "";
  const r = await fetch(`/api/performance${params}`);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

export interface PortfolioPosition {
  symbol: string;
  longQuantity: number;
  currentDayProfitLoss?: number;
  currentDayProfitLossPercentage?: number;
  longOpenProfitLoss?: number;
  marketValue?: number;
}

export async function fetchPortfolioPositions(
  portfolioId: number
): Promise<PortfolioPosition[]> {
  const r = await fetch(`/api/portfolios/${portfolioId}/positions`);
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || r.statusText);
  }
  return r.json();
}

export interface PortfolioItem {
  id: number;
  name: string;
  hasCredentials: boolean;
}

export async function fetchPortfolios(): Promise<PortfolioItem[]> {
  const r = await fetch("/api/portfolios");
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

export async function createPortfolio(name: string): Promise<{ id: number }> {
  const r = await fetch("/api/portfolios", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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

export interface Statistics {
  lastProcessedDate: string | null;
  lastProcessedTimestamp: number | null;
  portfolioCount: number;
  connectedCount: number;
}

export async function fetchStatistics(): Promise<Statistics> {
  const r = await fetch("/api/statistics");
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

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

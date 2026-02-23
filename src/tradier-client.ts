const TRADIER_ENABLE_TRADING = process.env.TRADIER_ENABLE_TRADING === "true";
const TRADIER_ORDER_TYPE = (process.env.TRADIER_ORDER_TYPE || "market") as "market" | "limit";

function getBaseUrl(sandbox: boolean): string {
  return sandbox ? "https://sandbox.tradier.com" : "https://api.tradier.com";
}

function tradierFetch(
  apiKey: string,
  sandbox: boolean,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const base = getBaseUrl(sandbox);
  const url = path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  return fetch(url, { ...options, headers: { ...headers, ...options.headers } });
}

interface TradierProfileAccount {
  account_number?: string;
  status?: string;
}

interface TradierProfileResponse {
  profile?: {
    accounts?: TradierProfileAccount[];
  };
}

export async function getTradierAccountId(
  apiKey: string,
  sandbox: boolean
): Promise<string> {
  const res = await tradierFetch(apiKey, sandbox, "/v1/user/profile");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tradier profile failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as TradierProfileResponse;
  const accounts = data.profile?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("Tradier profile returned no accounts");
  }
  const active = accounts.find(
    (a) => (a.status ?? "").toLowerCase() !== "closed"
  );
  const account = active ?? accounts[0];
  const accountNumber = account?.account_number?.trim();
  if (!accountNumber) {
    throw new Error("Tradier profile did not include account_number");
  }
  return accountNumber;
}

interface TradierPositionItem {
  symbol?: string;
  quantity?: number;
}

interface TradierPositionsResponse {
  positions?: null | { position?: TradierPositionItem | TradierPositionItem[] };
}

export interface TradierPosition {
  symbol: string;
  longQuantity: number;
}

export async function getTradierPositions(
  apiKey: string,
  accountId: string,
  sandbox: boolean
): Promise<TradierPosition[]> {
  const res = await tradierFetch(
    apiKey,
    sandbox,
    `/v1/accounts/${encodeURIComponent(accountId)}/positions`
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tradier positions failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as TradierPositionsResponse;
  const pos = data.positions?.position;
  if (pos == null) {
    return [];
  }
  const list = Array.isArray(pos) ? pos : [pos];
  const out: TradierPosition[] = [];
  for (const p of list) {
    const symbol = p?.symbol?.trim();
    const qty = Number(p?.quantity);
    if (symbol && !Number.isNaN(qty) && qty > 0) {
      out.push({ symbol, longQuantity: Math.floor(qty) });
    }
  }
  return out;
}

interface TradierOrderResponse {
  order?: { id?: number; status?: string };
}

export async function placeTradierOrder(
  apiKey: string,
  accountId: string,
  sandbox: boolean,
  side: "buy" | "sell",
  symbol: string,
  quantity: number,
  price?: number,
  orderType?: "market" | "limit"
): Promise<{ orderId?: string }> {
  if (!TRADIER_ENABLE_TRADING) {
    throw new Error("Trading is disabled (TRADIER_ENABLE_TRADING=false)");
  }
  const type = orderType ?? TRADIER_ORDER_TYPE;
  const body = new URLSearchParams({
    class: "equity",
    symbol: symbol.trim(),
    side,
    quantity: String(Math.floor(quantity)),
    type,
    duration: "day",
  });
  if (type === "limit" && price != null && !Number.isNaN(price)) {
    body.set("price", String(price.toFixed(2)));
  }
  const res = await tradierFetch(
    apiKey,
    sandbox,
    `/v1/accounts/${encodeURIComponent(accountId)}/orders`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tradier place order failed: ${res.status} ${text}`);
  }
  const data = (JSON.parse(text || "{}") as TradierOrderResponse);
  const id = data.order?.id;
  return { orderId: id != null ? String(id) : undefined };
}

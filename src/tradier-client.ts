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
    /** Plural — used by some clients; official docs use `account` */
    accounts?: TradierProfileAccount[] | TradierProfileAccount;
    /** Singular — Tradier Brokerage API returns `profile.account` (array or single object when one account) */
    account?: TradierProfileAccount[] | TradierProfileAccount;
  };
}

function normalizeProfileAccounts(
  data: TradierProfileResponse
): TradierProfileAccount[] {
  const raw =
    data.profile?.account ?? data.profile?.accounts;
  if (raw == null) {
    return [];
  }
  return Array.isArray(raw) ? raw : [raw];
}

const TRADIER_LOG_BODY_MAX = 6000;

function logTradierProfileFailure(
  reason: string,
  sandbox: boolean,
  text: string,
  parsed?: TradierProfileResponse
): void {
  const base = getBaseUrl(sandbox);
  console.error(`[Tradier] ${reason} (sandbox=${sandbox}, base=${base})`);
  if (parsed !== undefined) {
    const profile = parsed.profile;
    console.error(
      "[Tradier] profile object keys:",
      profile ? Object.keys(profile) : "(missing)"
    );
    console.error("[Tradier] response top-level keys:", Object.keys(parsed as object));
  }
  const snippet =
    text.length > TRADIER_LOG_BODY_MAX
      ? `${text.slice(0, TRADIER_LOG_BODY_MAX)}…`
      : text;
  console.error("[Tradier] raw response body:", snippet);
}

export async function getTradierAccountId(
  apiKey: string,
  sandbox: boolean
): Promise<string> {
  const base = getBaseUrl(sandbox);
  console.log(`[Tradier] GET ${base}/v1/user/profile (sandbox=${sandbox})`);

  const res = await tradierFetch(apiKey, sandbox, "/v1/user/profile");
  const text = await res.text();

  if (!res.ok) {
    console.error(
      `[Tradier] profile HTTP ${res.status}:`,
      text.length > 1200 ? `${text.slice(0, 1200)}…` : text
    );
    throw new Error(`Tradier profile failed: ${res.status} ${text.slice(0, 300)}`);
  }

  let data: TradierProfileResponse;
  try {
    data = JSON.parse(text) as TradierProfileResponse;
  } catch {
    logTradierProfileFailure("profile response is not valid JSON", sandbox, text);
    throw new Error("Tradier profile response was not valid JSON");
  }

  const accounts = normalizeProfileAccounts(data);
  if (accounts.length === 0) {
    logTradierProfileFailure(
      "profile returned no accounts (empty after parse)",
      sandbox,
      text,
      data
    );
    throw new Error("Tradier profile returned no accounts");
  }
  const active = accounts.find(
    (a) => (a.status ?? "").toLowerCase() !== "closed"
  );
  const account = active ?? accounts[0];
  const accountNumber = account?.account_number?.trim();
  if (!accountNumber) {
    console.error(
      "[Tradier] account entries without account_number:",
      JSON.stringify(accounts).slice(0, 1000)
    );
    logTradierProfileFailure(
      "profile did not include account_number",
      sandbox,
      text,
      data
    );
    throw new Error("Tradier profile did not include account_number");
  }
  console.log(
    `[Tradier] resolved account (sandbox=${sandbox}) ending …${accountNumber.slice(-4)}`
  );
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

export interface BrokerOrderFill {
  avgFillPrice: number;
  filledShares: number;
}

export interface BrokerTradeTransaction {
  executedAt: number;
  symbol: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
}

export function parseSchwabOrderFill(order: unknown): BrokerOrderFill | null {
  const o = order as {
    status?: string;
    filledQuantity?: number;
    orderActivityCollection?: Array<{
      activityType?: string;
      executionType?: string;
      executionLegs?: Array<{ price?: number; quantity?: number }>;
    }>;
  };

  let totalQty = 0;
  let totalNotional = 0;
  for (const activity of o.orderActivityCollection ?? []) {
    const isExecution =
      activity.activityType === "EXECUTION" || activity.executionType === "FILL";
    if (!isExecution) continue;
    for (const leg of activity.executionLegs ?? []) {
      const qty = Math.abs(Number(leg.quantity) || 0);
      const price = Number(leg.price) || 0;
      if (qty > 0 && price > 0) {
        totalQty += qty;
        totalNotional += qty * price;
      }
    }
  }

  if (totalQty > 0) {
    return {
      avgFillPrice: totalNotional / totalQty,
      filledShares: Math.floor(totalQty),
    };
  }

  return null;
}

export function parseSchwabTradeTransactions(
  payload: unknown
): BrokerTradeTransaction[] {
  const rows = Array.isArray(payload) ? payload : [];
  const trades: BrokerTradeTransaction[] = [];

  for (const row of rows) {
    const tx = row as {
      type?: string;
      tradeDate?: string;
      transactionDate?: string;
      transferItems?: Array<{
        instrument?: { symbol?: string; assetType?: string };
        amount?: number;
        price?: number;
        quantity?: number;
        positionEffect?: string;
      }>;
    };
    if (tx.type !== "TRADE") continue;

    const dateStr = tx.tradeDate ?? tx.transactionDate;
    const executedAt = dateStr ? Date.parse(dateStr) : NaN;
    if (!Number.isFinite(executedAt)) continue;

    for (const item of tx.transferItems ?? []) {
      if (item.instrument?.assetType !== "EQUITY") continue;
      const symbol = item.instrument.symbol?.trim().toUpperCase();
      if (!symbol) continue;

      const rawQty = Number(
        item.quantity !== undefined ? item.quantity : item.amount
      );
      if (!Number.isFinite(rawQty) || rawQty === 0) continue;

      const shares = Math.abs(Math.floor(rawQty));
      const price = Number(item.price);
      if (!Number.isFinite(price) || price <= 0 || shares <= 0) continue;

      const action: "BUY" | "SELL" = rawQty > 0 ? "BUY" : "SELL";
      trades.push({ executedAt, symbol, action, shares, price });
    }
  }

  return trades.sort((a, b) => a.executedAt - b.executedAt);
}

type TradierHistoryEvent = {
  type?: string;
  date?: string;
  price?: number;
  quantity?: number;
  symbol?: string;
  trade_type?: string;
  amount?: number;
  trade?: {
    price?: number;
    quantity?: number;
    symbol?: string;
    trade_type?: string;
  };
};

function flattenTradierHistoryEvent(event: TradierHistoryEvent): {
  type?: string;
  date?: string;
  price?: number;
  quantity?: number;
  symbol?: string;
  trade_type?: string;
  amount?: number;
} {
  const trade = event.trade;
  return {
    type: event.type,
    date: event.date,
    amount: event.amount,
    price: trade?.price ?? event.price,
    quantity: trade?.quantity ?? event.quantity,
    symbol: trade?.symbol ?? event.symbol,
    trade_type: trade?.trade_type ?? event.trade_type,
  };
}

function normalizeTradierHistoryEvents(payload: unknown): TradierHistoryEvent[] {
  const root = payload as {
    history?: { event?: TradierHistoryEvent | TradierHistoryEvent[] };
  };
  const event = root.history?.event;
  if (!event) return [];
  return Array.isArray(event) ? event : [event];
}

export function parseTradierTradeHistory(payload: unknown): BrokerTradeTransaction[] {
  const trades: BrokerTradeTransaction[] = [];

  for (const rawEvent of normalizeTradierHistoryEvents(payload)) {
    const event = flattenTradierHistoryEvent(rawEvent);
    if (event.type?.toLowerCase() !== "trade") continue;
    if (event.trade_type && event.trade_type.toLowerCase() !== "equity") continue;

    const symbol = event.symbol?.trim().toUpperCase();
    if (!symbol) continue;

    const executedAt = event.date ? Date.parse(event.date) : NaN;
    if (!Number.isFinite(executedAt)) continue;

    const rawQty = Number(event.quantity);
    if (!Number.isFinite(rawQty) || rawQty === 0) continue;

    const shares = Math.abs(Math.floor(rawQty));
    let price = Number(event.price);
    if (!Number.isFinite(price) || price <= 0) {
      const amount = Math.abs(Number(event.amount) || 0);
      price = shares > 0 ? amount / shares : 0;
    }
    if (!Number.isFinite(price) || price <= 0 || shares <= 0) continue;

    const action: "BUY" | "SELL" = rawQty > 0 ? "BUY" : "SELL";
    trades.push({ executedAt, symbol, action, shares, price });
  }

  return trades.sort((a, b) => a.executedAt - b.executedAt);
}

export function matchExecutionsToTransactions(
  rows: Array<{
    id: number;
    symbol: string;
    action: "BUY" | "SELL";
    shares: number;
    price: number;
    executedAt: number;
  }>,
  transactions: BrokerTradeTransaction[],
  sameCalendarDay: (aMs: number, bMs: number) => boolean
): Array<{ rowId: number; tx: BrokerTradeTransaction }> {
  const usedTx = new Set<number>();
  const matches: Array<{ rowId: number; tx: BrokerTradeTransaction }> = [];

  for (const row of rows) {
    const matchIndex = transactions.findIndex((tx, idx) => {
      if (usedTx.has(idx)) return false;
      if (tx.symbol !== row.symbol) return false;
      if (tx.action !== row.action) return false;
      if (tx.shares !== row.shares) return false;
      return sameCalendarDay(tx.executedAt, row.executedAt);
    });

    if (matchIndex === -1) continue;
    usedTx.add(matchIndex);
    matches.push({ rowId: row.id, tx: transactions[matchIndex] });
  }

  return matches;
}

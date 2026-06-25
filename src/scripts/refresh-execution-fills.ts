import "dotenv/config";
import {
  initializeDatabase,
  listTradeExecutionsForFillRefresh,
  updateTradeExecutionFill,
  getPortfolioBrokerage,
} from "../state";
import { fetchBrokerOrderFill, fetchBrokerTradeTransactions } from "../trader";
import { matchExecutionsToTransactions } from "../broker-fills";

const DAY_MS = 86400000;

function parseArgs(argv: string[]): { portfolioId?: number } {
  const filtered = argv[0] === "--" ? argv.slice(1) : argv;
  let portfolioId: number | undefined;
  for (let i = 0; i < filtered.length; i++) {
    if (filtered[i] === "--portfolio") {
      portfolioId = parseInt(filtered[i + 1], 10);
      i++;
    }
  }
  return { portfolioId };
}

function sameCalendarDay(aMs: number, bMs: number): boolean {
  return new Date(aMs).toDateString() === new Date(bMs).toDateString();
}

async function refreshFromOrderIds(portfolioId?: number): Promise<number> {
  const rows = await listTradeExecutionsForFillRefresh(portfolioId);
  let updated = 0;

  for (const row of rows) {
    if (!row.orderId) continue;
    const fill = await fetchBrokerOrderFill(row.portfolioId, row.orderId);
    if (!fill || fill.avgFillPrice <= 0) continue;

    const shares =
      fill.filledShares > 0 ? fill.filledShares : row.shares;
    const priceChanged = Math.abs(row.price - fill.avgFillPrice) > 0.0001;
    const sharesChanged = shares !== row.shares;
    if (!priceChanged && !sharesChanged) continue;

    await updateTradeExecutionFill(row.id, fill.avgFillPrice, shares);
    console.log(
      `Updated #${row.id} ${row.symbol} ${row.action}: ` +
        `${row.shares}@${row.price.toFixed(4)} → ${shares}@${fill.avgFillPrice.toFixed(4)}`
    );
    updated++;
  }

  return updated;
}

async function refreshFromTransactions(portfolioId: number): Promise<number> {
  const brokerage = await getPortfolioBrokerage(portfolioId);
  if (!brokerage) return 0;

  const rows = (await listTradeExecutionsForFillRefresh(portfolioId)).filter(
    (r) => !r.orderId
  );
  if (rows.length === 0) return 0;

  const minTs = Math.min(...rows.map((r) => r.executedAt));
  const maxTs = Math.max(...rows.map((r) => r.executedAt));
  const startDate = new Date(minTs - 3 * DAY_MS).toISOString().slice(0, 10);
  const endDate = new Date(maxTs + DAY_MS).toISOString().slice(0, 10);

  const transactions = await fetchBrokerTradeTransactions(
    portfolioId,
    startDate,
    endDate
  );
  if (transactions.length === 0) {
    console.warn(
      `No ${brokerage} trade transactions found for portfolio ${portfolioId}`
    );
    return 0;
  }

  const matches = matchExecutionsToTransactions(
    rows,
    transactions,
    sameCalendarDay
  );
  let updated = 0;

  for (const { rowId, tx } of matches) {
    const row = rows.find((r) => r.id === rowId);
    if (!row || Math.abs(row.price - tx.price) < 0.0001) continue;

    await updateTradeExecutionFill(row.id, tx.price, tx.shares);
    console.log(
      `Matched #${row.id} ${row.symbol} ${row.action} from ${brokerage} transactions: ` +
        `${row.shares}@${row.price.toFixed(4)} → ${tx.shares}@${tx.price.toFixed(4)}`
    );
    updated++;
  }

  return updated;
}

async function main(): Promise<void> {
  const { portfolioId } = parseArgs(process.argv.slice(2));
  await initializeDatabase();

  const fromOrders = await refreshFromOrderIds(portfolioId);
  console.log(`Updated ${fromOrders} execution(s) from broker order fills`);

  if (portfolioId != null) {
    const fromTx = await refreshFromTransactions(portfolioId);
    const brokerage = await getPortfolioBrokerage(portfolioId);
    console.log(
      `Updated ${fromTx} execution(s) from ${brokerage ?? "broker"} transaction history`
    );
  } else {
    console.log(
      "Pass --portfolio <id> to also match broker transactions for rows without order_id"
    );
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

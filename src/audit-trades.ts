import { scaleActionsToPortfolioSize } from "./processor";
import { DAILY_CHECK_TIMEZONE } from "./run-check";
import { scrapePortfolioData } from "./scraper";
import {
  readTradeExecutionsForAudit,
  resolveEffectiveSystemTraderPortfolioUrl,
  type TradeExecutionAuditRow,
} from "./state";
import { scrapeStrategyTrades } from "./trades-scraper";
import type {
  AuditDaySummary,
  AuditDiscrepancy,
  AuditReport,
  PortfolioAction,
  ScrapedPortfolioData,
  StrategyTrade,
} from "./types";

const DEFAULT_PORTFOLIO_SIZE = parseInt(process.env.PORTFOLIO_SIZE || "10000", 10);

export interface AuditOptions {
  portfolioSize?: number;
  toleranceShares?: number;
  timezone?: string;
  /** Strategy signal date → brokerage execution date offset (SystemTrader T+1 default). */
  executionLagDays?: number;
}

type TradeKey = `${string}:${"BUY" | "SELL"}`;

interface ExpectedExecution {
  shares: number;
  directionOnly: boolean;
}

function tradeKey(symbol: string, action: "BUY" | "SELL"): TradeKey {
  return `${symbol}:${action}`;
}

function parseIsoDate(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Invalid ${label} date "${value}" (expected YYYY-MM-DD)`);
  }
  return trimmed;
}

function compareIsoDates(a: string, b: string): number {
  return a.localeCompare(b);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function listDatesInclusive(from: string, to: string): string[] {
  const dates: string[] = [];
  let current = from;
  while (compareIsoDates(current, to) <= 0) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

export function calendarDateInTimezone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function startOfDayMs(isoDate: string, timeZone: string): number {
  const probe = new Date(`${isoDate}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
    minute: "numeric",
    second: "numeric",
  }).formatToParts(probe);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const second = Number(parts.find((p) => p.type === "second")?.value ?? 0);
  const offsetFromNoonMs = ((hour - 12) * 3600 + minute * 60 + second) * 1000;
  return probe.getTime() - offsetFromNoonMs;
}

function endOfDayMs(isoDate: string, timeZone: string): number {
  return startOfDayMs(addDays(isoDate, 1), timeZone);
}

function isSyntheticBackfill(row: TradeExecutionAuditRow): boolean {
  const ageMs = Date.now() - row.executedAt;
  const minBackfillAgeMs = 80 * 86400000;
  return (
    row.success &&
    row.action === "BUY" &&
    row.orderId == null &&
    row.error == null &&
    ageMs >= minBackfillAgeMs
  );
}

export function strategyTradesToDailyActions(
  trades: StrategyTrade[],
  date: string
): PortfolioAction[] {
  return trades
    .filter((t) => t.date === date)
    .map((t) => ({
      symbol: t.symbol,
      action: t.action,
      shares: t.shares,
      price: t.price,
      buyKind: t.buyKind,
      sellKind: t.sellKind,
    }));
}

export function expectedExecutionsForDate(
  actions: PortfolioAction[],
  portfolioSize: number
): Map<TradeKey, ExpectedExecution> {
  const scaled = scaleActionsToPortfolioSize(actions, portfolioSize);
  const aggregated = new Map<TradeKey, ExpectedExecution>();

  for (const action of scaled) {
    const key = tradeKey(action.symbol, action.action);
    const directionOnly = action.action === "SELL" && action.sellKind === "exit";
    const existing = aggregated.get(key);
    if (directionOnly) {
      aggregated.set(key, { shares: 0, directionOnly: true });
      continue;
    }
    const addShares = action.shares;
    if (existing) {
      aggregated.set(key, {
        shares: existing.shares + addShares,
        directionOnly: false,
      });
    } else {
      aggregated.set(key, { shares: addShares, directionOnly: false });
    }
  }
  return aggregated;
}

export function aggregateExecutionsByKey(
  rows: TradeExecutionAuditRow[]
): {
  successful: Map<TradeKey, number>;
  failed: Map<TradeKey, number>;
} {
  const successful = new Map<TradeKey, number>();
  const failed = new Map<TradeKey, number>();

  for (const row of rows) {
    if (isSyntheticBackfill(row)) continue;
    const key = tradeKey(row.symbol, row.action);
    if (row.success) {
      successful.set(key, (successful.get(key) ?? 0) + row.shares);
    } else {
      failed.set(key, (failed.get(key) ?? 0) + row.shares);
    }
  }

  return { successful, failed };
}

export function groupExecutionsByDate(
  rows: TradeExecutionAuditRow[],
  timeZone: string
): Map<string, TradeExecutionAuditRow[]> {
  const byDate = new Map<string, TradeExecutionAuditRow[]>();
  for (const row of rows) {
    const date = calendarDateInTimezone(row.executedAt, timeZone);
    const bucket = byDate.get(date) ?? [];
    bucket.push(row);
    byDate.set(date, bucket);
  }
  return byDate;
}

export function compareDaily(
  date: string,
  expected: Map<TradeKey, ExpectedExecution>,
  actualSuccessful: Map<TradeKey, number>,
  actualFailed: Map<TradeKey, number>,
  toleranceShares: number
): { discrepancies: AuditDiscrepancy[]; summary: AuditDaySummary } {
  const discrepancies: AuditDiscrepancy[] = [];
  let matched = 0;
  let missing = 0;
  let extra = 0;
  let mismatched = 0;
  let failed = 0;

  const allKeys = new Set<TradeKey>([
    ...expected.keys(),
    ...actualSuccessful.keys(),
    ...actualFailed.keys(),
  ]);

  for (const key of allKeys) {
    const [symbol, action] = key.split(":") as [string, "BUY" | "SELL"];
    const expectedEntry = expected.get(key);
    const expectedShares = expectedEntry?.shares ?? 0;
    const directionOnly = expectedEntry?.directionOnly ?? false;
    const actualShares = actualSuccessful.get(key) ?? 0;
    const failedShares = actualFailed.get(key) ?? 0;

    if (failedShares > 0) {
      failed++;
      discrepancies.push({
        date,
        symbol,
        action,
        expectedShares: directionOnly ? 0 : expectedShares,
        actualShares,
        kind: "failed_execution",
        note: `${failedShares} share(s) failed`,
      });
    }

    if (!expectedEntry && actualShares > 0) {
      extra++;
      discrepancies.push({
        date,
        symbol,
        action,
        expectedShares: 0,
        actualShares,
        kind: "extra_execution",
      });
      continue;
    }

    if (!expectedEntry) {
      continue;
    }

    if (directionOnly) {
      if (actualShares > 0) {
        matched++;
      } else if (failedShares === 0) {
        missing++;
        discrepancies.push({
          date,
          symbol,
          action,
          expectedShares: 0,
          actualShares: 0,
          kind: "missing_execution",
          note: "Strategy exit with no successful sell",
        });
      }
      continue;
    }

    if (expectedShares > 0 && actualShares === 0 && failedShares === 0) {
      missing++;
      discrepancies.push({
        date,
        symbol,
        action,
        expectedShares,
        actualShares: 0,
        kind: "missing_execution",
        note: "Strategy trade with no successful execution",
      });
      continue;
    }

    if (expectedShares > 0 && actualShares > 0) {
      const delta = Math.abs(expectedShares - actualShares);
      if (delta <= toleranceShares) {
        matched++;
      } else {
        mismatched++;
        discrepancies.push({
          date,
          symbol,
          action,
          expectedShares,
          actualShares,
          kind: "share_mismatch",
          note: `Delta ${delta} share(s) exceeds tolerance ${toleranceShares}`,
        });
      }
    }
  }

  return {
    discrepancies,
    summary: {
      date,
      matched,
      missing,
      extra,
      mismatched,
      failed,
    },
  };
}

function emptyDaySummary(date: string): AuditDaySummary {
  return {
    date,
    matched: 0,
    missing: 0,
    extra: 0,
    mismatched: 0,
    failed: 0,
  };
}

function buildReport(
  mode: "daily" | "history",
  portfolioId: number,
  strategySlug: string,
  fromDate: string,
  toDate: string,
  days: AuditDaySummary[],
  discrepancies: AuditDiscrepancy[]
): AuditReport {
  const totals = days.reduce(
    (acc, day) => ({
      matched: acc.matched + day.matched,
      missing: acc.missing + day.missing,
      extra: acc.extra + day.extra,
      mismatched: acc.mismatched + day.mismatched,
      failed: acc.failed + day.failed,
    }),
    { matched: 0, missing: 0, extra: 0, mismatched: 0, failed: 0 }
  );

  return {
    mode,
    portfolioId,
    strategySlug,
    fromDate,
    toDate,
    days,
    discrepancies,
    ...totals,
  };
}

export async function auditDaily(
  portfolioId: number,
  strategySlug: string,
  date: string | undefined,
  options: AuditOptions = {}
): Promise<AuditReport> {
  const portfolioSize = options.portfolioSize ?? DEFAULT_PORTFOLIO_SIZE;
  const toleranceShares = options.toleranceShares ?? 0;
  const timeZone = options.timezone ?? DAILY_CHECK_TIMEZONE;
  const executionLagDays = options.executionLagDays ?? 1;

  const portfolioUrl = resolveEffectiveSystemTraderPortfolioUrl(strategySlug);
  const scraped: ScrapedPortfolioData = await scrapePortfolioData(portfolioUrl);
  const signalDate = scraped.date.trim();

  if (date && date.trim() !== signalDate) {
    console.warn(
      `[audit] daily mode uses today's scraped actions (${signalDate}); ` +
        `requested date ${date.trim()} differs — use --mode history for past dates`
    );
  }

  const expected = expectedExecutionsForDate(scraped.actions, portfolioSize);
  const executionDate = addDays(signalDate, executionLagDays);

  const fromMs = startOfDayMs(executionDate, timeZone);
  const toMs = endOfDayMs(executionDate, timeZone);
  const rows = await readTradeExecutionsForAudit(
    portfolioId,
    strategySlug,
    fromMs,
    toMs
  );
  const { successful, failed: failedMap } = aggregateExecutionsByKey(rows);
  const { discrepancies, summary } = compareDaily(
    signalDate,
    expected,
    successful,
    failedMap,
    toleranceShares
  );

  return buildReport(
    "daily",
    portfolioId,
    strategySlug,
    signalDate,
    signalDate,
    [{ ...summary, date: `${summary.date} → exec ${executionDate}` }],
    discrepancies
  );
}

export async function auditHistory(
  portfolioId: number,
  strategySlug: string,
  fromDate: string,
  toDate: string,
  options: AuditOptions = {}
): Promise<AuditReport> {
  const from = parseIsoDate(fromDate, "from");
  const to = parseIsoDate(toDate, "to");
  if (compareIsoDates(from, to) > 0) {
    throw new Error(`from date ${from} is after to date ${to}`);
  }

  const portfolioSize = options.portfolioSize ?? DEFAULT_PORTFOLIO_SIZE;
  const toleranceShares = options.toleranceShares ?? 0;
  const timeZone = options.timezone ?? DAILY_CHECK_TIMEZONE;
  const executionLagDays = options.executionLagDays ?? 1;

  const scraped = await scrapeStrategyTrades(strategySlug, { since: from });
  const dates = listDatesInclusive(from, to);

  const fromMs = startOfDayMs(from, timeZone);
  const toMs = endOfDayMs(addDays(to, executionLagDays), timeZone);
  const executionRows = await readTradeExecutionsForAudit(
    portfolioId,
    strategySlug,
    fromMs,
    toMs
  );
  const executionsByDate = groupExecutionsByDate(executionRows, timeZone);

  const days: AuditDaySummary[] = [];
  const discrepancies: AuditDiscrepancy[] = [];

  for (const signalDate of dates) {
    const dayActions = strategyTradesToDailyActions(scraped.trades, signalDate);
    const executionDate = addDays(signalDate, executionLagDays);
    const dayRows = executionsByDate.get(executionDate) ?? [];

    if (dayActions.length === 0 && dayRows.length === 0) {
      days.push(emptyDaySummary(signalDate));
      continue;
    }

    const expected = expectedExecutionsForDate(dayActions, portfolioSize);
    const { successful, failed: failedMap } = aggregateExecutionsByKey(dayRows);
    const result = compareDaily(
      `${signalDate} → exec ${executionDate}`,
      expected,
      successful,
      failedMap,
      toleranceShares
    );
    days.push({ ...result.summary, date: `${signalDate} → exec ${executionDate}` });
    discrepancies.push(...result.discrepancies);
  }

  return buildReport(
    "history",
    portfolioId,
    strategySlug,
    from,
    to,
    days,
    discrepancies
  );
}

export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(
    `Audit ${report.strategySlug} / portfolio ${report.portfolioId} / ${report.fromDate}` +
      (report.fromDate !== report.toDate ? ` → ${report.toDate}` : "")
  );
  lines.push(`Mode: ${report.mode}`);

  for (const day of report.days) {
    const hasActivity =
      day.matched + day.missing + day.extra + day.mismatched + day.failed > 0;
    if (!hasActivity) continue;
    lines.push(
      `\n${day.date}: matched=${day.matched} missing=${day.missing} extra=${day.extra} mismatched=${day.mismatched} failed=${day.failed}`
    );
    const dayDisc = report.discrepancies.filter((d) => d.date === day.date);
    for (const d of dayDisc) {
      const tag =
        d.kind === "missing_execution"
          ? "MISS"
          : d.kind === "extra_execution"
            ? "EXTRA"
            : d.kind === "failed_execution"
              ? "FAIL"
              : "WARN";
      const expectedLabel =
        d.note === "Strategy exit with no successful sell" ||
        (d.kind !== "missing_execution" && d.expectedShares === 0 && d.action === "SELL")
          ? "exit"
          : `${d.expectedShares} sh`;
      lines.push(
        `  ${tag} ${d.symbol} ${d.action} expected ${expectedLabel} → actual ${d.actualShares} sh` +
          (d.note ? ` (${d.note})` : "")
      );
    }
  }

  lines.push(
    `\nSummary: matched=${report.matched} missing=${report.missing} extra=${report.extra} mismatched=${report.mismatched} failed=${report.failed}`
  );
  return lines.join("\n");
}

export function auditReportHasFailures(report: AuditReport): boolean {
  return (
    report.missing > 0 ||
    report.extra > 0 ||
    report.mismatched > 0 ||
    report.failed > 0
  );
}

import { createClient } from "@libsql/client";
import {
  getTradierAccountId,
  isTradierAccountInProfileList,
  listTradierAccountsForKey,
} from "./tradier-client";

export const DEFAULT_SYSTEMTRADER_SLUG = "gemini";

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

export type SystemTraderStrategySlug =
  (typeof SYSTEMTRADER_STRATEGY_SLUGS)[number];

const SYSTEMTRADER_SLUG_PATTERN = /^[a-z0-9-]+$/;

const ALLOWED_SLUG_SET = new Set<string>(SYSTEMTRADER_STRATEGY_SLUGS);

export interface PortfolioStrategyRun {
  slug: string;
  lastProcessedDate: string | null;
  lastProcessedTimestamp: number | null;
}

export interface JobStatisticsSnapshot {
  lastProcessedDate: string | null;
  lastProcessedTimestamp: number | null;
  portfolioUrlEnvOverride: boolean;
}

export interface TradingPortfolioTarget {
  id: number;
  systemtraderSlug: string;
  lastProcessedDate: string | null;
  lastProcessedTimestamp: number | null;
}

export function resolveSystemTraderPortfolioUrl(slug: string): string {
  const s = slug.trim().toLowerCase();
  return `https://www.systemtrader.co/${s}/portfolio`;
}

export function isPortfolioUrlEnvOverride(): boolean {
  return Boolean(process.env.PORTFOLIO_URL?.trim());
}

export function resolveEffectiveSystemTraderPortfolioUrl(slug: string): string {
  const fromEnv = process.env.PORTFOLIO_URL?.trim();
  if (fromEnv) return fromEnv;
  return resolveSystemTraderPortfolioUrl(slug);
}

export function parseAndNormalizeSystemTraderSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!slug || !SYSTEMTRADER_SLUG_PATTERN.test(slug)) {
    throw new Error("Invalid strategy slug: use lowercase letters, digits, and hyphens only.");
  }
  return slug;
}

let client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    const authToken = process.env.DATABASE_AUTH_TOKEN;

    if (!url || !authToken) {
      throw new Error(
        "DATABASE_URL and DATABASE_AUTH_TOKEN environment variables are required"
      );
    }

    client = createClient({
      url,
      authToken,
    });
  }
  return client;
}

export interface SchwabCredentials {
  accessToken: string;
  refreshToken: string;
  redirectUri?: string;
  accountNumber?: string;
}

export interface TradierCredentials {
  apiKey: string;
  accountId?: string;
  sandbox: boolean;
}

export type PortfolioBrokerage = "schwab" | "tradier" | null;

export interface PortfolioListItem {
  id: number;
  name: string;
  hasCredentials: boolean;
  brokerage: PortfolioBrokerage;
  /** Last 4 characters of stored Tradier account id when brokerage is tradier */
  tradierAccountLast4: string | null;
  /** Full Tradier account id when linked (for account picker); null if not tradier */
  tradierAccountNumber: string | null;
  systemtraderSlugs: string[];
  strategyRuns: PortfolioStrategyRun[];
}

function lastFourOfAccountId(accountId: string | null | undefined): string | null {
  const s = accountId?.trim() ?? "";
  if (s.length === 0) return null;
  return s.slice(-4);
}

async function getStateColumnNames(db: ReturnType<typeof getClient>): Promise<Set<string>> {
  const info = await db.execute("PRAGMA table_info(state)");
  const rows = info.rows as { name?: string }[];
  return new Set(rows.map((r) => String(r.name ?? "")));
}

async function getPortfolioColumnNames(db: ReturnType<typeof getClient>): Promise<Set<string>> {
  const info = await db.execute("PRAGMA table_info(portfolios)");
  const rows = info.rows as { name?: string }[];
  return new Set(rows.map((r) => String(r.name ?? "")));
}

async function migratePortfoliosScrapeColumns(db: ReturnType<typeof getClient>): Promise<void> {
  let names = await getPortfolioColumnNames(db);
  if (!names.has("systemtrader_slug")) {
    await db.execute(
      "ALTER TABLE portfolios ADD COLUMN systemtrader_slug TEXT NOT NULL DEFAULT 'gemini'"
    );
    names = await getPortfolioColumnNames(db);
  }
  if (!names.has("last_processed_date")) {
    await db.execute("ALTER TABLE portfolios ADD COLUMN last_processed_date TEXT");
  }
  if (!names.has("last_processed_timestamp")) {
    await db.execute("ALTER TABLE portfolios ADD COLUMN last_processed_timestamp INTEGER");
  }
  if (!names.has("last_processed_systemtrader_slug")) {
    await db.execute("ALTER TABLE portfolios ADD COLUMN last_processed_systemtrader_slug TEXT");
  }
}

async function migrateStateTable(db: ReturnType<typeof getClient>): Promise<void> {
  let names = await getStateColumnNames(db);
  if (!names.has("systemtrader_slug")) {
    await db.execute(
      "ALTER TABLE state ADD COLUMN systemtrader_slug TEXT NOT NULL DEFAULT 'gemini'"
    );
    names = await getStateColumnNames(db);
  }
  if (!names.has("last_processed_systemtrader_slug")) {
    await db.execute("ALTER TABLE state ADD COLUMN last_processed_systemtrader_slug TEXT");
  }
  await db.execute(
    `UPDATE state SET last_processed_systemtrader_slug = 'gemini'
     WHERE last_processed_date IS NOT NULL AND last_processed_systemtrader_slug IS NULL`
  );
  await db.execute(
    "UPDATE state SET systemtrader_slug = 'gemini' WHERE systemtrader_slug IS NULL OR TRIM(systemtrader_slug) = ''"
  );
}

async function copyLegacyGlobalScrapeStateIntoPortfolios(
  db: ReturnType<typeof getClient>
): Promise<void> {
  const names = await getPortfolioColumnNames(db);
  if (!names.has("last_processed_timestamp")) return;

  const anyProcessed = await db.execute(
    "SELECT COUNT(*) as c FROM portfolios WHERE last_processed_timestamp IS NOT NULL"
  );
  const count = Number((anyProcessed.rows[0] as unknown as { c: number }).c) || 0;
  if (count > 0) return;

  const stateRes = await db.execute("SELECT * FROM state WHERE id = 1");
  const srow = stateRes.rows[0] as Record<string, unknown> | undefined;
  if (!srow) return;

  const lp = (srow.last_processed_date as string | null | undefined) ?? null;
  const lpts = (srow.last_processed_timestamp as number | null | undefined) ?? null;
  if (lp == null && lpts == null) return;

  const globalSlugRaw = srow.systemtrader_slug;
  const globalSlug =
    typeof globalSlugRaw === "string" && globalSlugRaw.trim() !== ""
      ? globalSlugRaw.trim().toLowerCase()
      : DEFAULT_SYSTEMTRADER_SLUG;

  const lastSlugRaw = srow.last_processed_systemtrader_slug;
  const lastSlug =
    typeof lastSlugRaw === "string" && lastSlugRaw.trim() !== ""
      ? lastSlugRaw.trim().toLowerCase()
      : globalSlug;

  await db.execute(
    `UPDATE portfolios SET
       last_processed_date = ?,
       last_processed_timestamp = ?,
       last_processed_systemtrader_slug = ?,
       systemtrader_slug = ?
     WHERE last_processed_timestamp IS NULL`,
    [lp, lpts, lastSlug, globalSlug]
  );
}

async function migratePortfolioStrategySymbolsTable(
  db: ReturnType<typeof getClient>
): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS portfolio_strategy_symbols (
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      symbol TEXT NOT NULL,
      PRIMARY KEY (portfolio_id, slug, symbol)
    )
  `);
}

async function migratePortfolioSystemtraderStrategiesTable(
  db: ReturnType<typeof getClient>
): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS portfolio_systemtrader_strategies (
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      last_processed_date TEXT,
      last_processed_timestamp INTEGER,
      PRIMARY KEY (portfolio_id, slug)
    )
  `);

  const countRes = await db.execute(
    "SELECT COUNT(*) as c FROM portfolio_systemtrader_strategies"
  );
  const rowCount = Number(
    (countRes.rows[0] as unknown as { c: number }).c
  );
  if (rowCount === 0) {
    await db.execute(
      `
      INSERT INTO portfolio_systemtrader_strategies (portfolio_id, slug, last_processed_date, last_processed_timestamp)
      SELECT id,
             COALESCE(NULLIF(TRIM(systemtrader_slug), ''), ?),
             last_processed_date,
             last_processed_timestamp
      FROM portfolios
    `,
      [DEFAULT_SYSTEMTRADER_SLUG]
    );
  }

  await db.execute(
    `
    INSERT INTO portfolio_systemtrader_strategies (portfolio_id, slug, last_processed_date, last_processed_timestamp)
    SELECT p.id, ?, NULL, NULL
    FROM portfolios p
    WHERE NOT EXISTS (
      SELECT 1 FROM portfolio_systemtrader_strategies s WHERE s.portfolio_id = p.id
    )
  `,
    [DEFAULT_SYSTEMTRADER_SLUG]
  );
}

async function hasOldCredentialsSchema(db: ReturnType<typeof getClient>): Promise<boolean> {
  try {
    const result = await db.execute(
      "SELECT id FROM schwab_credentials LIMIT 1"
    );
    return result.rows.length >= 0;
  } catch {
    return false;
  }
}

export async function initializeDatabase(): Promise<void> {
  const db = getClient();
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_processed_date TEXT,
        last_processed_timestamp INTEGER
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    await db.execute(
      "INSERT OR IGNORE INTO portfolios (id, name, created_at) VALUES (1, ?, ?)",
      ["Default", now]
    );

    const result = await db.execute("SELECT COUNT(*) as count FROM state");
    const count = (result.rows[0]?.count as number) || 0;

    if (count === 0) {
      await db.execute(
        "INSERT INTO state (id, last_processed_date, last_processed_timestamp) VALUES (1, NULL, NULL)"
      );
    }

    await migratePortfoliosScrapeColumns(db);
    await migrateStateTable(db);
    await copyLegacyGlobalScrapeStateIntoPortfolios(db);

    const hasOldSchema = await hasOldCredentialsSchema(db);
    if (hasOldSchema) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS schwab_credentials_new (
          portfolio_id INTEGER PRIMARY KEY REFERENCES portfolios(id),
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          redirect_uri TEXT,
          account_number TEXT,
          updated_at INTEGER
        )
      `);
      await db.execute(`
        INSERT INTO schwab_credentials_new (portfolio_id, access_token, refresh_token, redirect_uri, account_number, updated_at)
        SELECT 1, access_token, refresh_token, redirect_uri, account_number, updated_at FROM schwab_credentials WHERE id = 1
      `);
      await db.execute("DROP TABLE schwab_credentials");
      await db.execute("ALTER TABLE schwab_credentials_new RENAME TO schwab_credentials");
    } else {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS schwab_credentials (
          portfolio_id INTEGER PRIMARY KEY REFERENCES portfolios(id),
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          redirect_uri TEXT,
          account_number TEXT,
          updated_at INTEGER
        )
      `);
    }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS tradier_credentials (
        portfolio_id INTEGER PRIMARY KEY REFERENCES portfolios(id),
        api_key TEXT NOT NULL,
        account_id TEXT,
        sandbox INTEGER NOT NULL,
        updated_at INTEGER
      )
    `);

    await migratePortfolioSystemtraderStrategiesTable(db);
    await migratePortfolioStrategySymbolsTable(db);
    await migrateTradeExecutionsTable(db);

    console.log("Database initialized successfully");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error initializing database:", errorMessage);
    throw error;
  }
}

export async function readJobStatistics(): Promise<JobStatisticsSnapshot> {
  const db = getClient();
  try {
    const result = await db.execute(
      `SELECT last_processed_date, last_processed_timestamp
       FROM portfolio_systemtrader_strategies
       WHERE last_processed_timestamp IS NOT NULL
       ORDER BY last_processed_timestamp DESC
       LIMIT 1`
    );
    const row = result.rows[0] as
      | { last_processed_date?: string; last_processed_timestamp?: number }
      | undefined;

    return {
      lastProcessedDate: row?.last_processed_date ?? null,
      lastProcessedTimestamp: row?.last_processed_timestamp ?? null,
      portfolioUrlEnvOverride: isPortfolioUrlEnvOverride(),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error reading job statistics:", errorMessage);
    return {
      lastProcessedDate: null,
      lastProcessedTimestamp: null,
      portfolioUrlEnvOverride: isPortfolioUrlEnvOverride(),
    };
  }
}

export function normalizeTickerSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Symbols historically traded for this strategy on this portfolio (persisted). Used with merge/remove each run. */
export async function loadStrategySleeveSymbols(
  portfolioId: number,
  slug: string
): Promise<string[]> {
  const db = getClient();
  const normalized = parseAndNormalizeSystemTraderSlug(slug);
  const res = await db.execute(
    `SELECT symbol FROM portfolio_strategy_symbols
     WHERE portfolio_id = ? AND lower(trim(slug)) = ?`,
    [portfolioId, normalized]
  );
  return (res.rows as unknown as { symbol: string }[]).map((r) =>
    normalizeTickerSymbol(String(r.symbol ?? ""))
  );
}

export async function mergeStrategySleeveSymbols(
  portfolioId: number,
  slug: string,
  symbols: readonly string[]
): Promise<void> {
  const db = getClient();
  const normalizedSlug = parseAndNormalizeSystemTraderSlug(slug);
  for (const raw of symbols) {
    const sym = normalizeTickerSymbol(raw);
    if (!sym) continue;
    await db.execute(
      `INSERT OR IGNORE INTO portfolio_strategy_symbols (portfolio_id, slug, symbol)
       VALUES (?, ?, ?)`,
      [portfolioId, normalizedSlug, sym]
    );
  }
}

export async function removeStrategySleeveSymbol(
  portfolioId: number,
  slug: string,
  symbol: string
): Promise<void> {
  const db = getClient();
  const normalizedSlug = parseAndNormalizeSystemTraderSlug(slug);
  const sym = normalizeTickerSymbol(symbol);
  if (!sym) return;
  await db.execute(
    `DELETE FROM portfolio_strategy_symbols
     WHERE portfolio_id = ? AND lower(trim(slug)) = ? AND symbol = ?`,
    [portfolioId, normalizedSlug, sym]
  );
}

export async function writePortfolioProcessedState(
  portfolioId: number,
  date: string,
  timestamp: number,
  processedSlug: string
): Promise<void> {
  const db = getClient();
  const normalized = parseAndNormalizeSystemTraderSlug(processedSlug);
  const dateNormalized = date.trim();
  await db.execute(
    `UPDATE portfolio_systemtrader_strategies SET
       last_processed_date = ?,
       last_processed_timestamp = ?
     WHERE portfolio_id = ? AND lower(trim(slug)) = ?`,
    [dateNormalized, timestamp, portfolioId, normalized]
  );
  const verify = await db.execute(
    `SELECT 1 AS ok FROM portfolio_systemtrader_strategies
     WHERE portfolio_id = ? AND lower(trim(slug)) = ? AND trim(last_processed_date) = ?`,
    [portfolioId, normalized, dateNormalized]
  );
  if (verify.rows.length === 0) {
    throw new Error(
      `Processed state was not persisted for portfolio ${portfolioId} strategy "${normalized}" (no matching row or date mismatch). Ensure this portfolio has that strategy selected in the UI.`
    );
  }
}

function dedupeSlugsStable(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of slugs) {
    const s = parseAndNormalizeSystemTraderSlug(raw);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export async function setPortfolioSystemTraderStrategies(
  portfolioId: number,
  slugs: string[]
): Promise<void> {
  if (slugs.length === 0) {
    throw new Error("At least one strategy slug is required");
  }
  const db = getClient();
  const check = await db.execute("SELECT id FROM portfolios WHERE id = ?", [
    portfolioId,
  ]);
  if (check.rows.length === 0) {
    throw new Error("Portfolio not found");
  }

  const normalized = dedupeSlugsStable(slugs);
  for (const s of normalized) {
    if (!ALLOWED_SLUG_SET.has(s)) {
      throw new Error(`Unknown strategy slug: ${s}`);
    }
  }

  const currentRes = await db.execute(
    "SELECT slug FROM portfolio_systemtrader_strategies WHERE portfolio_id = ?",
    [portfolioId]
  );
  const current = new Set(
    (currentRes.rows as unknown as { slug: string }[]).map((r) => r.slug)
  );
  const next = new Set(normalized);

  for (const s of current) {
    if (!next.has(s)) {
      await db.execute(
        "DELETE FROM portfolio_systemtrader_strategies WHERE portfolio_id = ? AND slug = ?",
        [portfolioId, s]
      );
    }
  }

  for (const s of normalized) {
    if (!current.has(s)) {
      await db.execute(
        `INSERT INTO portfolio_systemtrader_strategies (portfolio_id, slug, last_processed_date, last_processed_timestamp)
         VALUES (?, ?, NULL, NULL)`,
        [portfolioId, s]
      );
    }
  }
}

export function shouldProcess(
  date: string,
  lastProcessedDateForSlug: string | null
): boolean {
  const nextDate = date.trim();
  const prior = lastProcessedDateForSlug?.trim() ?? "";
  if (prior.length === 0) {
    return true;
  }
  return prior !== nextDate;
}

export async function listTradingPortfolioTargets(): Promise<
  TradingPortfolioTarget[]
> {
  const db = getClient();
  try {
    const result = await db.execute(
      `SELECT p.id AS id,
              s.slug AS systemtrader_slug,
              s.last_processed_date,
              s.last_processed_timestamp
       FROM portfolios p
       INNER JOIN portfolio_systemtrader_strategies s ON s.portfolio_id = p.id
       WHERE EXISTS (SELECT 1 FROM schwab_credentials sc WHERE sc.portfolio_id = p.id)
          OR EXISTS (SELECT 1 FROM tradier_credentials t WHERE t.portfolio_id = p.id)
       ORDER BY p.id, s.slug`
    );
    const rows = result.rows as unknown as {
      id: number | string | bigint;
      systemtrader_slug: string;
      last_processed_date: string | null;
      last_processed_timestamp: number | null;
    }[];

    const targets: TradingPortfolioTarget[] = [];
    for (const row of rows) {
      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) {
        console.warn(
          "[listTradingPortfolioTargets] Skipping row with invalid portfolio id:",
          row.id
        );
        continue;
      }
      let slug: string;
      try {
        slug = parseAndNormalizeSystemTraderSlug(String(row.systemtrader_slug ?? ""));
      } catch {
        console.warn(
          "[listTradingPortfolioTargets] Skipping row with invalid strategy slug:",
          row.systemtrader_slug
        );
        continue;
      }
      const lastProcessedDate =
        typeof row.last_processed_date === "string"
          ? row.last_processed_date.trim() || null
          : row.last_processed_date;
      targets.push({
        id,
        systemtraderSlug: slug,
        lastProcessedDate,
        lastProcessedTimestamp: row.last_processed_timestamp,
      });
    }
    return targets;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error listing trading portfolio targets:", errorMessage);
    return [];
  }
}

export async function listPortfolios(): Promise<PortfolioListItem[]> {
  const db = getClient();
  try {
    const portfoliosResult = await db.execute(
      "SELECT id, name FROM portfolios ORDER BY id"
    );
    const strategiesResult = await db.execute(
      `SELECT portfolio_id, slug, last_processed_date, last_processed_timestamp
       FROM portfolio_systemtrader_strategies
       ORDER BY portfolio_id, slug`
    );
    const byPortfolio = new Map<
      number,
      { slug: string; lastProcessedDate: string | null; lastProcessedTimestamp: number | null }[]
    >();
    for (const r of strategiesResult.rows as unknown as {
      portfolio_id: number;
      slug: string;
      last_processed_date: string | null;
      last_processed_timestamp: number | null;
    }[]) {
      const list = byPortfolio.get(r.portfolio_id) ?? [];
      list.push({
        slug: r.slug,
        lastProcessedDate: r.last_processed_date,
        lastProcessedTimestamp: r.last_processed_timestamp,
      });
      byPortfolio.set(r.portfolio_id, list);
    }

    const schwabIds = await db.execute("SELECT portfolio_id FROM schwab_credentials");
    const tradierRows = await db.execute(
      "SELECT portfolio_id, account_id, api_key, sandbox FROM tradier_credentials"
    );
    const tradierLast4ByPortfolioId = new Map<number, string | null>();
    const tradierAccountNumberByPortfolioId = new Map<number, string | null>();
    const updatedAt = Date.now();
    for (const r of tradierRows.rows as unknown as {
      portfolio_id: number;
      account_id: string | null;
      api_key: string;
      sandbox: number;
    }[]) {
      let accountStored = r.account_id?.trim() ?? "";
      let last4 = lastFourOfAccountId(accountStored || null);
      if (!accountStored && r.api_key?.trim()) {
        try {
          const resolved = await getTradierAccountId(
            r.api_key.trim(),
            r.sandbox === 1
          );
          await db.execute(
            `UPDATE tradier_credentials SET account_id = ?, updated_at = ? WHERE portfolio_id = ?`,
            [resolved, updatedAt, r.portfolio_id]
          );
          accountStored = resolved;
          last4 = lastFourOfAccountId(resolved);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(
            `[listPortfolios] Tradier account_id backfill failed for portfolio ${r.portfolio_id}:`,
            msg
          );
        }
      }
      tradierLast4ByPortfolioId.set(r.portfolio_id, last4);
      tradierAccountNumberByPortfolioId.set(
        r.portfolio_id,
        accountStored.length > 0 ? accountStored : null
      );
    }
    const tradierSet = new Set(tradierLast4ByPortfolioId.keys());
    const schwabSet = new Set(
      (schwabIds.rows as unknown as { portfolio_id: number }[]).map((x) => x.portfolio_id)
    );
    return (
      portfoliosResult.rows as unknown as { id: number; name: string }[]
    ).map((row) => {
      const hasSchwab = schwabSet.has(row.id);
      const hasTradier = tradierSet.has(row.id);
      const hasCredentials = hasSchwab || hasTradier;
      const brokerage: PortfolioBrokerage = hasSchwab
        ? "schwab"
        : hasTradier
          ? "tradier"
          : null;
      const runs = byPortfolio.get(row.id) ?? [];
      const strategyRuns: PortfolioStrategyRun[] = runs.map((x) => ({
        slug: x.slug,
        lastProcessedDate: x.lastProcessedDate,
        lastProcessedTimestamp: x.lastProcessedTimestamp,
      }));
      const systemtraderSlugs = strategyRuns.map((x) => x.slug);
      return {
        id: row.id,
        name: row.name,
        hasCredentials,
        brokerage,
        tradierAccountLast4:
          brokerage === "tradier"
            ? tradierLast4ByPortfolioId.get(row.id) ?? null
            : null,
        tradierAccountNumber:
          brokerage === "tradier"
            ? tradierAccountNumberByPortfolioId.get(row.id) ?? null
            : null,
        systemtraderSlugs,
        strategyRuns,
      };
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error listing portfolios:", errorMessage);
    throw error;
  }
}

export async function createPortfolio(name: string): Promise<{ id: number }> {
  const db = getClient();
  const createdAt = Date.now();
  try {
    const result = await db.execute(
      "INSERT INTO portfolios (name, created_at) VALUES (?, ?) RETURNING id",
      [name, createdAt]
    );
    const row = result.rows[0] as unknown as { id: number };
    if (!row?.id) {
      throw new Error("Insert did not return id");
    }
    await db.execute(
      `INSERT INTO portfolio_systemtrader_strategies (portfolio_id, slug, last_processed_date, last_processed_timestamp)
       VALUES (?, ?, NULL, NULL)`,
      [row.id, DEFAULT_SYSTEMTRADER_SLUG]
    );
    return { id: row.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error creating portfolio:", errorMessage);
    throw error;
  }
}

export async function getPortfolioIdsWithCredentials(): Promise<number[]> {
  const db = getClient();
  try {
    const schwab = await db.execute("SELECT portfolio_id FROM schwab_credentials");
    const tradier = await db.execute("SELECT portfolio_id FROM tradier_credentials");
    const ids = new Set<number>();
    for (const row of schwab.rows as unknown as { portfolio_id: number }[]) {
      ids.add(row.portfolio_id);
    }
    for (const row of tradier.rows as unknown as { portfolio_id: number }[]) {
      ids.add(row.portfolio_id);
    }
    return Array.from(ids);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error getting portfolio IDs with credentials:", errorMessage);
    return [];
  }
}

export async function readSchwabCredentials(
  portfolioId: number
): Promise<SchwabCredentials | null> {
  const db = getClient();
  try {
    const result = await db.execute(
      "SELECT * FROM schwab_credentials WHERE portfolio_id = ?",
      [portfolioId]
    );
    const row = result.rows[0] as
      | {
          access_token?: string;
          refresh_token?: string;
          redirect_uri?: string;
          account_number?: string;
        }
      | undefined;
    if (!row?.access_token || !row?.refresh_token) {
      return null;
    }
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      redirectUri: row.redirect_uri ?? undefined,
      accountNumber: row.account_number ?? undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error reading Schwab credentials from database:", errorMessage);
    return null;
  }
}

export async function writeSchwabCredentials(
  portfolioId: number,
  creds: SchwabCredentials
): Promise<void> {
  const db = getClient();
  const updatedAt = Date.now();
  try {
    await db.execute("DELETE FROM tradier_credentials WHERE portfolio_id = ?", [portfolioId]);
    await db.execute(
      `INSERT INTO schwab_credentials (portfolio_id, access_token, refresh_token, redirect_uri, account_number, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(portfolio_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         redirect_uri = excluded.redirect_uri,
         account_number = excluded.account_number,
         updated_at = excluded.updated_at`,
      [
        portfolioId,
        creds.accessToken,
        creds.refreshToken,
        creds.redirectUri ?? null,
        creds.accountNumber ?? null,
        updatedAt,
      ]
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error writing Schwab credentials to database:", errorMessage);
    throw error;
  }
}

export async function getPortfolioBrokerage(
  portfolioId: number
): Promise<PortfolioBrokerage> {
  const hasSchwab = await readSchwabCredentials(portfolioId);
  if (hasSchwab) return "schwab";
  const hasTradier = await readTradierCredentials(portfolioId);
  if (hasTradier) return "tradier";
  return null;
}

export async function updateTradierPortfolioAccountId(
  portfolioId: number,
  accountId: string
): Promise<void> {
  const normalized = accountId.trim();
  if (!normalized) {
    throw new Error("accountId is required");
  }
  const creds = await readTradierCredentials(portfolioId);
  if (!creds) {
    throw new Error("No Tradier credentials for this portfolio");
  }
  const list = await listTradierAccountsForKey(creds.apiKey, creds.sandbox);
  if (!isTradierAccountInProfileList(normalized, list)) {
    throw new Error(
      "Selected account is not in your Tradier profile for this API key."
    );
  }
  const db = getClient();
  const updatedAt = Date.now();
  await db.execute(
    `UPDATE tradier_credentials SET account_id = ?, updated_at = ? WHERE portfolio_id = ?`,
    [normalized, updatedAt, portfolioId]
  );
}

export async function readTradierCredentials(
  portfolioId: number
): Promise<TradierCredentials | null> {
  const db = getClient();
  try {
    const result = await db.execute(
      "SELECT api_key, account_id, sandbox FROM tradier_credentials WHERE portfolio_id = ?",
      [portfolioId]
    );
    const row = result.rows[0] as
      | { api_key?: string; account_id?: string; sandbox?: number }
      | undefined;
    if (!row?.api_key?.trim()) {
      return null;
    }
    return {
      apiKey: row.api_key,
      accountId: row.account_id ?? undefined,
      sandbox: row.sandbox === 1,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error reading Tradier credentials from database:", errorMessage);
    return null;
  }
}

export async function writeTradierCredentials(
  portfolioId: number,
  creds: TradierCredentials
): Promise<void> {
  const db = getClient();
  const updatedAt = Date.now();
  try {
    await db.execute("DELETE FROM schwab_credentials WHERE portfolio_id = ?", [portfolioId]);
    await db.execute(
      `INSERT INTO tradier_credentials (portfolio_id, api_key, account_id, sandbox, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(portfolio_id) DO UPDATE SET
         api_key = excluded.api_key,
         account_id = excluded.account_id,
         sandbox = excluded.sandbox,
         updated_at = excluded.updated_at`,
      [
        portfolioId,
        creds.apiKey,
        creds.accountId ?? null,
        creds.sandbox ? 1 : 0,
        updatedAt,
      ]
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error writing Tradier credentials to database:", errorMessage);
    throw error;
  }
}

async function migrateTradeExecutionsTable(
  db: ReturnType<typeof getClient>
): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS trade_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      strategy_slug TEXT NOT NULL,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      shares INTEGER NOT NULL,
      price REAL NOT NULL,
      success INTEGER NOT NULL,
      order_id TEXT,
      error TEXT,
      executed_at INTEGER NOT NULL
    )
  `);
}

export interface TradeExecutionRecord {
  portfolioId: number;
  strategySlug: string;
  symbol: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
  success: boolean;
  orderId?: string;
  error?: string;
}

export async function persistTradeExecutions(
  records: TradeExecutionRecord[]
): Promise<void> {
  if (records.length === 0) return;
  const db = getClient();
  const executedAt = Date.now();
  for (const r of records) {
    await db.execute(
      `INSERT INTO trade_executions (portfolio_id, strategy_slug, symbol, action, shares, price, success, order_id, error, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.portfolioId,
        r.strategySlug,
        r.symbol,
        r.action,
        r.shares,
        r.price,
        r.success ? 1 : 0,
        r.orderId ?? null,
        r.error ?? null,
        executedAt,
      ]
    );
  }
}

export interface PositionCostBasis {
  symbol: string;
  shares: number;
  costBasisPerShare: number;
}

export async function backfillMissingBuyRecords(
  portfolioId: number,
  strategySlug: string,
  positions: PositionCostBasis[]
): Promise<number> {
  if (positions.length === 0) return 0;
  const db = getClient();
  let backfilled = 0;

  for (const pos of positions) {
    const existing = await db.execute(
      `SELECT COALESCE(SUM(CASE WHEN action = 'BUY' THEN shares ELSE 0 END), 0) -
              COALESCE(SUM(CASE WHEN action = 'SELL' THEN shares ELSE 0 END), 0) AS net_shares
       FROM trade_executions
       WHERE portfolio_id = ? AND symbol = ? AND success = 1`,
      [portfolioId, pos.symbol]
    );
    const row = existing.rows[0] as { net_shares?: number } | undefined;
    const netRecorded = Number(row?.net_shares) || 0;

    const unrecordedShares = pos.shares - Math.max(0, netRecorded);
    if (unrecordedShares <= 0) continue;

    const syntheticTs = Date.now() - 90 * 86400000;
    await db.execute(
      `INSERT INTO trade_executions (portfolio_id, strategy_slug, symbol, action, shares, price, success, order_id, error, executed_at)
       VALUES (?, ?, ?, 'BUY', ?, ?, 1, NULL, NULL, ?)`,
      [portfolioId, strategySlug, pos.symbol, unrecordedShares, pos.costBasisPerShare, syntheticTs]
    );
    backfilled++;
  }

  return backfilled;
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

export async function readMonthlyPerformance(
  portfolioId?: number
): Promise<MonthlyPerformance[]> {
  const db = getClient();
  const whereClause = portfolioId != null ? "WHERE portfolio_id = ?" : "";
  const params = portfolioId != null ? [portfolioId] : [];

  const buysResult = await db.execute(
    `SELECT portfolio_id, symbol, shares, price, executed_at
     FROM trade_executions
     WHERE action = 'BUY' AND success = 1 ${portfolioId != null ? "AND portfolio_id = ?" : ""}
     ORDER BY executed_at ASC`,
    portfolioId != null ? [portfolioId] : []
  );

  const sellsResult = await db.execute(
    `SELECT portfolio_id, symbol, shares, price, executed_at
     FROM trade_executions
     WHERE action = 'SELL' AND success = 1 ${portfolioId != null ? "AND portfolio_id = ?" : ""}
     ORDER BY executed_at ASC`,
    portfolioId != null ? [portfolioId] : []
  );

  type BuyLot = { shares: number; price: number };
  const lotsByKey = new Map<string, BuyLot[]>();

  for (const row of buysResult.rows as unknown as {
    portfolio_id: number;
    symbol: string;
    shares: number;
    price: number;
    executed_at: number;
  }[]) {
    const key = `${row.portfolio_id}:${row.symbol}`;
    const lots = lotsByKey.get(key) ?? [];
    lots.push({ shares: Number(row.shares), price: Number(row.price) });
    lotsByKey.set(key, lots);
  }

  const closedTrades: ClosedTrade[] = [];

  for (const row of sellsResult.rows as unknown as {
    portfolio_id: number;
    symbol: string;
    shares: number;
    price: number;
    executed_at: number;
  }[]) {
    const key = `${row.portfolio_id}:${row.symbol}`;
    const lots = lotsByKey.get(key) ?? [];
    const sellShares = Number(row.shares);
    const sellPrice = Number(row.price);

    let remainingSell = sellShares;
    let totalCostBasis = 0;
    let matchedShares = 0;

    while (remainingSell > 0 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(remainingSell, lot.shares);
      totalCostBasis += take * lot.price;
      matchedShares += take;
      remainingSell -= take;
      lot.shares -= take;
      if (lot.shares <= 0) lots.shift();
    }

    if (matchedShares > 0) {
      const avgBuyPrice = totalCostBasis / matchedShares;
      const pnl = (sellPrice - avgBuyPrice) * matchedShares;
      const pnlPercent = avgBuyPrice > 0 ? ((sellPrice - avgBuyPrice) / avgBuyPrice) * 100 : 0;
      closedTrades.push({
        symbol: row.symbol,
        portfolioId: Number(row.portfolio_id),
        buyPrice: avgBuyPrice,
        sellPrice,
        shares: matchedShares,
        pnl,
        pnlPercent,
        closedAt: Number(row.executed_at),
      });
    }
  }

  const monthlyMap = new Map<string, { pnl: number; wins: number; losses: number; bought: number; sold: number }>();

  for (const t of closedTrades) {
    const month = new Date(t.closedAt).toISOString().slice(0, 7);
    const entry = monthlyMap.get(month) ?? { pnl: 0, wins: 0, losses: 0, bought: 0, sold: 0 };
    entry.pnl += t.pnl;
    entry.bought += t.buyPrice * t.shares;
    entry.sold += t.sellPrice * t.shares;
    if (t.pnl >= 0) entry.wins++;
    else entry.losses++;
    monthlyMap.set(month, entry);
  }

  const buysAggResult = await db.execute(
    `SELECT strftime('%Y-%m', executed_at / 1000, 'unixepoch') AS month,
            SUM(shares * price) AS total_bought
     FROM trade_executions
     WHERE action = 'BUY' AND success = 1 ${portfolioId != null ? "AND portfolio_id = ?" : ""}
     GROUP BY month`,
    portfolioId != null ? [portfolioId] : []
  );
  for (const row of buysAggResult.rows as unknown as { month: string; total_bought: number }[]) {
    const entry = monthlyMap.get(row.month) ?? { pnl: 0, wins: 0, losses: 0, bought: 0, sold: 0 };
    if (entry.bought === 0) entry.bought = Number(row.total_bought) || 0;
    monthlyMap.set(row.month, entry);
  }

  const months = Array.from(monthlyMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, data]) => {
      const closed = data.wins + data.losses;
      return {
        month,
        realizedPnL: Math.round(data.pnl * 100) / 100,
        closedTrades: closed,
        winningTrades: data.wins,
        losingTrades: data.losses,
        winRate: closed > 0 ? Math.round((data.wins / closed) * 1000) / 10 : 0,
        totalBought: Math.round(data.bought * 100) / 100,
        totalSold: Math.round(data.sold * 100) / 100,
      };
    });

  return months;
}

export interface StrategyPerformance {
  strategy: string;
  realizedPnL: number;
  closedTrades: number;
  winRate: number;
  monthlyPnL: { month: string; pnl: number; cumulativePnL: number }[];
}

export async function readPerformanceByStrategy(
  portfolioId?: number
): Promise<StrategyPerformance[]> {
  const db = getClient();
  const filter = portfolioId != null ? "AND portfolio_id = ?" : "";
  const params = portfolioId != null ? [portfolioId] : [];

  const buysResult = await db.execute(
    `SELECT portfolio_id, strategy_slug, symbol, shares, price, executed_at
     FROM trade_executions
     WHERE action = 'BUY' AND success = 1 ${filter}
     ORDER BY executed_at ASC`,
    params
  );

  const sellsResult = await db.execute(
    `SELECT portfolio_id, strategy_slug, symbol, shares, price, executed_at
     FROM trade_executions
     WHERE action = 'SELL' AND success = 1 ${filter}
     ORDER BY executed_at ASC`,
    params
  );

  type BuyLot = { shares: number; price: number };
  const lotsByKey = new Map<string, BuyLot[]>();
  for (const row of buysResult.rows as unknown as {
    portfolio_id: number; strategy_slug: string; symbol: string; shares: number; price: number;
  }[]) {
    const key = `${row.portfolio_id}:${row.symbol}`;
    const lots = lotsByKey.get(key) ?? [];
    lots.push({ shares: Number(row.shares), price: Number(row.price) });
    lotsByKey.set(key, lots);
  }

  type StrategyTrade = { pnl: number; closedAt: number };
  const tradesByStrategy = new Map<string, StrategyTrade[]>();

  for (const row of sellsResult.rows as unknown as {
    portfolio_id: number; strategy_slug: string; symbol: string; shares: number; price: number; executed_at: number;
  }[]) {
    const key = `${row.portfolio_id}:${row.symbol}`;
    const lots = lotsByKey.get(key) ?? [];
    let remaining = Number(row.shares);
    let costBasis = 0;
    let matched = 0;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(remaining, lot.shares);
      costBasis += take * lot.price;
      matched += take;
      remaining -= take;
      lot.shares -= take;
      if (lot.shares <= 0) lots.shift();
    }
    if (matched > 0) {
      const pnl = (Number(row.price) - costBasis / matched) * matched;
      const slug = row.strategy_slug || "unknown";
      const trades = tradesByStrategy.get(slug) ?? [];
      trades.push({ pnl, closedAt: Number(row.executed_at) });
      tradesByStrategy.set(slug, trades);
    }
  }

  const results: StrategyPerformance[] = [];
  for (const [strategy, trades] of tradesByStrategy.entries()) {
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const wins = trades.filter((t) => t.pnl >= 0).length;
    const winRate = trades.length > 0 ? Math.round((wins / trades.length) * 1000) / 10 : 0;

    const monthlyMap = new Map<string, number>();
    for (const t of trades) {
      const month = new Date(t.closedAt).toISOString().slice(0, 7);
      monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + t.pnl);
    }
    const sortedMonths = Array.from(monthlyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    let cumulative = 0;
    const monthlyPnL = sortedMonths.map(([month, pnl]) => {
      cumulative += pnl;
      return { month, pnl: Math.round(pnl * 100) / 100, cumulativePnL: Math.round(cumulative * 100) / 100 };
    });

    results.push({
      strategy,
      realizedPnL: Math.round(totalPnL * 100) / 100,
      closedTrades: trades.length,
      winRate,
      monthlyPnL,
    });
  }

  return results.sort((a, b) => b.realizedPnL - a.realizedPnL);
}

export async function readClosedTrades(
  portfolioId?: number,
  limit = 50
): Promise<ClosedTrade[]> {
  const perf = await readMonthlyPerformance(portfolioId);
  void perf;

  const db = getClient();
  const buysResult = await db.execute(
    `SELECT portfolio_id, symbol, shares, price, executed_at
     FROM trade_executions
     WHERE action = 'BUY' AND success = 1 ${portfolioId != null ? "AND portfolio_id = ?" : ""}
     ORDER BY executed_at ASC`,
    portfolioId != null ? [portfolioId] : []
  );
  const sellsResult = await db.execute(
    `SELECT portfolio_id, symbol, shares, price, executed_at
     FROM trade_executions
     WHERE action = 'SELL' AND success = 1 ${portfolioId != null ? "AND portfolio_id = ?" : ""}
     ORDER BY executed_at DESC
     LIMIT ?`,
    portfolioId != null ? [portfolioId, limit] : [limit]
  );

  type BuyLot = { shares: number; price: number };
  const lotsByKey = new Map<string, BuyLot[]>();
  for (const row of buysResult.rows as unknown as {
    portfolio_id: number; symbol: string; shares: number; price: number;
  }[]) {
    const key = `${row.portfolio_id}:${row.symbol}`;
    const lots = lotsByKey.get(key) ?? [];
    lots.push({ shares: Number(row.shares), price: Number(row.price) });
    lotsByKey.set(key, lots);
  }

  const trades: ClosedTrade[] = [];
  for (const row of sellsResult.rows as unknown as {
    portfolio_id: number; symbol: string; shares: number; price: number; executed_at: number;
  }[]) {
    const key = `${row.portfolio_id}:${row.symbol}`;
    const lots = lotsByKey.get(key) ?? [];
    const sellShares = Number(row.shares);
    let remaining = sellShares;
    let costBasis = 0;
    let matched = 0;
    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(remaining, lot.shares);
      costBasis += take * lot.price;
      matched += take;
      remaining -= take;
      lot.shares -= take;
      if (lot.shares <= 0) lots.shift();
    }
    if (matched > 0) {
      const avgBuy = costBasis / matched;
      const pnl = (Number(row.price) - avgBuy) * matched;
      const pnlPct = avgBuy > 0 ? ((Number(row.price) - avgBuy) / avgBuy) * 100 : 0;
      trades.push({
        symbol: row.symbol,
        portfolioId: Number(row.portfolio_id),
        buyPrice: Math.round(avgBuy * 100) / 100,
        sellPrice: Number(row.price),
        shares: matched,
        pnl: Math.round(pnl * 100) / 100,
        pnlPercent: Math.round(pnlPct * 10) / 10,
        closedAt: Number(row.executed_at),
      });
    }
  }

  return trades;
}

import { createClient } from "@libsql/client";

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
  systemtraderSlugs: string[];
  strategyRuns: PortfolioStrategyRun[];
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

export async function writePortfolioProcessedState(
  portfolioId: number,
  date: string,
  timestamp: number,
  processedSlug: string
): Promise<void> {
  const db = getClient();
  const normalized = parseAndNormalizeSystemTraderSlug(processedSlug);
  await db.execute(
    `UPDATE portfolio_systemtrader_strategies SET
       last_processed_date = ?,
       last_processed_timestamp = ?
     WHERE portfolio_id = ? AND slug = ?`,
    [date, timestamp, portfolioId, normalized]
  );
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
  if (!lastProcessedDateForSlug) {
    return true;
  }
  return lastProcessedDateForSlug !== date;
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
    return (
      result.rows as unknown as {
        id: number;
        systemtrader_slug: string;
        last_processed_date: string | null;
        last_processed_timestamp: number | null;
      }[]
    ).map((row) => ({
      id: row.id,
      systemtraderSlug: row.systemtrader_slug,
      lastProcessedDate: row.last_processed_date,
      lastProcessedTimestamp: row.last_processed_timestamp,
    }));
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
    const tradierIds = await db.execute("SELECT portfolio_id FROM tradier_credentials");
    const schwabSet = new Set(
      (schwabIds.rows as unknown as { portfolio_id: number }[]).map((x) => x.portfolio_id)
    );
    const tradierSet = new Set(
      (tradierIds.rows as unknown as { portfolio_id: number }[]).map((x) => x.portfolio_id)
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

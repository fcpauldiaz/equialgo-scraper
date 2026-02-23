import { createClient } from "@libsql/client";

interface State {
  lastProcessedDate: string | null;
  lastProcessedTimestamp: number | null;
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

    console.log("Database initialized successfully");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error initializing database:", errorMessage);
    throw error;
  }
}

export async function readState(): Promise<State> {
  const db = getClient();
  try {
    const result = await db.execute("SELECT * FROM state WHERE id = 1");
    const row = result.rows[0];

    if (!row) {
      return {
        lastProcessedDate: null,
        lastProcessedTimestamp: null,
      };
    }

    return {
      lastProcessedDate: (row.last_processed_date as string) || null,
      lastProcessedTimestamp:
        (row.last_processed_timestamp as number) || null,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error reading state from database:", errorMessage);
    return {
      lastProcessedDate: null,
      lastProcessedTimestamp: null,
    };
  }
}

export async function writeState(date: string, timestamp: number): Promise<void> {
  const db = getClient();
  try {
    await db.execute(
      "UPDATE state SET last_processed_date = ?, last_processed_timestamp = ? WHERE id = 1",
      [date, timestamp]
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error writing state to database:", errorMessage);
    throw error;
  }
}

export function shouldProcess(date: string, state: State): boolean {
  if (!state.lastProcessedDate) {
    return true;
  }
  return state.lastProcessedDate !== date;
}

export async function listPortfolios(): Promise<PortfolioListItem[]> {
  const db = getClient();
  try {
    const portfoliosResult = await db.execute(
      "SELECT id, name FROM portfolios ORDER BY id"
    );
    const schwabIds = await db.execute("SELECT portfolio_id FROM schwab_credentials");
    const tradierIds = await db.execute("SELECT portfolio_id FROM tradier_credentials");
    const schwabSet = new Set(
      (schwabIds.rows as unknown as { portfolio_id: number }[]).map((r) => r.portfolio_id)
    );
    const tradierSet = new Set(
      (tradierIds.rows as unknown as { portfolio_id: number }[]).map((r) => r.portfolio_id)
    );
    return (portfoliosResult.rows as unknown as { id: number; name: string }[]).map(
      (row) => {
        const hasSchwab = schwabSet.has(row.id);
        const hasTradier = tradierSet.has(row.id);
        const hasCredentials = hasSchwab || hasTradier;
        const brokerage: PortfolioBrokerage = hasSchwab
          ? "schwab"
          : hasTradier
            ? "tradier"
            : null;
        return {
          id: row.id,
          name: row.name,
          hasCredentials,
          brokerage,
        };
      }
    );
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

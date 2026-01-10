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

    const result = await db.execute("SELECT COUNT(*) as count FROM state");
    const count = (result.rows[0]?.count as number) || 0;

    if (count === 0) {
      await db.execute(
        "INSERT INTO state (id, last_processed_date, last_processed_timestamp) VALUES (1, NULL, NULL)"
      );
    }

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

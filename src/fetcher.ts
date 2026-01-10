import fetch from "node-fetch";
import { BacktestData } from "./types";

const API_URL =
  process.env.API_URL ||
  "https://www.equialgo.com/data/backtest/momentum_backtest.json";
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || "1000", 10);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchBacktestData(): Promise<BacktestData> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(API_URL);

      if (!response.ok) {
        throw new Error(
          `HTTP error! status: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as BacktestData;

      if (!data.snapshots || !Array.isArray(data.snapshots)) {
        throw new Error("Invalid API response: missing or invalid snapshots");
      }

      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Fetch attempt ${attempt} failed:`, lastError.message);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Failed to fetch data after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}


import puppeteer, { type Browser, type Page } from "puppeteer";
import { BacktestData } from "./types";

const API_URL =
  process.env.API_URL ||
  "https://www.equialgo.com/data/backtest/momentum_backtest.json";
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || "1000", 10);
const HEADLESS = process.env.PUPPETEER_HEADLESS !== "false";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export async function fetchBacktestData(): Promise<BacktestData> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page: Page | null = null;
    try {
      const browserInstance = await getBrowser();
      page = await browserInstance.newPage();

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      console.log(`Fetching data from ${API_URL} (attempt ${attempt})...`);

      const response = await page.goto(API_URL, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      if (!response || !response.ok()) {
        throw new Error(
          `HTTP error! status: ${response?.status()} ${response?.statusText()}`
        );
      }

      const jsonText = await response.text();

      if (!jsonText || jsonText.trim().length === 0) {
        throw new Error("Empty response from API");
      }

      const data = JSON.parse(jsonText.trim()) as BacktestData;

      if (!data.snapshots || !Array.isArray(data.snapshots)) {
        throw new Error("Invalid API response: missing or invalid snapshots");
      }

      await page.close();
      return data;
    } catch (error) {
      if (page) {
        try {
          await page.close();
        } catch (closeError) {
          console.error("Error closing page:", closeError);
        }
      }

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


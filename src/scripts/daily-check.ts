import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeBrowser } from "../scraper";
import { initializeDatabase } from "../state";
import { runDailyCheckWithRetries } from "../run-check";

const SCRAPER_BUILD_MARKER = "fieldIsUsableForTyping";

function exitIfStaleCompiledScraper(): void {
  const scraperJs = join(__dirname, "..", "scraper.js");
  if (!existsSync(scraperJs)) {
    return;
  }
  const head = readFileSync(scraperJs, "utf8").slice(0, 120_000);
  if (!head.includes(SCRAPER_BUILD_MARKER)) {
    console.error(
      "[daily-check] dist/scraper.js is missing the current login logic. Run `pnpm run build`, then retry."
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  exitIfStaleCompiledScraper();
  try {
    await initializeDatabase();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize database:", errorMessage);
    process.exit(1);
  }

  try {
    await runDailyCheckWithRetries();
  } finally {
    await closeBrowser();
  }
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  await closeBrowser();
  process.exit(1);
});

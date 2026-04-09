import "dotenv/config";
import { closeBrowser } from "../scraper";
import { initializeDatabase } from "../state";
import { runDailyCheckWithRetries } from "../run-check";

async function main(): Promise<void> {
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

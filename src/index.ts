import "dotenv/config";
import { closeBrowser } from "./scraper";
import { initializeDatabase } from "./state";
import { startUiServer } from "./ui-server";

async function main(): Promise<void> {
  console.log("EquiAlgo Alert Service starting...");

  try {
    await initializeDatabase();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize database:", errorMessage);
    process.exit(1);
  }

  startUiServer();

  console.log("Service is running (UI only). Run the daily check via your scheduler (e.g. Coolify): pnpm run daily-check");
  console.log("Press Ctrl+C to stop.");
}

if (require.main === module) {
  const cleanup = async () => {
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  main().catch(async (error) => {
    console.error("Fatal error:", error);
    await closeBrowser();
    process.exit(1);
  });
}

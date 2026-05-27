import "dotenv/config";
import { initializeDatabase } from "../state";
import { sendWeeklyReport } from "../weekly-report";

async function main(): Promise<void> {
  try {
    await initializeDatabase();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize database:", msg);
    process.exit(1);
  }

  try {
    await sendWeeklyReport();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[weekly-report] Failed:", msg);
    process.exit(1);
  }
}

main();

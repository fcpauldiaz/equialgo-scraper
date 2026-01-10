import "dotenv/config";
import cron from "node-cron";
import { fetchBacktestData } from "./fetcher";
import { processSignals } from "./processor";
import { sendNotification } from "./notifier";
import {
  readState,
  writeState,
  shouldProcess,
  initializeDatabase,
} from "./state";

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 9 * * *";

async function runCheck(): Promise<void> {
  try {
    console.log("Starting daily check...");

    const data = await fetchBacktestData();
    console.log("Data fetched successfully");

    const processedSignals = processSignals(data);
    if (!processedSignals) {
      console.warn("No signals to process");
      return;
    }

    console.log(
      `Found ${processedSignals.enterSignals.length} ENTER signals, ${processedSignals.keepSignals.length} KEEP signals, and ${processedSignals.exitSignals.length} EXIT signals`
    );

    const state = await readState();
    if (!shouldProcess(processedSignals.date, state)) {
      console.log(
        `Already processed date ${processedSignals.date}, skipping notification`
      );
      return;
    }

    console.log(`Processing new date: ${processedSignals.date}`);
    await sendNotification(processedSignals);

    const timestamp = new Date(processedSignals.date).getTime();
    await writeState(processedSignals.date, timestamp);
    console.log(`State updated for date: ${processedSignals.date}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in daily check:", errorMessage);
  }
}

async function main(): Promise<void> {
  console.log(`EquiAlgo Alert Service starting...`);
  console.log(`Cron schedule: ${CRON_SCHEDULE}`);
  console.log(`Scheduled to run daily at: ${CRON_SCHEDULE}`);

  try {
    await initializeDatabase();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize database:", errorMessage);
    process.exit(1);
  }

  cron.schedule(CRON_SCHEDULE, async () => {
    await runCheck();
  });

  console.log("Service is running. Waiting for scheduled execution...");
  console.log("Press Ctrl+C to stop.");

  await runCheck();
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}


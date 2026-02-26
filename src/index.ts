import "dotenv/config";
import cron from "node-cron";
import { scrapePortfolioData, closeBrowser } from "./scraper";
import { processedSignalsFromActions, scaleActionsToPortfolioSize } from "./processor";
import { sendNotification } from "./notifier";
import { executeTradesFromActions } from "./trader";
import {
  readState,
  writeState,
  shouldProcess,
  initializeDatabase,
  getPortfolioIdsWithCredentials,
} from "./state";
import { startUiServer } from "./ui-server";

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 9 * * *";
const CRON_TIMEZONE = process.env.CRON_TIMEZONE?.trim() || undefined;
const JOB_RETRY_ATTEMPTS = Math.max(1, parseInt(process.env.SCRAPE_JOB_RETRY_ATTEMPTS || "3", 10));
const JOB_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.SCRAPE_JOB_RETRY_DELAY_MS || "60000", 10));

async function runCheck(): Promise<void> {
  try {
    console.log("Starting daily check...");

    const scrapedData = await scrapePortfolioData();
    console.log("Portfolio data scraped successfully");

    if (!scrapedData.actions || scrapedData.actions.length === 0) {
      console.warn("No actions found in scraped data");
      return;
    }

    console.log(`Found ${scrapedData.actions.length} actions for date ${scrapedData.date}`);

    const state = await readState();
    if (!shouldProcess(scrapedData.date, state)) {
      console.log(
        `Already processed date ${scrapedData.date}, skipping`
      );
      return;
    }

    console.log(`Processing new date: ${scrapedData.date}`);

    const PORTFOLIO_SIZE = parseInt(process.env.PORTFOLIO_SIZE || "10000", 10);
    const scaledActions = scaleActionsToPortfolioSize(scrapedData.actions, PORTFOLIO_SIZE);
    
    const totalOriginalValue = scrapedData.actions
      .filter((a) => a.action === "BUY")
      .reduce((sum, a) => sum + a.shares * a.price, 0);
    const totalScaledValue = scaledActions
      .filter((a) => a.action === "BUY")
      .reduce((sum, a) => sum + a.shares * a.price, 0);
    
    if (totalOriginalValue > 0) {
      console.log(
        `Scaling actions: Original BUY value: $${totalOriginalValue.toFixed(2)} → Scaled to $${totalScaledValue.toFixed(2)} (target: $${PORTFOLIO_SIZE})`
      );
    }

    let portfolioIds = await getPortfolioIdsWithCredentials();
    const filterEnv = process.env.PORTFOLIO_IDS;
    if (filterEnv) {
      const allowed = new Set(
        filterEnv.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
      );
      portfolioIds = portfolioIds.filter((id) => allowed.has(id));
    }
    if (portfolioIds.length === 0) {
      console.log("No portfolios with Schwab or Tradier credentials; skipping trade execution.");
    } else {
      for (const portfolioId of portfolioIds) {
        const tradeSummary = await executeTradesFromActions(scaledActions, portfolioId);
        console.log(
          `Portfolio ${portfolioId}: ${tradeSummary.successful.length} successful, ${tradeSummary.failed.length} failed, ${tradeSummary.skipped.length} skipped`
        );
      }
    }

    const processedSignals = processedSignalsFromActions(scrapedData);
    await sendNotification(processedSignals);

    const timestamp = new Date(scrapedData.date).getTime();
    await writeState(scrapedData.date, timestamp);
    console.log(`State updated for date: ${scrapedData.date}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in daily check:", errorMessage);
    throw error;
  }
}

async function main(): Promise<void> {
  console.log(`EquiAlgo Alert Service starting...`);
  console.log(`Cron schedule: ${CRON_SCHEDULE}${CRON_TIMEZONE ? ` (${CRON_TIMEZONE})` : ""}`);
  if (JOB_RETRY_ATTEMPTS > 1) {
    console.log(`Job retries: ${JOB_RETRY_ATTEMPTS} attempts, ${JOB_RETRY_DELAY_MS / 1000}s between attempts`);
  }

  try {
    await initializeDatabase();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error("Failed to initialize database:", errorMessage);
    process.exit(1);
  }

  startUiServer();

  cron.schedule(CRON_SCHEDULE, async () => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= JOB_RETRY_ATTEMPTS; attempt++) {
      try {
        await runCheck();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;
        console.error(`Daily check attempt ${attempt}/${JOB_RETRY_ATTEMPTS} failed:`, errorMessage);
        if (attempt < JOB_RETRY_ATTEMPTS && JOB_RETRY_DELAY_MS > 0) {
          console.log(`Retrying in ${JOB_RETRY_DELAY_MS / 1000}s...`);
          await new Promise((resolve) => setTimeout(resolve, JOB_RETRY_DELAY_MS));
        }
      }
    }
    if (lastError) {
      console.error("All retry attempts failed:", lastError.message);
    }
  }, CRON_TIMEZONE ? { timezone: CRON_TIMEZONE } : {});

  console.log("Service is running. Waiting for scheduled execution...");
  console.log("Press Ctrl+C to stop.");

  await runCheck();
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


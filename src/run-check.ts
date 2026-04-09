import { scrapePortfolioData } from "./scraper";
import { processedSignalsFromActions, scaleActionsToPortfolioSize } from "./processor";
import { sendNotification } from "./notifier";
import { executeTradesFromActions } from "./trader";
import {
  shouldProcess,
  listTradingPortfolioTargets,
  resolveEffectiveSystemTraderPortfolioUrl,
  writePortfolioProcessedState,
} from "./state";

const JOB_RETRY_ATTEMPTS = Math.max(1, parseInt(process.env.SCRAPE_JOB_RETRY_ATTEMPTS || "3", 10));
const JOB_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.SCRAPE_JOB_RETRY_DELAY_MS || "60000", 10));

export async function runCheck(): Promise<void> {
  try {
    console.log("Starting daily check...");

    let targets = await listTradingPortfolioTargets();
    const filterEnv = process.env.PORTFOLIO_IDS;
    if (filterEnv) {
      const allowed = new Set(
        filterEnv.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
      );
      targets = targets.filter((t) => allowed.has(t.id));
    }

    if (targets.length === 0) {
      console.log("No portfolios with Schwab or Tradier credentials; nothing to run.");
      return;
    }

    const slugToPortfolioIds = new Map<string, number[]>();
    for (const t of targets) {
      const slug = t.systemtraderSlug;
      if (!slugToPortfolioIds.has(slug)) {
        slugToPortfolioIds.set(slug, []);
      }
      slugToPortfolioIds.get(slug)!.push(t.id);
    }

    const notifiedSlugDate = new Set<string>();
    const PORTFOLIO_SIZE = parseInt(process.env.PORTFOLIO_SIZE || "10000", 10);

    for (const [slug, portfolioIds] of slugToPortfolioIds) {
      const portfolioUrl = resolveEffectiveSystemTraderPortfolioUrl(slug);
      console.log(`Scraping strategy "${slug}" for ${portfolioIds.length} portfolio(s)...`);

      const scrapedData = await scrapePortfolioData(portfolioUrl);

      if (!scrapedData.actions || scrapedData.actions.length === 0) {
        console.warn(`No actions found for strategy "${slug}"`);
        continue;
      }

      console.log(
        `Strategy "${slug}": ${scrapedData.actions.length} actions for date ${scrapedData.date}`
      );

      const scaledActions = scaleActionsToPortfolioSize(scrapedData.actions, PORTFOLIO_SIZE);

      const totalOriginalValue = scrapedData.actions
        .filter((a) => a.action === "BUY")
        .reduce((sum, a) => sum + a.shares * a.price, 0);
      const totalScaledValue = scaledActions
        .filter((a) => a.action === "BUY")
        .reduce((sum, a) => sum + a.shares * a.price, 0);

      if (totalOriginalValue > 0) {
        console.log(
          `Scaling actions (${slug}): Original BUY value: $${totalOriginalValue.toFixed(2)} → Scaled to $${totalScaledValue.toFixed(2)} (target: $${PORTFOLIO_SIZE})`
        );
      }

      let anyProcessedForSlug = false;

      for (const portfolioId of portfolioIds) {
        const target = targets.find((x) => x.id === portfolioId);
        if (!target) continue;

        const scrapeState = {
          lastProcessedDate: target.lastProcessedDate,
          lastProcessedSystemtraderSlug: target.lastProcessedSystemtraderSlug,
        };

        if (!shouldProcess(scrapedData.date, scrapeState, slug)) {
          console.log(
            `Portfolio ${portfolioId}: already processed ${scrapedData.date} for "${slug}", skipping`
          );
          continue;
        }

        console.log(`Portfolio ${portfolioId}: processing ${scrapedData.date} (${slug})`);

        const tradeSummary = await executeTradesFromActions(scaledActions, portfolioId);
        console.log(
          `Portfolio ${portfolioId}: ${tradeSummary.successful.length} successful, ${tradeSummary.failed.length} failed, ${tradeSummary.skipped.length} skipped`
        );

        const timestamp = new Date(scrapedData.date).getTime();
        await writePortfolioProcessedState(portfolioId, scrapedData.date, timestamp, slug);
        target.lastProcessedDate = scrapedData.date;
        target.lastProcessedTimestamp = timestamp;
        target.lastProcessedSystemtraderSlug = slug;

        anyProcessedForSlug = true;
      }

      if (anyProcessedForSlug) {
        const notifyKey = `${slug}:${scrapedData.date}`;
        if (!notifiedSlugDate.has(notifyKey)) {
          const processedSignals = processedSignalsFromActions(scrapedData);
          await sendNotification(processedSignals);
          notifiedSlugDate.add(notifyKey);
        }
        console.log(`Strategy "${slug}": state updated for date ${scrapedData.date}`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in daily check:", errorMessage);
    throw error;
  }
}

export async function runDailyCheckWithRetries(): Promise<void> {
  if (JOB_RETRY_ATTEMPTS > 1) {
    console.log(
      `Job retries: ${JOB_RETRY_ATTEMPTS} attempts, ${JOB_RETRY_DELAY_MS / 1000}s between attempts`
    );
  }

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= JOB_RETRY_ATTEMPTS; attempt++) {
    try {
      await runCheck();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Daily check attempt ${attempt}/${JOB_RETRY_ATTEMPTS} failed:`, lastError.message);
      if (attempt < JOB_RETRY_ATTEMPTS && JOB_RETRY_DELAY_MS > 0) {
        console.log(`Retrying in ${JOB_RETRY_DELAY_MS / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, JOB_RETRY_DELAY_MS));
      }
    }
  }
  if (lastError) {
    console.error("All retry attempts failed:", lastError.message);
    throw lastError;
  }
}

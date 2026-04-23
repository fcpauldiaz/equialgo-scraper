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
import type { PortfolioAction, ScrapedPortfolioData } from "./types";

const JOB_RETRY_ATTEMPTS = Math.max(1, parseInt(process.env.SCRAPE_JOB_RETRY_ATTEMPTS || "3", 10));
const JOB_RETRY_DELAY_MS = Math.max(0, parseInt(process.env.SCRAPE_JOB_RETRY_DELAY_MS || "60000", 10));

interface RunCheckOptions {
  portfolioIds?: readonly number[];
}

type SlugRunPrepared =
  | { kind: "ready"; scrapedData: ScrapedPortfolioData; scaledActions: PortfolioAction[] }
  | { kind: "scrape_failed" }
  | { kind: "no_actions" };

export async function runCheck(options: RunCheckOptions = {}): Promise<void> {
  const encounteredErrors: string[] = [];
  try {
    console.log("Starting daily check...");

    let targets = await listTradingPortfolioTargets();
    const requestedPortfolioIds = options.portfolioIds ?? [];
    if (requestedPortfolioIds.length > 0) {
      const allowed = new Set(
        requestedPortfolioIds
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
      );
      targets = targets.filter((t) => allowed.has(t.id));
    }

    if (targets.length === 0) {
      console.log("No portfolios with Schwab or Tradier credentials; nothing to run.");
      return;
    }

    const uniquePortfolioIds = [...new Set(targets.map((t) => t.id))].sort(
      (a, b) => a - b
    );
    console.log(
      `Daily check: ${targets.length} strategy target(s) across ${uniquePortfolioIds.length} portfolio(s) [${uniquePortfolioIds.join(", ")}]`
    );
    if (requestedPortfolioIds.length > 0) {
      console.log(`Manual run filter: ${uniquePortfolioIds.join(", ")}`);
    }

    const notifiedSlugDate = new Set<string>();
    const warnedNoActionsSlugs = new Set<string>();
    const slugPrepBySlug = new Map<string, SlugRunPrepared>();
    const PORTFOLIO_SIZE = parseInt(process.env.PORTFOLIO_SIZE || "10000", 10);

    const targetsSorted = [...targets].sort((a, b) => {
      if (a.id !== b.id) return a.id - b.id;
      return a.systemtraderSlug.localeCompare(b.systemtraderSlug);
    });

    async function ensureSlugPrepared(slug: string): Promise<SlugRunPrepared> {
      const existing = slugPrepBySlug.get(slug);
      if (existing) return existing;

      const portfolioUrl = resolveEffectiveSystemTraderPortfolioUrl(slug);
      const portfolioCount = targetsSorted.filter((t) => t.systemtraderSlug === slug).length;
      console.log(`Scraping strategy "${slug}" for ${portfolioCount} portfolio(s)...`);

      let scrapedData: ScrapedPortfolioData;
      try {
        scrapedData = await scrapePortfolioData(portfolioUrl);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        encounteredErrors.push(`Strategy "${slug}" scrape failed: ${errorMessage}`);
        console.error(`Strategy "${slug}" scrape failed:`, errorMessage);
        const failed: SlugRunPrepared = { kind: "scrape_failed" };
        slugPrepBySlug.set(slug, failed);
        return failed;
      }

      if (!scrapedData.actions || scrapedData.actions.length === 0) {
        if (!warnedNoActionsSlugs.has(slug)) {
          console.warn(`No actions found for strategy "${slug}"`);
          warnedNoActionsSlugs.add(slug);
        }
        const empty: SlugRunPrepared = { kind: "no_actions" };
        slugPrepBySlug.set(slug, empty);
        return empty;
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

      const ready: SlugRunPrepared = { kind: "ready", scrapedData, scaledActions };
      slugPrepBySlug.set(slug, ready);
      return ready;
    }

    for (const target of targetsSorted) {
      const slug = target.systemtraderSlug;
      const portfolioId = target.id;

      const prep = await ensureSlugPrepared(slug);
      if (prep.kind !== "ready") {
        continue;
      }

      const { scrapedData, scaledActions } = prep;
      const signalDate = scrapedData.date.trim();

      if (!shouldProcess(signalDate, target.lastProcessedDate)) {
        console.log(
          `Portfolio ${portfolioId}: already processed ${signalDate} for "${slug}", skipping`
        );
        continue;
      }

      console.log(`Portfolio ${portfolioId}: processing ${signalDate} (${slug})`);

      let tradeSummary;
      try {
        tradeSummary = await executeTradesFromActions(scaledActions, portfolioId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        encounteredErrors.push(
          `Portfolio ${portfolioId} (${slug}) execution failed: ${errorMessage}`
        );
        console.error(
          `Portfolio ${portfolioId}: execution failed for "${slug}":`,
          errorMessage
        );
        continue;
      }
      console.log(
        `Portfolio ${portfolioId}: ${tradeSummary.successful.length} successful, ${tradeSummary.failed.length} failed, ${tradeSummary.skipped.length} skipped`
      );

      if (tradeSummary.tradingDisabled) {
        console.log(
          `Portfolio ${portfolioId}: trading disabled in env — not marking ${signalDate} processed for "${slug}". Set TRADIER_ENABLE_TRADING=true or SCHWAB_ENABLE_TRADING=true and run again.`
        );
        continue;
      }

      const timestamp = new Date(signalDate).getTime();
      try {
        await writePortfolioProcessedState(portfolioId, signalDate, timestamp, slug);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        encounteredErrors.push(
          `Portfolio ${portfolioId} (${slug}) failed to save processed state: ${errorMessage}`
        );
        console.error(
          `Portfolio ${portfolioId}: could not persist processed state for "${slug}":`,
          errorMessage
        );
        continue;
      }

      target.lastProcessedDate = signalDate;
      target.lastProcessedTimestamp = timestamp;

      const notifyKey = `${slug}:${signalDate}`;
      if (!notifiedSlugDate.has(notifyKey)) {
        try {
          const processedSignals = processedSignalsFromActions(scrapedData);
          await sendNotification(processedSignals);
          notifiedSlugDate.add(notifyKey);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          encounteredErrors.push(`Strategy "${slug}" notification failed: ${errorMessage}`);
          console.error(`Strategy "${slug}": notification failed:`, errorMessage);
        }
      }
      console.log(
        `Portfolio ${portfolioId}: marked ${signalDate} processed for "${slug}"`
      );
    }
    if (encounteredErrors.length > 0) {
      throw new Error(
        `Daily check completed with ${encounteredErrors.length} error(s): ${encounteredErrors.join(" | ")}`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in daily check:", errorMessage);
    throw error;
  }
}

export async function runCheckForPortfolio(portfolioId: number): Promise<void> {
  if (!Number.isInteger(portfolioId) || portfolioId <= 0) {
    throw new Error("Invalid portfolio id");
  }
  await runCheck({ portfolioIds: [portfolioId] });
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

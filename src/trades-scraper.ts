import type { Page } from "puppeteer";
import { withScrapePage } from "./scraper-auth";
import {
  parseAndNormalizeSystemTraderSlug,
  resolveSystemTraderTradesUrl,
} from "./state";
import type { ScrapedStrategyTrades, StrategyTrade } from "./types";

export { closeBrowser } from "./scraper-auth";

export interface ScrapeStrategyTradesOptions {
  since?: string;
}

async function clickAllTradesTab(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll("button, a, [role='tab'], [role='button'], span, div")
    );
    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (text === "all trades") {
        (el as HTMLElement).click();
        return true;
      }
    }
    for (const el of candidates) {
      const text = (el.textContent || "").trim().toLowerCase();
      if (text.includes("all trades") && text.length < 30) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
  if (!clicked) {
    throw new Error('Could not find "All Trades" tab on trades page');
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function parseTradesPage(page: Page): Promise<{
  lastUpdated: string | null;
  trades: Array<{
    date: string;
    symbol: string;
    action: "BUY" | "SELL";
    shares: number;
    price: number;
    buyKind?: "enter" | "add";
    sellKind?: "exit" | "decrease";
  }>;
}> {
  return page.evaluate(() => {
    const doc = document;
    let lastUpdated: string | null = null;
    const bodyText = doc.body?.textContent || "";
    const lastUpdatedMatch = bodyText.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/i);
    if (lastUpdatedMatch) {
      lastUpdated = lastUpdatedMatch[1];
    }

    const trades: Array<{
      date: string;
      symbol: string;
      action: "BUY" | "SELL";
      shares: number;
      price: number;
      buyKind?: "enter" | "add";
      sellKind?: "exit" | "decrease";
    }> = [];

    const tables = Array.from(doc.querySelectorAll("table"));
    let tradesTable: HTMLTableElement | null = null;

    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll("th"));
      const headerTexts = headers.map((h) =>
        (h.textContent?.toLowerCase().trim() || "").replace(/[↓↑▲▼]/g, "").trim()
      );
      const hasDate = headerTexts.some(
        (h) => h === "date" || h.startsWith("date") || h.includes("trade date")
      );
      const hasSymbol = headerTexts.some((h) => h === "symbol");
      const hasAction = headerTexts.some((h) => h === "action" || h === "type");
      const hasShares = headerTexts.some(
        (h) => h === "shares" || h === "# shares" || h.includes("share")
      );
      const hasPrice = headerTexts.some(
        (h) => h.includes("price") || h.includes("open") || h === "cost"
      );
      const isRoundTrips = headerTexts.some((h) => h === "entry" || h === "exit");
      if (isRoundTrips) continue;
      if (hasDate && hasSymbol && hasAction && (hasShares || hasPrice)) {
        tradesTable = table;
        break;
      }
    }

    if (!tradesTable) {
      return { lastUpdated, trades: [] };
    }

    const rows = Array.from(tradesTable.querySelectorAll("tbody tr, tr"));
    const headerRow = rows[0];
    if (!headerRow) {
      return { lastUpdated, trades: [] };
    }

    const headerCells = Array.from(headerRow.querySelectorAll("th, td"));
    const findIndex = (pred: (text: string) => boolean): number =>
      headerCells.findIndex((cell) => {
        const raw = cell.textContent?.toLowerCase().trim() || "";
        const text = raw.replace(/[↓↑▲▼]/g, "").trim();
        return pred(text);
      });

    const dateIndex = findIndex(
      (t) => t === "date" || t.startsWith("date") || t.includes("trade date") || t === "day"
    );
    const symbolIndex = findIndex((t) => t === "symbol");
    const actionIndex = findIndex((t) => t === "action" || t === "type");
    const sharesIndex = findIndex(
      (t) => t === "shares" || t === "# shares" || (t.includes("share") && !t.includes("after"))
    );
    const priceIndex = findIndex(
      (t) =>
        t.includes("open price") ||
        t === "price" ||
        t.includes("open") ||
        t === "cost"
    );

    if (dateIndex === -1 || symbolIndex === -1 || actionIndex === -1) {
      return { lastUpdated, trades: [] };
    }

    for (let i = 1; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll("td"));
      if (cells.length === 0) continue;

      const dateText = cells[dateIndex]?.textContent?.trim() || "";
      const symbolCell = cells[symbolIndex];
      const actionText = cells[actionIndex]?.textContent?.trim() || "";
      const sharesText =
        sharesIndex >= 0 ? cells[sharesIndex]?.textContent?.trim() || "" : "";
      const priceText =
        priceIndex >= 0 ? cells[priceIndex]?.textContent?.trim() || "" : "";

      const dateMatch = dateText.match(/\d{4}-\d{2}-\d{2}/);
      if (!dateMatch) continue;

      const symbolLink = symbolCell?.querySelector("a");
      const symbol = (symbolLink?.textContent?.trim() || symbolCell?.textContent?.trim() || "")
        .toUpperCase()
        .replace(/[^A-Z0-9.-]/g, "");
      if (!symbol) continue;

      const actionUpper = actionText.toUpperCase().trim();
      let action: "BUY" | "SELL";
      let buyKind: "enter" | "add" | undefined;
      let sellKind: "exit" | "decrease" | undefined;

      if (
        actionUpper === "BUY" ||
        actionUpper === "ENTER" ||
        actionUpper === "INCREASE"
      ) {
        action = "BUY";
        buyKind = actionUpper === "INCREASE" ? "add" : "enter";
      } else if (
        actionUpper === "SELL" ||
        actionUpper === "EXIT" ||
        actionUpper === "DECREASE"
      ) {
        action = "SELL";
        sellKind = actionUpper === "DECREASE" ? "decrease" : "exit";
      } else {
        continue;
      }

      const shares = Math.abs(parseInt(sharesText.replace(/[+,\s]/g, ""), 10));
      const price = parseFloat(priceText.replace(/[$,\s]/g, ""));
      if (isNaN(shares) || shares === 0) continue;
      if (isNaN(price) || price <= 0) continue;

      trades.push({
        date: dateMatch[0],
        symbol,
        action,
        shares,
        price,
        buyKind,
        sellKind,
      });
    }

    return { lastUpdated, trades };
  });
}

export async function scrapeStrategyTrades(
  slug: string,
  options: ScrapeStrategyTradesOptions = {}
): Promise<ScrapedStrategyTrades> {
  const normalizedSlug = parseAndNormalizeSystemTraderSlug(slug);
  const tradesUrl = resolveSystemTraderTradesUrl(normalizedSlug);

  const scraped = await withScrapePage(
    `Scraping strategy trades from ${tradesUrl}`,
    tradesUrl,
    async (page) => {
      await page.goto(tradesUrl, {
        waitUntil: "networkidle2",
        timeout: 45000,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await clickAllTradesTab(page);
      return parseTradesPage(page);
    }
  );

  let trades: StrategyTrade[] = scraped.trades.map((t) => ({
    date: t.date,
    symbol: t.symbol,
    action: t.action,
    shares: t.shares,
    price: t.price,
    buyKind: t.buyKind,
    sellKind: t.sellKind,
  }));

  if (options.since) {
    const since = options.since.trim();
    trades = trades.filter((t) => t.date >= since);
  }

  console.log(
    `Scraped ${trades.length} strategy trade(s) for "${normalizedSlug}"` +
      (scraped.lastUpdated ? ` (last updated ${scraped.lastUpdated})` : "")
  );

  return {
    slug: normalizedSlug,
    lastUpdated: scraped.lastUpdated,
    trades,
  };
}

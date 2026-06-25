import type { Page } from "puppeteer";
import {
  closeBrowser,
  withScrapePage,
} from "./scraper-auth";
import { ScrapedPortfolioData, PortfolioAction } from "./types";

export { closeBrowser };

function extractDate(): string {
  const today = new Date();
  return today.toISOString().split("T")[0];
}

async function scrapePortfolioActionsFromPage(page: Page): Promise<PortfolioAction[]> {
  const rawActions = await page.evaluate(() => {
    // @ts-ignore - document is available in browser context
    const doc: Document = typeof document !== "undefined" ? document : (null as unknown as Document);
    const results: Array<{
      symbol: string;
      action: string;
      shares: number;
      price: number;
      buyKind?: "enter" | "add";
      sellKind?: "exit" | "decrease";
    }> = [];

    const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, caption, th"));
    let actionsTable: HTMLTableElement | null = null;

    for (const heading of headings) {
      const text = heading.textContent?.toLowerCase() || "";
      if (text.includes("today's actions") || text.includes("todays actions")) {
        let element: Element | null = heading;
        for (let i = 0; i < 10; i++) {
          element = element?.nextElementSibling || null;
          if (element && element.tagName === "TABLE") {
            actionsTable = element as HTMLTableElement;
            break;
          }
          if (element) {
            const table = element.querySelector("table");
            if (table) {
              actionsTable = table as HTMLTableElement;
              break;
            }
          }
        }
        break;
      }
    }

    if (!actionsTable) {
      const allTables = Array.from(doc.querySelectorAll("table"));
      for (const table of allTables) {
        const headers = Array.from(table.querySelectorAll("th"));
        const headerTexts = headers.map((h) => h.textContent?.toLowerCase() || "").join(" ");
        if (
          headerTexts.includes("action") &&
          headerTexts.includes("change") &&
          headerTexts.includes("open price")
        ) {
          actionsTable = table;
          break;
        }
      }
    }

    if (!actionsTable) {
      return results;
    }

    const rows = Array.from(actionsTable.querySelectorAll("tbody tr, tr"));
    const headerRow = rows[0];
    if (!headerRow) {
      return results;
    }

    const headerCells = Array.from(headerRow.querySelectorAll("th, td"));
    const symbolIndex = headerCells.findIndex(
      (cell) => cell.textContent?.toLowerCase().trim() === "symbol"
    );
    const actionIndex = headerCells.findIndex(
      (cell) => cell.textContent?.toLowerCase().trim() === "action"
    );
    const changeIndex = headerCells.findIndex((cell) => {
      const text = cell.textContent?.toLowerCase().trim() || "";
      return text === "change" && !text.includes("price") && !text.includes("close");
    });
    const priceIndex = headerCells.findIndex((cell) => {
      const text = cell.textContent?.toLowerCase().trim() || "";
      return text.includes("open price");
    });

    if (symbolIndex === -1 || actionIndex === -1 || changeIndex === -1 || priceIndex === -1) {
      return results;
    }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length === 0) continue;

      const symbolCell = cells[symbolIndex];
      const actionCell = cells[actionIndex];
      const changeCell = cells[changeIndex];
      const priceCell = cells[priceIndex];
      if (!symbolCell || !actionCell || !changeCell || !priceCell) continue;

      const symbolText = symbolCell.textContent?.trim() || "";
      const actionText = actionCell.textContent?.trim() || "";
      const changeText = changeCell.textContent?.trim() || "";
      const priceText = priceCell.textContent?.trim() || "";
      if (!symbolText || !actionText || !changeText || !priceText) continue;

      const symbolLink = symbolCell.querySelector("a");
      const symbol = (symbolLink?.textContent?.trim() || symbolText).toUpperCase();
      if (symbol === "PORTFOLIO" || symbol === "") continue;

      const action = actionText.toUpperCase().trim();
      if (action !== "BUY" && action !== "SELL" && action !== "INCREASE" && action !== "DECREASE") {
        continue;
      }

      const normalizedAction = action === "BUY" || action === "INCREASE" ? "BUY" : "SELL";
      const sharesText = changeText.replace(/[+,\s]/g, "").trim();
      const shares = Math.abs(parseInt(sharesText, 10));
      const priceTextClean = priceText.replace(/[$,\s]/g, "").trim();
      const price = parseFloat(priceTextClean);

      if (isNaN(shares) || isNaN(price) || shares === 0 || price <= 0) continue;

      results.push({
        symbol,
        action: normalizedAction,
        shares,
        price,
        buyKind:
          normalizedAction === "BUY" ? (action === "INCREASE" ? "add" : "enter") : undefined,
        sellKind:
          normalizedAction === "SELL" ? (action === "DECREASE" ? "decrease" : "exit") : undefined,
      });
    }

    return results;
  });

  return (Array.isArray(rawActions) ? rawActions : []).map((a) => ({
    symbol: a.symbol,
    action: a.action as "BUY" | "SELL",
    shares: a.shares,
    price: a.price,
    buyKind:
      a.action === "BUY" ? (a.buyKind === "add" ? "add" : "enter") : undefined,
    sellKind:
      a.action === "SELL" ? (a.sellKind === "decrease" ? "decrease" : "exit") : undefined,
  }));
}

export async function scrapePortfolioData(
  portfolioUrl: string
): Promise<ScrapedPortfolioData> {
  return withScrapePage(
    `Scraping portfolio data from ${portfolioUrl}`,
    portfolioUrl,
    async (page) => {
      await page.goto(portfolioUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const actions = await scrapePortfolioActionsFromPage(page);
      const date = extractDate();
      console.log(`Scraped ${actions.length} actions for date ${date}`);
      return { date, actions };
    }
  );
}

import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer";
import { ScrapedPortfolioData, PortfolioAction } from "./types";

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || "1000", 10);
const HEADLESS = process.env.PUPPETEER_HEADLESS !== "false";
/** Use system Chrome/Chromium when set (e.g. in Docker: install chromium and set to /usr/bin/chromium). */
const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

function getSignInUrl(portfolioUrl: string): string {
  const base = new URL(portfolioUrl).origin;
  const callbackPath = new URL(portfolioUrl).pathname;
  return `${base}/signin?callbackUrl=${encodeURIComponent(callbackPath)}`;
}

const LOGIN_PASSWORD_SELECTOR_CANDIDATES = [
  'input[type="password"]',
  'input[name="password" i]',
  'input[id="password" i]',
] as const;

/**
 * Prefer name/autocomplete/text fields first: sites often keep a hidden `type="email"` duplicate
 * that passes boundingBox but fails `waitForSelector(..., { visible: true })`.
 */
const LOGIN_EMAIL_SELECTOR_CANDIDATES = [
  'input[name="email" i]',
  'input[id="email" i]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[type="text"][name*="mail" i]',
  'input[type="text"][placeholder*="mail" i]',
  'input[type="email"]',
] as const;

const SIGN_IN_NAV_STEPS = 15;

function pathnameNormalized(url: string): string {
  try {
    let p = new URL(url).pathname.toLowerCase();
    if (p.length > 1 && p.endsWith("/")) {
      p = p.slice(0, -1);
    }
    return p;
  } catch {
    return "";
  }
}

function desiredPortfolioPathname(portfolioUrl: string): string {
  return pathnameNormalized(portfolioUrl);
}

async function fieldIsUsableForTyping(
  page: Page,
  handle: ElementHandle<Element>
): Promise<boolean> {
  try {
    return await page.evaluate((el: Element) => {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) < 0.05) {
        return false;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) {
        return false;
      }
      const input = el as HTMLInputElement;
      if (input.disabled || input.readOnly) {
        return false;
      }
      return true;
    }, handle);
  } catch {
    return false;
  }
}

async function detectLoginForm(
  page: Page
): Promise<{ emailSel: string; passwordSel: string } | null> {
  for (const emailSel of LOGIN_EMAIL_SELECTOR_CANDIDATES) {
    const emailHandle = await page.$(emailSel);
    if (!emailHandle || !(await fieldIsUsableForTyping(page, emailHandle))) {
      continue;
    }
    for (const passwordSel of LOGIN_PASSWORD_SELECTOR_CANDIDATES) {
      const passHandle = await page.$(passwordSel);
      if (passHandle && (await fieldIsUsableForTyping(page, passHandle))) {
        return { emailSel, passwordSel };
      }
    }
  }
  return null;
}

async function navigateToUrl(page: Page, targetUrl: string, portfolioUrl: string): Promise<void> {
  const want = desiredPortfolioPathname(portfolioUrl);
  const u = new URL(targetUrl);
  u.searchParams.set("_nav", String(Date.now()));
  const href = u.toString();
  await page.goto(href, { waitUntil: "load", timeout: 45000 });
  await sleep(2800);

  const here = pathnameNormalized(page.url());
  const targetPath = pathnameNormalized(u.pathname);
  if (
    targetPath === want &&
    (here === "/profile" || here.startsWith("/profile/"))
  ) {
    console.log("Still on /profile after goto; forcing location.assign to portfolio");
    await page.evaluate((dest: string) => {
      window.location.assign(dest);
    }, href);
    await sleep(3500);
  }
}

async function submitLoginCredentials(
  page: Page,
  email: string,
  password: string,
  emailSel: string,
  passwordSel: string
): Promise<void> {
  console.log(`[scraper] submitting login (email: ${emailSel}, password: ${passwordSel})`);
  await page.waitForSelector(emailSel, { timeout: 20000 });
  await page.waitForSelector(passwordSel, { timeout: 15000 });
  await page.evaluate((sel: string) => {
    document.querySelector(sel)?.scrollIntoView({ block: "center", inline: "nearest" });
  }, emailSel);
  await page.evaluate((sel: string) => {
    document.querySelector(sel)?.scrollIntoView({ block: "center", inline: "nearest" });
  }, passwordSel);

  await page.type(emailSel, email, { delay: 50 });
  await page.type(passwordSel, password, { delay: 50 });

  const submit =
    (await page.$('button[type="submit"]')) ||
    (await page.$('input[type="submit"]'));
  if (submit) {
    await submit.click();
  } else {
    const buttons = await page.$$("button, [role='button']");
    let clicked = false;
    for (const btn of buttons) {
      const text = await page.evaluate((el) => (el as HTMLElement).textContent?.toLowerCase() || "", btn);
      if (text.includes("sign in")) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) throw new Error("Could not find Sign In submit button");
  }

  await Promise.race([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Login navigation timeout")), 15000)),
  ]).catch(() => {
    // Navigation might have completed already; continue
  });
  await sleep(1000);
}

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
      headless: HEADLESS,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    };
    if (EXECUTABLE_PATH) {
      launchOptions.executablePath = EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOptions);
  }
  return browser;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

function parsePrice(priceText: string): number {
  const cleaned = priceText.replace(/[$,\s]/g, "");
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed)) {
    throw new Error(`Invalid price format: ${priceText}`);
  }
  return parsed;
}

function parseShares(changeText: string): number {
  const cleaned = changeText.replace(/[+,\s]/g, "");
  const parsed = parseInt(cleaned, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid shares format: ${changeText}`);
  }
  return Math.abs(parsed);
}

function extractDate(page: Page): string {
  const today = new Date();
  return today.toISOString().split("T")[0];
}

/** Performs sign-in on the page so subsequent navigation to portfolio is authenticated. */
async function signIn(
  page: Page,
  email: string,
  password: string,
  portfolioUrl: string
): Promise<void> {
  const signInUrl = getSignInUrl(portfolioUrl);
  const wantPath = desiredPortfolioPathname(portfolioUrl);

  console.log("Signing in before scrape… [scraper login logic: interactable-field detection]");
  await navigateToUrl(page, signInUrl, portfolioUrl);

  for (let step = 0; step < SIGN_IN_NAV_STEPS; step++) {
    const here = pathnameNormalized(page.url());
    let form = await detectLoginForm(page);
    if (!form) {
      await sleep(500);
      form = await detectLoginForm(page);
    }

    if (here === wantPath && !form) {
      return;
    }

    if (form) {
      await submitLoginCredentials(page, email, password, form.emailSel, form.passwordSel);
      await navigateToUrl(page, portfolioUrl, portfolioUrl);
      continue;
    }

    const atProfile = here === "/profile" || here.startsWith("/profile/");
    const atSettings = here === "/settings" || here.startsWith("/settings/");
    const atSignin = here.endsWith("/signin") || here.includes("/signin");

    if (atProfile || atSettings) {
      console.log(
        `Wrong page for scrape (${page.url()}); navigating to portfolio ${portfolioUrl}`
      );
      await navigateToUrl(page, portfolioUrl, portfolioUrl);
      continue;
    }

    if (!atSignin && here !== wantPath && here !== "") {
      console.log(
        `Unexpected path "${here}" (${page.url()}); navigating to portfolio ${portfolioUrl}`
      );
      await navigateToUrl(page, portfolioUrl, portfolioUrl);
      continue;
    }

    if (atSignin) {
      if (step % 2 === 1) {
        console.log(
          `Sign-in page has no usable login fields; opening portfolio (${page.url()}, step ${step + 1})`
        );
        await navigateToUrl(page, portfolioUrl, portfolioUrl);
      } else {
        console.log(`Reloading sign-in URL (step ${step + 1})`);
        await navigateToUrl(page, signInUrl, portfolioUrl);
      }
      await sleep(800);
      continue;
    }

    console.log(`Navigating to portfolio from ${page.url()} (step ${step + 1})`);
    await navigateToUrl(page, portfolioUrl, portfolioUrl);
  }

  const last = page.url();
  if (pathnameNormalized(last) !== wantPath) {
    throw new Error(
      `Could not land on portfolio path "${wantPath}" after ${SIGN_IN_NAV_STEPS} navigation steps (last URL: ${last})`
    );
  }
}

export async function scrapePortfolioData(
  portfolioUrl: string
): Promise<ScrapedPortfolioData> {
  const loginEmail = process.env.LOGIN_EMAIL || "";
  const loginPassword = process.env.LOGIN_PASSWORD || "";
  if (!loginEmail.trim() || !loginPassword) {
    throw new Error(
      "LOGIN_EMAIL and LOGIN_PASSWORD environment variables are required to access the portfolio."
    );
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page: Page | null = null;
    try {
      const browserInstance = await getBrowser();
      page = await browserInstance.newPage();

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );

      console.log(`Scraping portfolio data from ${portfolioUrl} (attempt ${attempt})...`);

      await signIn(page, loginEmail, loginPassword, portfolioUrl);

      await page.goto(portfolioUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const rawActions = await page.evaluate(() => {
        // This code runs in the browser context - DOM types are available at runtime
        // @ts-ignore - document is available in browser context
        const doc: any = typeof document !== 'undefined' ? document : null;
        const results: Array<{
          symbol: string;
          action: string;
          shares: number;
          price: number;
          buyKind?: "enter" | "add";
          sellKind?: "exit" | "decrease";
        }> = [];

        const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, caption, th"));
        let actionsTable: any = null;

        for (const heading of headings) {
          const text = (heading as any).textContent?.toLowerCase() || "";
          if (text.includes("today's actions") || text.includes("todays actions")) {
            let element: any = heading;
            for (let i = 0; i < 10; i++) {
              element = element?.nextElementSibling || null;
              if (element && element.tagName === "TABLE") {
                actionsTable = element;
                break;
              }
              if (element) {
                const table = element.querySelector("table");
                if (table && table.tagName === "TABLE") {
                  actionsTable = table;
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
            const headers = Array.from((table as any).querySelectorAll("th"));
            const headerTexts = headers.map((h: any) => h.textContent?.toLowerCase() || "").join(" ");
            if (headerTexts.includes("action") && headerTexts.includes("change") && headerTexts.includes("open price")) {
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

        const headerCells = Array.from((headerRow as any).querySelectorAll("th, td"));
        const symbolIndex = headerCells.findIndex(
          (cell: any) => cell.textContent?.toLowerCase().trim() === "symbol"
        );
        const actionIndex = headerCells.findIndex(
          (cell: any) => cell.textContent?.toLowerCase().trim() === "action"
        );
        const changeIndex = headerCells.findIndex(
          (cell: any) => {
            const text = cell.textContent?.toLowerCase().trim() || "";
            return text === "change" && !text.includes("price") && !text.includes("close");
          }
        );
        const priceIndex = headerCells.findIndex(
          (cell: any) => {
            const text = cell.textContent?.toLowerCase().trim() || "";
            return text.includes("open price");
          }
        );

        if (symbolIndex === -1 || actionIndex === -1 || changeIndex === -1 || priceIndex === -1) {
          return results;
        }

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i] as any;
          const cells = Array.from(row.querySelectorAll("td"));

          if (cells.length === 0) {
            continue;
          }

          const symbolCell = cells[symbolIndex];
          const actionCell = cells[actionIndex];
          const changeCell = cells[changeIndex];
          const priceCell = cells[priceIndex];

          if (!symbolCell || !actionCell || !changeCell || !priceCell) {
            continue;
          }

          const symbolText = (symbolCell as any).textContent?.trim() || "";
          const actionText = (actionCell as any).textContent?.trim() || "";
          const changeText = (changeCell as any).textContent?.trim() || "";
          const priceText = (priceCell as any).textContent?.trim() || "";

          if (!symbolText || !actionText || !changeText || !priceText) {
            continue;
          }

          const symbolLink = (symbolCell as any).querySelector("a");
          const symbol = (symbolLink?.textContent?.trim() || symbolText).toUpperCase();

          if (symbol === "PORTFOLIO" || symbol === "") {
            continue;
          }

          try {
            const action = actionText.toUpperCase().trim();
            if (action !== "BUY" && action !== "SELL" && action !== "INCREASE" && action !== "DECREASE") {
              continue;
            }

            const normalizedAction = action === "BUY" || action === "INCREASE" ? "BUY" : "SELL";
            
            const sharesText = changeText.replace(/[+,\s]/g, "").trim();
            const shares = Math.abs(parseInt(sharesText, 10));
            
            const priceTextClean = priceText.replace(/[$,\s]/g, "").trim();
            const price = parseFloat(priceTextClean);

            if (isNaN(shares) || isNaN(price) || shares === 0 || price <= 0) {
              continue;
            }

            results.push({
              symbol,
              action: normalizedAction,
              shares,
              price,
              buyKind:
                normalizedAction === "BUY"
                  ? action === "INCREASE"
                    ? "add"
                    : "enter"
                  : undefined,
              sellKind:
                normalizedAction === "SELL"
                  ? action === "DECREASE"
                    ? "decrease"
                    : "exit"
                  : undefined,
            });
          } catch (err) {
            console.warn(`Error parsing row for ${symbolText}:`, err);
          }
        }

        return results;
      });

      const actions = Array.isArray(rawActions) ? rawActions : [];

      const date = extractDate(page);

      await page.close();

      const portfolioActions: PortfolioAction[] = actions.map((a) => ({
        symbol: a.symbol,
        action: a.action as "BUY" | "SELL",
        shares: a.shares,
        price: a.price,
        buyKind:
          a.action === "BUY"
            ? a.buyKind === "add"
              ? "add"
              : "enter"
            : undefined,
        sellKind:
          a.action === "SELL"
            ? a.sellKind === "decrease"
              ? "decrease"
              : "exit"
            : undefined,
      }));

      console.log(`Scraped ${portfolioActions.length} actions for date ${date}`);

      return {
        date,
        actions: portfolioActions,
      };
    } catch (error) {
      if (page) {
        try {
          await page.close();
        } catch (closeError) {
          console.error("Error closing page:", closeError);
        }
      }

      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`Scrape attempt ${attempt} failed:`, lastError.message);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Failed to scrape portfolio data after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

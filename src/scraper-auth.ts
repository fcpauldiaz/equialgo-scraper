import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer";

export const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
export const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || "1000", 10);
export const HEADLESS = process.env.PUPPETEER_HEADLESS !== "false";
export const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const LOGIN_PASSWORD_SELECTOR_CANDIDATES = [
  'input[type="password"]',
  'input[name="password" i]',
  'input[id="password" i]',
] as const;

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

let browser: Browser | null = null;

export function getSignInUrl(targetUrl: string): string {
  const base = new URL(targetUrl).origin;
  const callbackPath = new URL(targetUrl).pathname;
  return `${base}/signin?callbackUrl=${encodeURIComponent(callbackPath)}`;
}

export function pathnameNormalized(url: string): string {
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

export function desiredPathname(targetUrl: string): string {
  return pathnameNormalized(targetUrl);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
      headless: HEADLESS,
      protocolTimeout: 60000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-translate",
        "--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess",
        "--disable-breakpad",
      ],
    };
    if (EXECUTABLE_PATH) {
      launchOptions.executablePath = EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOptions);
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export function requireLoginCredentials(): { email: string; password: string } {
  const email = process.env.LOGIN_EMAIL || "";
  const password = process.env.LOGIN_PASSWORD || "";
  if (!email.trim() || !password) {
    throw new Error(
      "LOGIN_EMAIL and LOGIN_PASSWORD environment variables are required to access SystemTrader."
    );
  }
  return { email, password };
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

export async function navigateToUrl(
  page: Page,
  targetUrl: string,
  destinationUrl: string
): Promise<void> {
  const want = desiredPathname(destinationUrl);
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
    console.log("Still on /profile after goto; forcing location.assign to destination");
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
      const text = await page.evaluate(
        (el) => (el as HTMLElement).textContent?.toLowerCase() || "",
        btn
      );
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

export async function signInToUrl(
  page: Page,
  email: string,
  password: string,
  destinationUrl: string
): Promise<void> {
  const signInUrl = getSignInUrl(destinationUrl);
  const wantPath = desiredPathname(destinationUrl);

  console.log("Signing in before scrape… [scraper login logic: interactable-field detection]");
  await navigateToUrl(page, signInUrl, destinationUrl);

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
      await navigateToUrl(page, destinationUrl, destinationUrl);
      continue;
    }

    const atProfile = here === "/profile" || here.startsWith("/profile/");
    const atSettings = here === "/settings" || here.startsWith("/settings/");
    const atSignin = here.endsWith("/signin") || here.includes("/signin");

    if (atProfile || atSettings) {
      console.log(
        `Wrong page for scrape (${page.url()}); navigating to ${destinationUrl}`
      );
      await navigateToUrl(page, destinationUrl, destinationUrl);
      continue;
    }

    if (!atSignin && here !== wantPath && here !== "") {
      console.log(
        `Unexpected path "${here}" (${page.url()}); navigating to ${destinationUrl}`
      );
      await navigateToUrl(page, destinationUrl, destinationUrl);
      continue;
    }

    if (atSignin) {
      if (step % 2 === 1) {
        console.log(
          `Sign-in page has no usable login fields; opening destination (${page.url()}, step ${step + 1})`
        );
        await navigateToUrl(page, destinationUrl, destinationUrl);
      } else {
        console.log(`Reloading sign-in URL (step ${step + 1})`);
        await navigateToUrl(page, signInUrl, destinationUrl);
      }
      await sleep(800);
      continue;
    }

    console.log(`Navigating to destination from ${page.url()} (step ${step + 1})`);
    await navigateToUrl(page, destinationUrl, destinationUrl);
  }

  const last = page.url();
  if (pathnameNormalized(last) !== wantPath) {
    throw new Error(
      `Could not land on path "${wantPath}" after ${SIGN_IN_NAV_STEPS} navigation steps (last URL: ${last})`
    );
  }
}

export async function withScrapePage<T>(
  label: string,
  destinationUrl: string,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  const { email, password } = requireLoginCredentials();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let page: Page | null = null;
    try {
      const browserInstance = await getBrowser();
      page = await browserInstance.newPage();
      await page.setUserAgent(DEFAULT_USER_AGENT);
      console.log(`${label} (attempt ${attempt})...`);
      await signInToUrl(page, email, password, destinationUrl);
      const result = await fn(page);
      await page.close();
      return result;
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
    `Failed after ${MAX_RETRIES} attempts: ${lastError?.message}`
  );
}

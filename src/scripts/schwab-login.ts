/**
 * Schwab OAuth login script.
 * Uses the shared OAuth flow for portfolio id 1 (Default), opens the browser.
 *
 * Prerequisites in .env: SCHWAB_CLIENT_ID, SCHWAB_CLIENT_SECRET, DATABASE_URL, DATABASE_AUTH_TOKEN
 * Callback URL in Schwab app must be: https://127.0.0.1:8765/callback
 *
 * Run: pnpm run build && pnpm run schwab-login
 */

import "dotenv/config";
import { exec } from "child_process";
import { initializeDatabase } from "../state";
import { startSchwabLoginFlow } from "../schwab-oauth";

const DEFAULT_PORTFOLIO_ID = 1;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.warn("Could not open browser:", err.message);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_AUTH_TOKEN) {
    console.error(
      "Missing DATABASE_URL or DATABASE_AUTH_TOKEN in .env (required to save credentials to the database)"
    );
    process.exit(1);
  }

  await initializeDatabase();

  const redirectUri = `https://127.0.0.1:${process.env.SCHWAB_REDIRECT_PORT || "8765"}/callback`;
  console.log("Using redirect URI:", redirectUri);
  console.log(
    "Ensure this exact URI is added to your Schwab app's callback URLs.\n"
  );

  const { authUrl, flowComplete } =
    await startSchwabLoginFlow(DEFAULT_PORTFOLIO_ID);
  console.log("HTTPS server listening at", redirectUri);
  console.log("Opening browser for Schwab login...");
  console.log(
    "If the browser warns about the certificate, choose Advanced → Proceed to 127.0.0.1 (self-signed cert is expected)."
  );
  console.log(
    "Complete sign-in in the browser; you will be redirected back here. Do not close this terminal.\n"
  );
  openBrowser(authUrl);
  await flowComplete;
  console.log("Credentials saved to the database.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

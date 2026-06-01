import { PortfolioAction } from "../types";

/** Mars strategy actions scraped for 2026-05-29 (from production scale logs). */
export const mars20260529Actions: PortfolioAction[] = [
  { symbol: "AAOI", action: "SELL", shares: 1645, price: 181.0, sellKind: "exit" },
  { symbol: "USO", action: "SELL", shares: 24, price: 133.34, sellKind: "decrease" },
  { symbol: "XOM", action: "SELL", shares: 20, price: 149.34, sellKind: "decrease" },
  { symbol: "WOLF", action: "BUY", shares: 4536, price: 62.8, buyKind: "enter" },
  { symbol: "AXTI", action: "BUY", shares: 76, price: 129.33, buyKind: "add" },
  { symbol: "GLW", action: "BUY", shares: 34, price: 192.17, buyKind: "add" },
  { symbol: "SLV", action: "BUY", shares: 38, price: 66.55, buyKind: "add" },
];

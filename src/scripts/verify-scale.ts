import { scaleActionsToPortfolioSize } from "../processor";
import { mars20260529Actions } from "../fixtures/mars-2026-05-29";

const TARGET = 10_000;

function buyNotional(
  actions: ReturnType<typeof scaleActionsToPortfolioSize>
): number {
  return actions
    .filter((a) => a.action === "BUY" && a.price > 0 && a.shares > 0)
    .reduce((sum, a) => sum + a.shares * a.price, 0);
}

function sharesFor(
  actions: ReturnType<typeof scaleActionsToPortfolioSize>,
  symbol: string
): number {
  const row = actions.find((a) => a.symbol === symbol && a.action === "BUY");
  return row?.shares ?? -1;
}

const scaled = scaleActionsToPortfolioSize(mars20260529Actions, TARGET);
const total = buyNotional(scaled);

const failures: string[] = [];

if (sharesFor(scaled, "WOLF") !== 39) {
  failures.push(`WOLF expected 39 shares, got ${sharesFor(scaled, "WOLF")}`);
}
if (sharesFor(scaled, "AXTI") !== 19) {
  failures.push(`AXTI expected 19 shares, got ${sharesFor(scaled, "AXTI")}`);
}
if (sharesFor(scaled, "GLW") !== 13) {
  failures.push(`GLW expected 13 shares, got ${sharesFor(scaled, "GLW")}`);
}
if (sharesFor(scaled, "SLV") !== 37) {
  failures.push(`SLV expected 37 shares, got ${sharesFor(scaled, "SLV")}`);
}
if (total > TARGET) {
  failures.push(`total buy notional $${total.toFixed(2)} exceeds $${TARGET}`);
}
if (sharesFor(scaled, "AXTI") === 0 || sharesFor(scaled, "GLW") === 0) {
  failures.push("INCREASE rows must not be zeroed when sharing buy slots");
}

function sellShares(symbol: string): number {
  const row = scaled.find((a) => a.symbol === symbol && a.action === "SELL");
  return row?.shares ?? -1;
}
if (sellShares("USO") < 1 || sellShares("XOM") < 1) {
  failures.push(
    `DECREASE rows expected >=1 share (USO=${sellShares("USO")}, XOM=${sellShares("XOM")})`
  );
}

if (failures.length > 0) {
  console.error("verify-scale FAILED:\n", failures.join("\n"));
  process.exit(1);
}

console.log(
  `verify-scale OK: Mars 2026-05-29 → WOLF=${sharesFor(scaled, "WOLF")} AXTI=${sharesFor(scaled, "AXTI")} GLW=${sharesFor(scaled, "GLW")} SLV=${sharesFor(scaled, "SLV")} total=$${total.toFixed(2)}`
);

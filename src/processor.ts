import { BacktestData, ProcessedSignals, Signal, ScrapedPortfolioData, PortfolioAction } from "./types";

const PORTFOLIO_SIZE = parseInt(process.env.PORTFOLIO_SIZE || "10000", 10);

export function processSignals(data: BacktestData): ProcessedSignals | null {
  if (!data.snapshots || data.snapshots.length === 0) {
    console.warn("No snapshots found in API response");
    return null;
  }

  const lastSnapshot = data.snapshots[data.snapshots.length - 1];

  if (!lastSnapshot.signals || lastSnapshot.signals.length === 0) {
    console.warn("No signals found in last snapshot");
    return null;
  }

  const enterSignals = lastSnapshot.signals.filter(
    (signal) => signal.action === "ENTER"
  );
  const keepSignals = lastSnapshot.signals.filter(
    (signal) => signal.action === "KEEP"
  );
  const exitSignals = lastSnapshot.signals.filter(
    (signal) => signal.action === "EXIT"
  );

  const activePositions = [...enterSignals, ...keepSignals];
  const totalPositions = activePositions.length;

  const enterSignalsWithShares = enterSignals.map((signal) => {
    const allocation = PORTFOLIO_SIZE / totalPositions;
    const shares = Math.floor(allocation / signal.current_price);

    return {
      ...signal,
      shares,
      allocation,
    };
  });

  const keepSignalsWithShares = keepSignals.map((signal) => {
    const allocation = PORTFOLIO_SIZE / totalPositions;
    const shares = Math.floor(allocation / signal.current_price);

    return {
      ...signal,
      shares,
      allocation,
    };
  });

  return {
    enterSignals: enterSignalsWithShares,
    keepSignals: keepSignalsWithShares,
    exitSignals,
    date: lastSnapshot.date,
  };
}

export function scaleActionsToPortfolioSize(
  actions: PortfolioAction[],
  targetPortfolioSize: number
): PortfolioAction[] {
  if (actions.length === 0) {
    return actions;
  }

  const enterBuys = actions.filter(
    (a) => a.action === "BUY" && a.buyKind !== "add"
  );
  const allBuys = actions.filter((a) => a.action === "BUY");
  const numBuys = enterBuys.length;
  const allocationPerPosition =
    numBuys > 0 ? targetPortfolioSize / numBuys : targetPortfolioSize;

  let modelNotional = 0;
  let proxyScaledBuyNotional = 0;
  for (const a of allBuys) {
    if (a.price > 0 && a.shares > 0) {
      modelNotional += a.shares * a.price;
      const scaledShares =
        a.buyKind === "add"
          ? Math.max(0, Math.floor(a.shares))
          : Math.max(1, Math.floor(allocationPerPosition / a.price));
      proxyScaledBuyNotional += scaledShares * a.price;
    }
  }

  let rebalanceShareScale = 1;
  if (allBuys.length > 0 && modelNotional > 0) {
    if (enterBuys.length > 0) {
      rebalanceShareScale = proxyScaledBuyNotional / modelNotional;
    } else {
      rebalanceShareScale = targetPortfolioSize / modelNotional;
    }
  }

  const scaleMode =
    allBuys.length === 0
      ? "no_buys"
      : enterBuys.length > 0
        ? "scale_from_enter_proxy"
        : "scale_target_over_model_notional";

  console.log(
    `[scale] targetPortfolioSize=$${targetPortfolioSize.toFixed(2)} enterBuyRows=${enterBuys.length} ` +
      `allBuyRows=${allBuys.length} allocationPerEnter=$${allocationPerPosition.toFixed(2)} ` +
      `modelBuyNotional=$${modelNotional.toFixed(2)} proxyScaledBuyNotional=$${proxyScaledBuyNotional.toFixed(2)} ` +
      `rebalanceShareScale=${rebalanceShareScale.toFixed(8)} mode=${scaleMode}`
  );

  return actions.map((action) => {
    const rawShares = action.shares;
    if (action.action === "BUY" && action.buyKind === "add") {
      const scaled = Math.floor(action.shares * rebalanceShareScale);
      const out = Math.max(0, scaled);
      console.log(
        `[scale] ${action.symbol} INCREASE: floor(${rawShares} × ${rebalanceShareScale.toFixed(8)}) → ${out} sh @ $${action.price.toFixed(2)}`
      );
      return { ...action, shares: out };
    }
    if (action.action === "BUY") {
      const shares =
        action.price > 0
          ? Math.max(1, Math.floor(allocationPerPosition / action.price))
          : 1;
      console.log(
        `[scale] ${action.symbol} ENTER: max(1, floor($${allocationPerPosition.toFixed(2)} / $${action.price.toFixed(2)})) → ${shares} sh (scraped ${rawShares} sh)`
      );
      return { ...action, shares };
    }
    if (action.action === "SELL" && action.sellKind === "decrease") {
      const scaled = Math.floor(action.shares * rebalanceShareScale);
      const out = Math.max(0, scaled);
      console.log(
        `[scale] ${action.symbol} DECREASE: floor(${rawShares} × ${rebalanceShareScale.toFixed(8)}) → ${out} sh @ $${action.price.toFixed(2)}`
      );
      return { ...action, shares: out };
    }
    if (action.action === "SELL") {
      console.log(
        `[scale] ${action.symbol} SELL exit: ${rawShares} sh @ $${action.price.toFixed(2)} (no share scaling; execution uses min(signal, held))`
      );
      return { ...action };
    }
    return { ...action };
  });
}

export function processedSignalsFromActions(
  data: ScrapedPortfolioData
): ProcessedSignals {
  const scaledActions = scaleActionsToPortfolioSize(
    data.actions,
    PORTFOLIO_SIZE
  );
  const scaledBuyActions = scaledActions.filter((a) => a.action === "BUY");
  const scaledSellActions = scaledActions.filter((a) => a.action === "SELL");

  const enterSignals = scaledBuyActions.map((a, i) => ({
    symbol: a.symbol,
    action: "ENTER" as const,
    score: 0,
    rank: i + 1,
    current_price: a.price,
    shares: a.shares,
    allocation: a.shares * a.price,
  }));

  const exitSignals: Signal[] = scaledSellActions.map((a, i) => ({
    symbol: a.symbol,
    action: "EXIT" as const,
    score: 0,
    rank: i + 1,
    current_price: a.price,
  }));

  return {
    enterSignals,
    keepSignals: [],
    exitSignals,
    date: data.date,
  };
}

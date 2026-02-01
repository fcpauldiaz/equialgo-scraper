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

  const buyActions = actions.filter((a) => a.action === "BUY");
  const totalBuyValue = buyActions.reduce(
    (sum, a) => sum + a.shares * a.price,
    0
  );

  if (totalBuyValue === 0) {
    return actions;
  }

  const scalingFactor = targetPortfolioSize / totalBuyValue;

  return actions.map((action) => {
    const scaledShares = Math.floor(action.shares * scalingFactor);
    return {
      ...action,
      shares: scaledShares > 0 ? scaledShares : 1,
    };
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

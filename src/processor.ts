import { BacktestData, ProcessedSignals, Signal } from "./types";

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


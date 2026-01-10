import fetch from "node-fetch";
import { ProcessedSignals } from "./types";

const NTFY_TOPIC = process.env.NTFY_TOPIC || "fcpauldiaz_notifications";
const NTFY_BASE_URL = process.env.NTFY_BASE_URL || "https://ntfy.sh";
const NTFY_URL = `${NTFY_BASE_URL}/${NTFY_TOPIC}`;

function formatMessage(signals: ProcessedSignals): string {
  const lines: string[] = [];
  lines.push(`📊 EquiAlgo Signals - ${signals.date}\n`);

  if (signals.enterSignals.length > 0) {
    lines.push("🟢 ENTER Signals:");
    signals.enterSignals.forEach((signal) => {
      lines.push(
        `  • ${signal.symbol}: $${signal.current_price.toFixed(2)} | Score: ${signal.score.toFixed(2)} | Rank: ${signal.rank} | Shares: ${signal.shares} ($${signal.allocation.toFixed(2)})`
      );
    });
    lines.push("");
  }

  if (signals.keepSignals.length > 0) {
    lines.push("🟡 KEEP Signals:");
    signals.keepSignals.forEach((signal) => {
      lines.push(
        `  • ${signal.symbol}: $${signal.current_price.toFixed(2)} | Score: ${signal.score.toFixed(2)} | Rank: ${signal.rank} | Shares: ${signal.shares} ($${signal.allocation.toFixed(2)})`
      );
    });
    lines.push("");
  }

  if (signals.exitSignals.length > 0) {
    lines.push("🔴 EXIT Signals:");
    signals.exitSignals.forEach((signal) => {
      lines.push(
        `  • ${signal.symbol}: $${signal.current_price.toFixed(2)} | Score: ${signal.score.toFixed(2)} | Rank: ${signal.rank}`
      );
    });
    lines.push("");
  }

  const totalActivePositions = signals.enterSignals.length + signals.keepSignals.length;
  if (totalActivePositions > 0) {
    const portfolioSize = parseInt(process.env.PORTFOLIO_SIZE || "10000", 10);
    lines.push("Portfolio Allocation Summary:");
    lines.push(`  Total Portfolio: $${portfolioSize.toLocaleString()}`);
    lines.push(`  Number of Positions: ${totalActivePositions}`);
    lines.push(
      `  Allocation per Stock: $${(portfolioSize / totalActivePositions).toFixed(2)}`
    );
  }

  return lines.join("\n");
}

export async function sendNotification(signals: ProcessedSignals): Promise<void> {
  const message = formatMessage(signals);

  try {
    const response = await fetch(NTFY_URL, {
      method: "POST",
      body: message,
      headers: {
        "Content-Type": "text/plain",
        Title: `EquiAlgo Signals - ${signals.date}`,
        Tags: "chart_increasing,stock",
      },
    });

    if (!response.ok) {
      throw new Error(
        `ntfy API error: ${response.status} ${response.statusText}`
      );
    }

    console.log("Notification sent successfully");
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error("Failed to send notification:", errorMessage);
    throw error;
  }
}


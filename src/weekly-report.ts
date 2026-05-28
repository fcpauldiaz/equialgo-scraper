import * as nodemailer from "nodemailer";
import {
  listPortfolios,
  readMonthlyPerformance,
  getPortfolioIdsWithCredentials,
} from "./state";
import { getPortfolioPositions, type PortfolioPosition } from "./trader";

interface PortfolioSnapshot {
  id: number;
  name: string;
  brokerage: string | null;
  positions: PortfolioPosition[];
  totalMarketValue: number;
  totalOpenPnL: number;
}

interface WeeklyReportData {
  generatedAt: string;
  portfolios: PortfolioSnapshot[];
  monthlyPerformance: {
    month: string;
    totalTrades: number;
    successfulTrades: number;
    failedTrades: number;
    buyCount: number;
    sellCount: number;
    totalBuyValue: number;
    totalSellValue: number;
    successRate: number;
  }[];
}

function getEmailConfig() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM || user;
  const to = process.env.EMAIL_TO;

  if (!host || !user || !pass || !to) {
    throw new Error(
      "Email configuration incomplete. Required: SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_TO"
    );
  }

  return { host, port, user, pass, from: from!, to };
}

async function gatherReportData(): Promise<WeeklyReportData> {
  const portfolios = await listPortfolios();
  const connectedIds = await getPortfolioIdsWithCredentials();

  const snapshots: PortfolioSnapshot[] = [];

  for (const portfolio of portfolios) {
    if (!connectedIds.includes(portfolio.id)) {
      snapshots.push({
        id: portfolio.id,
        name: portfolio.name,
        brokerage: portfolio.brokerage,
        positions: [],
        totalMarketValue: 0,
        totalOpenPnL: 0,
      });
      continue;
    }

    let positions: PortfolioPosition[] = [];
    try {
      positions = await getPortfolioPositions(portfolio.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[weekly-report] Failed to fetch positions for portfolio ${portfolio.id}:`,
        msg
      );
    }

    const totalMarketValue = positions.reduce(
      (sum, p) => sum + (p.marketValue ?? 0),
      0
    );
    const totalOpenPnL = positions.reduce(
      (sum, p) => sum + (p.longOpenProfitLoss ?? 0),
      0
    );

    snapshots.push({
      id: portfolio.id,
      name: portfolio.name,
      brokerage: portfolio.brokerage,
      positions,
      totalMarketValue,
      totalOpenPnL,
    });
  }

  const monthlyPerformance = await readMonthlyPerformance();

  return {
    generatedAt: new Date().toISOString(),
    portfolios: snapshots,
    monthlyPerformance: monthlyPerformance.slice(0, 3),
  };
}

function formatCurrency(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildHtmlReport(data: WeeklyReportData): string {
  const dateStr = new Date(data.generatedAt).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const portfolioSections = data.portfolios
    .map((p) => {
      if (p.positions.length === 0) {
        return `
        <div style="margin-bottom:24px;padding:16px;background:#1a1a1a;border:1px solid #333;border-radius:8px;">
          <h3 style="margin:0 0 8px;color:#e0e0e0;font-size:16px;">${p.name}</h3>
          <p style="color:#888;font-size:13px;margin:0;">${p.brokerage ? `${p.brokerage} — no positions or unable to fetch` : "Not connected"}</p>
        </div>`;
      }

      const positionRows = p.positions
        .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
        .map((pos) => {
          const pnlColor =
            (pos.longOpenProfitLoss ?? 0) >= 0 ? "#4ade80" : "#f87171";
          return `
          <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#e0e0e0;font-family:monospace;font-size:13px;">${pos.symbol}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#e0e0e0;font-family:monospace;font-size:13px;text-align:right;">${pos.longQuantity}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#e0e0e0;font-family:monospace;font-size:13px;text-align:right;">$${formatCurrency(pos.marketValue ?? 0)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:${pnlColor};font-family:monospace;font-size:13px;text-align:right;">$${formatCurrency(pos.longOpenProfitLoss ?? 0)}</td>
          </tr>`;
        })
        .join("");

      const pnlColor = p.totalOpenPnL >= 0 ? "#4ade80" : "#f87171";

      return `
      <div style="margin-bottom:24px;padding:16px;background:#1a1a1a;border:1px solid #333;border-radius:8px;">
        <h3 style="margin:0 0 4px;color:#e0e0e0;font-size:16px;">${p.name} <span style="color:#888;font-size:12px;font-weight:normal;">(${p.brokerage})</span></h3>
        <p style="margin:0 0 12px;font-family:monospace;font-size:13px;">
          <span style="color:#888;">Market Value:</span> <span style="color:#e0e0e0;">$${formatCurrency(p.totalMarketValue)}</span>
          &nbsp;·&nbsp;
          <span style="color:#888;">Open P/L:</span> <span style="color:${pnlColor};">$${formatCurrency(p.totalOpenPnL)}</span>
        </p>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr>
              <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Symbol</th>
              <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Qty</th>
              <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Mkt Value</th>
              <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Open P/L</th>
            </tr>
          </thead>
          <tbody>${positionRows}</tbody>
        </table>
      </div>`;
    })
    .join("");

  const performanceSection =
    data.monthlyPerformance.length > 0
      ? `
    <div style="margin-bottom:24px;padding:16px;background:#1a1a1a;border:1px solid #333;border-radius:8px;">
      <h3 style="margin:0 0 12px;color:#e0e0e0;font-size:16px;">Execution Performance (Last 3 Months)</h3>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Month</th>
            <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Trades</th>
            <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Success</th>
            <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Bought</th>
            <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #444;color:#888;font-size:11px;text-transform:uppercase;">Sold</th>
          </tr>
        </thead>
        <tbody>
          ${data.monthlyPerformance
            .map(
              (m) => `
          <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#e0e0e0;font-family:monospace;font-size:13px;">${m.month}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#e0e0e0;font-family:monospace;font-size:13px;text-align:right;">${m.totalTrades}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:${m.successRate >= 90 ? "#4ade80" : m.successRate < 50 ? "#f87171" : "#fbbf24"};font-family:monospace;font-size:13px;text-align:right;">${m.successRate}%</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#e0e0e0;font-family:monospace;font-size:13px;text-align:right;">$${formatCurrency(m.totalBuyValue)}</td>
            <td style="padding:6px 10px;border-bottom:1px solid #333;color:#e0e0e0;font-family:monospace;font-size:13px;text-align:right;">$${formatCurrency(m.totalSellValue)}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`
      : "";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:24px;background:#111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e0e0e0;">
  <div style="max-width:640px;margin:0 auto;">
    <h1 style="font-size:24px;font-weight:700;margin:0 0 4px;color:#fff;">EquiAlgo Weekly Report</h1>
    <p style="font-size:13px;color:#888;margin:0 0 24px;font-family:monospace;">${dateStr}</p>

    <h2 style="font-size:14px;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 12px;">Portfolio Positions</h2>
    ${portfolioSections}

    ${performanceSection}

    <p style="font-size:11px;color:#555;margin-top:32px;padding-top:16px;border-top:1px solid #333;">
      Generated by EquiAlgo Alert Service · ${new Date(data.generatedAt).toLocaleString()}
    </p>
  </div>
</body>
</html>`;
}

function buildPlainTextReport(data: WeeklyReportData): string {
  const lines: string[] = [];
  lines.push("EquiAlgo Weekly Report");
  lines.push(`Generated: ${new Date(data.generatedAt).toLocaleString()}`);
  lines.push("═".repeat(50));
  lines.push("");

  for (const p of data.portfolios) {
    lines.push(`▸ ${p.name}${p.brokerage ? ` (${p.brokerage})` : ""}`);
    if (p.positions.length === 0) {
      lines.push("  No positions");
      lines.push("");
      continue;
    }
    lines.push(
      `  Market Value: $${formatCurrency(p.totalMarketValue)}  |  Open P/L: $${formatCurrency(p.totalOpenPnL)}`
    );
    lines.push("");
    for (const pos of p.positions.sort(
      (a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0)
    )) {
      const pnl = pos.longOpenProfitLoss ?? 0;
      const pnlStr = pnl >= 0 ? `+$${formatCurrency(pnl)}` : `-$${formatCurrency(Math.abs(pnl))}`;
      lines.push(
        `  ${pos.symbol.padEnd(6)} ${String(pos.longQuantity).padStart(5)} sh  $${formatCurrency(pos.marketValue ?? 0).padStart(10)}  ${pnlStr}`
      );
    }
    lines.push("");
  }

  if (data.monthlyPerformance.length > 0) {
    lines.push("─".repeat(50));
    lines.push("EXECUTION PERFORMANCE (Last 3 Months)");
    lines.push("");
    for (const m of data.monthlyPerformance) {
      lines.push(
        `  ${m.month}  ${m.totalTrades} trades  ${m.successRate}% success  Bought $${formatCurrency(m.totalBuyValue)}  Sold $${formatCurrency(m.totalSellValue)}`
      );
    }
  }

  return lines.join("\n");
}

export async function sendWeeklyReport(): Promise<void> {
  const config = getEmailConfig();

  console.log("[weekly-report] Gathering position data...");
  const data = await gatherReportData();

  const connectedCount = data.portfolios.filter(
    (p) => p.positions.length > 0
  ).length;
  console.log(
    `[weekly-report] ${data.portfolios.length} portfolio(s), ${connectedCount} with positions`
  );

  const html = buildHtmlReport(data);
  const text = buildPlainTextReport(data);

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  const totalValue = data.portfolios.reduce(
    (sum, p) => sum + p.totalMarketValue,
    0
  );
  const subject = `EquiAlgo Weekly Report — $${formatCurrency(totalValue)} across ${connectedCount} portfolio(s)`;

  await transporter.sendMail({
    from: config.from,
    to: config.to,
    subject,
    text,
    html,
  });

  console.log(`[weekly-report] Email sent to ${config.to}`);
}

import "dotenv/config";
import {
  auditDaily,
  auditHistory,
  auditReportHasFailures,
  formatAuditReport,
} from "../audit-trades";
import { closeBrowser } from "../scraper";
import { initializeDatabase, listTradingPortfolioTargets } from "../state";

type AuditMode = "daily" | "history";

interface CliArgs {
  mode: AuditMode;
  portfolioId?: number;
  allPortfolios: boolean;
  slug?: string;
  date?: string;
  from?: string;
  to?: string;
  json: boolean;
  toleranceShares: number;
  executionLagDays: number;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): CliArgs {
  const filtered = argv[0] === "--" ? argv.slice(1) : argv;
  const args: CliArgs = {
    mode: "daily",
    allPortfolios: false,
    json: false,
    toleranceShares: 0,
    executionLagDays: 1,
  };

  for (let i = 0; i < filtered.length; i++) {
    const arg = filtered[i];
    const next = filtered[i + 1];

    switch (arg) {
      case "--mode":
        if (next !== "daily" && next !== "history") {
          throw new Error('--mode must be "daily" or "history"');
        }
        args.mode = next;
        i++;
        break;
      case "--portfolio":
        args.portfolioId = parseInt(next, 10);
        if (!Number.isInteger(args.portfolioId) || args.portfolioId <= 0) {
          throw new Error("--portfolio requires a positive integer");
        }
        i++;
        break;
      case "--all-portfolios":
        args.allPortfolios = true;
        break;
      case "--slug":
        args.slug = next?.trim().toLowerCase();
        i++;
        break;
      case "--date":
        args.date = next?.trim();
        i++;
        break;
      case "--from":
        args.from = next?.trim();
        i++;
        break;
      case "--to":
        args.to = next?.trim();
        i++;
        break;
      case "--json":
        args.json = true;
        break;
      case "--tolerance-shares": {
        const parsed = parseInt(next, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error("--tolerance-shares requires a non-negative integer");
        }
        args.toleranceShares = parsed;
        i++;
        break;
      }
      case "--execution-lag-days": {
        const parsed = parseInt(next, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error("--execution-lag-days requires a non-negative integer");
        }
        args.executionLagDays = parsed;
        i++;
        break;
      }
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm run audit:trades -- --mode daily --portfolio 1 --slug gemini [--date YYYY-MM-DD]
  pnpm run audit:trades -- --mode history --portfolio 1 --slug gemini --from YYYY-MM-DD --to YYYY-MM-DD
  pnpm run audit:trades -- --mode history --all-portfolios --from YYYY-MM-DD --to YYYY-MM-DD

Options:
  --mode daily|history        Audit mode (default: daily)
  --portfolio <id>            Portfolio id to audit
  --all-portfolios            Audit every portfolio+slug target from the database
  --slug <slug>               Strategy slug (required with --all-portfolios)
  --date <YYYY-MM-DD>         Date for daily mode (default: today UTC)
  --from / --to <YYYY-MM-DD>  Date range for history mode
  --tolerance-shares <n>      Allowed share delta (default: 0)
  --execution-lag-days <n>    Signal-to-execution day offset (default: 1, SystemTrader T+1)
  --json                      Emit JSON report
`);
}

interface AuditTarget {
  portfolioId: number;
  slug: string;
}

async function resolveTargets(args: CliArgs): Promise<AuditTarget[]> {
  const targets = await listTradingPortfolioTargets();

  if (args.allPortfolios) {
    if (!args.slug) {
      throw new Error("--slug is required with --all-portfolios");
    }
    const slug = args.slug;
    const filtered = targets.filter((t) => t.systemtraderSlug === slug);
    if (filtered.length === 0) {
      throw new Error(`No trading targets found for slug "${slug}"`);
    }
    return filtered.map((t) => ({ portfolioId: t.id, slug: t.systemtraderSlug }));
  }

  if (!args.portfolioId) {
    throw new Error("Provide --portfolio <id> or --all-portfolios");
  }

  const portfolioTargets = targets.filter((t) => t.id === args.portfolioId);
  if (portfolioTargets.length === 0) {
    throw new Error(`Portfolio ${args.portfolioId} has no Schwab/Tradier trading targets`);
  }

  if (args.slug) {
    const match = portfolioTargets.find((t) => t.systemtraderSlug === args.slug);
    if (!match) {
      throw new Error(
        `Portfolio ${args.portfolioId} is not configured for strategy "${args.slug}"`
      );
    }
    return [{ portfolioId: match.id, slug: match.systemtraderSlug }];
  }

  if (portfolioTargets.length > 1) {
    throw new Error(
      `Portfolio ${args.portfolioId} has multiple strategies; pass --slug (${portfolioTargets
        .map((t) => t.systemtraderSlug)
        .join(", ")})`
    );
  }

  return [{ portfolioId: portfolioTargets[0].id, slug: portfolioTargets[0].systemtraderSlug }];
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    printUsage();
    process.exit(1);
    return;
  }

  await initializeDatabase();
  const targets = await resolveTargets(args);
  const auditOptions = {
    toleranceShares: args.toleranceShares,
    executionLagDays: args.executionLagDays,
  };

  let hadFailures = false;
  const reports = [];

  try {
    for (const target of targets) {
      const report =
        args.mode === "daily"
          ? await auditDaily(
              target.portfolioId,
              target.slug,
              args.date,
              auditOptions
            )
          : await auditHistory(
              target.portfolioId,
              target.slug,
              args.from ?? args.date ?? todayIso(),
              args.to ?? args.from ?? args.date ?? todayIso(),
              auditOptions
            );

      reports.push(report);
      if (auditReportHasFailures(report)) {
        hadFailures = true;
      }

      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatAuditReport(report));
        console.log("");
      }
    }
  } finally {
    await closeBrowser();
  }

  if (hadFailures) {
    process.exit(1);
  }

  if (!args.json) {
    console.log(`audit-trades OK (${reports.length} report(s))`);
  }
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  await closeBrowser();
  process.exit(1);
});

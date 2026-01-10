# EquiAlgo Stock Alert Service

A Node.js/TypeScript service that monitors the EquiAlgo momentum backtest API and sends daily notifications via ntfy for stock entry and exit signals.

## Features

- Fetches data from EquiAlgo momentum backtest API once per day
- Extracts ENTER and EXIT signals from the latest snapshot
- Calculates share allocations for a $10,000 portfolio with equal distribution
- Sends detailed notifications via ntfy
- Tracks processed dates to avoid duplicate notifications
- Runs continuously with scheduled daily execution using node-cron

## Prerequisites

- Node.js (v18 or higher)
- pnpm (package manager)

## Installation

1. Clone or navigate to the project directory:
```bash
cd ~/Documents/chapilabs/equialgo-alerts
```

2. Install dependencies:
```bash
pnpm install
```

3. (Optional) Create a `.env` file for custom configuration:
```bash
cp .env.example .env
# Edit .env with your preferred settings
```

4. Build the project:
```bash
pnpm run build
```

## Configuration

Configuration is done via environment variables. Create a `.env` file in the project root (see `.env.example` for a template) or set environment variables directly.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CRON_SCHEDULE` | `0 9 * * *` | Cron schedule for daily execution (9:00 AM daily) |
| `NTFY_TOPIC` | `fcpauldiaz_notifications` | Ntfy topic for notifications |
| `NTFY_BASE_URL` | `https://ntfy.sh` | Base URL for ntfy service |
| `PORTFOLIO_SIZE` | `10000` | Portfolio size in dollars for share calculations |
| `API_URL` | `https://www.equialgo.com/data/backtest/momentum_backtest.json` | EquiAlgo API endpoint |
| `MAX_RETRIES` | `3` | Maximum number of retry attempts for API calls |
| `RETRY_DELAY_MS` | `1000` | Delay in milliseconds between retry attempts |
| `DATABASE_URL` | *Required* | Turso/LibSQL database URL |
| `DATABASE_AUTH_TOKEN` | *Required* | Turso/LibSQL authentication token |

### Example .env File

Create a `.env` file in the project root:

```bash
# Cron schedule (default: "0 9 * * *" - 9:00 AM daily)
CRON_SCHEDULE=0 9 * * *

# Ntfy configuration
NTFY_TOPIC=fcpauldiaz_notifications
NTFY_BASE_URL=https://ntfy.sh

# Portfolio configuration
PORTFOLIO_SIZE=10000

# API configuration
API_URL=https://www.equialgo.com/data/backtest/momentum_backtest.json

# Retry configuration
MAX_RETRIES=3
RETRY_DELAY_MS=1000

# Database configuration (Turso/LibSQL)
DATABASE_URL=libsql://equialgo-fcpauldiaz.aws-us-east-1.turso.io
DATABASE_AUTH_TOKEN=your_auth_token_here
```

### Cron Schedule Examples

```bash
export CRON_SCHEDULE="0 9 * * *"   # 9:00 AM daily (default)
export CRON_SCHEDULE="0 8 * * *"   # 8:00 AM daily
export CRON_SCHEDULE="0 10 * * 1-5"  # 10:00 AM on weekdays only
```

Cron format: `minute hour day month day-of-week`

## Usage

### Development Mode

Run the service in development mode (builds and runs once):
```bash
pnpm run dev
```

### Production Mode

1. Build the project:
```bash
pnpm run build
```

2. Start the service:
```bash
pnpm start
```

The service will:
- Run an initial check immediately
- Schedule daily checks based on the cron schedule
- Continue running until stopped (Ctrl+C)

### Running as a Background Service

For production, consider using a process manager like PM2:

```bash
pnpm install -g pm2
pnpm run build
pm2 start dist/index.js --name equialgo-alerts
pm2 save
pm2 startup
```

## How It Works

1. **Fetch**: Retrieves JSON data from `https://www.equialgo.com/data/backtest/momentum_backtest.json`
2. **Process**: Extracts the last snapshot and filters signals for ENTER/EXIT actions
3. **Calculate**: For ENTER signals, calculates shares for a $10k portfolio with equal allocation
4. **Check State**: Verifies if the date has already been processed
5. **Notify**: Sends a detailed notification via ntfy if it's a new date
6. **Update State**: Records the processed date to prevent duplicates

## Notification Format

Notifications include:
- Date of the snapshot
- ENTER signals with: symbol, price, score, rank, calculated shares, and allocation amount
- EXIT signals with: symbol, price, score, and rank
- Portfolio allocation summary

Example notification:
```
📊 EquiAlgo Signals - 2026-01-09

🟢 ENTER Signals:
  • AEVA: $19.87 | Score: 71.74 | Rank: 6 | Shares: 83 ($1666.67)
  • KTOS: $113.70 | Score: 69.53 | Rank: 8 | Shares: 14 ($1666.67)

🔴 EXIT Signals:
  • FIVE: $195.57 | Score: 0.00 | Rank: 999
  • CAT: $617.62 | Score: 0.00 | Rank: 999

Portfolio Allocation Summary:
  Total Portfolio: $10,000
  Number of Positions: 2
  Allocation per Stock: $5000.00
```

## State Management

The service uses a Turso (LibSQL) database to track state. The database stores:
- Last processed date
- Last processed timestamp

The database is automatically initialized on first run, creating a `state` table if it doesn't exist. This prevents sending duplicate notifications if the service runs multiple times on the same day or if the API hasn't updated.

**Database Setup**: The service requires `DATABASE_URL` and `DATABASE_AUTH_TOKEN` environment variables to be set. See the Configuration section above.

## Error Handling

- Network errors: Logged and retried on the next scheduled run (up to 3 retries)
- Invalid JSON: Logged and processing skipped
- Missing snapshot data: Warning logged and processing skipped
- Ntfy failures: Error logged but doesn't block state update

## Project Structure

```
equialgo-alerts/
├── src/
│   ├── index.ts          # Main service entry point
│   ├── fetcher.ts        # API fetching logic
│   ├── processor.ts      # Signal extraction and filtering
│   ├── notifier.ts       # ntfy notification sending
│   ├── state.ts          # State tracking
│   └── types.ts          # TypeScript type definitions
├── dist/                 # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

## Dependencies

- `typescript` - TypeScript compiler
- `node-fetch` - HTTP client for API calls
- `node-cron` - Daily scheduling
- `@libsql/client` - Turso/LibSQL database client
- `dotenv` - Environment variable management
- `@types/node` - Node.js type definitions

## License

ISC


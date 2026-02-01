# EquiAlgo Stock Alert Service

A Node.js/TypeScript service that scrapes the SystemTrader Gemini Portfolio page for today's trading actions, automatically executes trades via Charles Schwab API, and sends daily notifications via ntfy for stock entry and exit signals.

## Features

- Scrapes SystemTrader Gemini Portfolio page using Puppeteer to extract "Today's Actions" table
- Extracts ENTER and EXIT signals from the latest snapshot
- Calculates share allocations for a $10,000 portfolio with equal distribution
- Automatically places BUY orders for ENTER signals and SELL orders for EXIT signals via Charles Schwab API
- Verifies existing positions before placing orders to avoid duplicates
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
| `PORTFOLIO_SIZE` | `10000` | Portfolio size in dollars for share calculations (legacy, not used with scraper) |
| `PORTFOLIO_URL` | `https://www.systemtrader.co/gemini/portfolio` | SystemTrader Gemini Portfolio page URL to scrape |
| `MAX_RETRIES` | `3` | Maximum number of retry attempts for scraping |
| `RETRY_DELAY_MS` | `1000` | Delay in milliseconds between retry attempts |
| `PUPPETEER_HEADLESS` | `true` | Run Puppeteer in headless mode (set to `false` to see browser) |
| `DATABASE_URL` | *Required* | Turso/LibSQL database URL |
| `DATABASE_AUTH_TOKEN` | *Required* | Turso/LibSQL authentication token |
| `SCHWAB_CLIENT_ID` | *Required for trading* | Charles Schwab OAuth client ID |
| `SCHWAB_CLIENT_SECRET` | *Required for trading* | Charles Schwab OAuth client secret |
| `SCHWAB_REDIRECT_URI` | *Required for trading* | Charles Schwab OAuth redirect URI |
| `SCHWAB_ACCOUNT_NUMBER` | *Required for trading* | Charles Schwab account number/hash |
| `SCHWAB_ACCESS_TOKEN` | *Optional* | Schwab access token (if using stored tokens) |
| `SCHWAB_REFRESH_TOKEN` | *Optional* | Schwab refresh token (if using stored tokens) |
| `SCHWAB_ORDER_TYPE` | `MARKET` | Order type: `MARKET` or `LIMIT` |
| `SCHWAB_ENABLE_TRADING` | `false` | Enable/disable automatic trading (safety flag) |

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

# Scraper configuration
PORTFOLIO_URL=https://www.systemtrader.co/gemini/portfolio

# Retry configuration
MAX_RETRIES=3
RETRY_DELAY_MS=1000

# Database configuration (Turso/LibSQL)
DATABASE_URL=libsql://equialgo-fcpauldiaz.aws-us-east-1.turso.io
DATABASE_AUTH_TOKEN=your_auth_token_here

# Schwab API configuration (for automatic trading)
SCHWAB_CLIENT_ID=your_schwab_client_id
SCHWAB_CLIENT_SECRET=your_schwab_client_secret
SCHWAB_REDIRECT_URI=https://example.com/callback
SCHWAB_ACCOUNT_NUMBER=your_account_hash
SCHWAB_ORDER_TYPE=MARKET
SCHWAB_ENABLE_TRADING=false
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

1. **Scrape**: Uses Puppeteer to load the SystemTrader Gemini Portfolio page (configurable via `PORTFOLIO_URL`) and extracts the "Today's Actions" table
2. **Parse**: Extracts Symbol, Action (BUY/SELL/INCREASE/DECREASE), Shares (from Change column), and Open Price from each row
3. **Normalize**: Maps INCREASE → BUY and DECREASE → SELL, extracts absolute share counts from change values
4. **Check State**: Verifies if the date has already been processed
5. **Execute Trades**: If trading is enabled, places BUY orders for BUY actions and SELL orders for SELL actions via Charles Schwab API using the exact shares and prices from the scraped data
6. **Notify**: Sends a detailed notification via ntfy if it's a new date
7. **Update State**: Records the processed date to prevent duplicates

## Schwab API Setup

To enable automatic trading, you need to:

1. **Create a Schwab Developer Account**: Register at [Schwab Developer Portal](https://developer.schwab.com/)
2. **Create an OAuth Application**: Get your `client_id`, `client_secret`, and configure a `redirect_uri`
3. **Obtain Account Number**: Get your Schwab account number/hash from your account settings
4. **OAuth Flow**: Complete the OAuth flow to obtain `access_token` and `refresh_token`
5. **Configure Environment Variables**: Set all required Schwab environment variables (see Configuration section)
6. **Enable Trading**: Set `SCHWAB_ENABLE_TRADING=true` to activate automatic trading

### Important Security Notes

- **Trading is disabled by default**: Set `SCHWAB_ENABLE_TRADING=true` only when ready to execute real trades
- **Token Expiration**: Schwab refresh tokens expire after 7 days. You'll need to re-authenticate periodically
- **Position Verification**: The system automatically verifies existing positions before placing orders to avoid duplicate buys or selling non-existent positions
- **Error Handling**: Individual trade failures are logged but don't stop processing of other trades

### Order Types

- **MARKET**: Orders execute immediately at current market price (default)
- **LIMIT**: Orders execute only at or better than specified price (requires price parameter)

Set `SCHWAB_ORDER_TYPE` to `MARKET` or `LIMIT` to control order behavior.

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
│   ├── scraper.ts        # Puppeteer-based portfolio page scraping
│   ├── fetcher.ts        # Legacy API fetching logic (deprecated)
│   ├── processor.ts      # Signal extraction and action-to-signal conversion
│   ├── trader.ts         # Schwab API trading integration
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
- `puppeteer` - Headless browser for web scraping
- `node-cron` - Daily scheduling
- `@libsql/client` - Turso/LibSQL database client
- `@sudowealth/schwab-api` - Charles Schwab API client with OAuth support
- `dotenv` - Environment variable management
- `@types/node` - Node.js type definitions

## License

ISC


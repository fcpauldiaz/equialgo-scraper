# EquiAlgo Stock Alert Service

A Node.js/TypeScript service that scrapes a SystemTrader portfolio page (Gemini, Scorpio, and other strategies on the same site) for today's trading actions, automatically executes trades via Charles Schwab or Tradier, and sends daily notifications via ntfy for stock entry and exit signals.

## Features

- Scrapes SystemTrader portfolio pages using Puppeteer to extract "Today's Actions" table (each brokerage portfolio picks its own signal source in the admin UI, default Gemini)
- Extracts ENTER and EXIT signals from the latest snapshot
- Calculates share allocations for a $10,000 portfolio with equal distribution
- Automatically places BUY orders for ENTER signals and SELL orders for EXIT signals via Charles Schwab API
- Verifies existing positions before placing orders to avoid duplicates
- Sends detailed notifications via ntfy
- Tracks processed dates to avoid duplicate notifications
- Long-running **UI** process; the **daily check** (scrape, trade, notify) is run on a schedule you define outside the app (e.g. [Coolify](https://coolify.io) scheduled tasks) via `pnpm run daily-check`

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
| `NTFY_TOPIC` | `fcpauldiaz_notifications` | Ntfy topic for notifications |
| `NTFY_BASE_URL` | `https://ntfy.sh` | Base URL for ntfy service |
| `PORTFOLIO_SIZE` | `10000` | Portfolio size in dollars for share calculations (legacy, not used with scraper) |
| `PORTFOLIO_URL` | *(unset)* | When set, this URL is used for scraping and **overrides** the URL built from each portfolio’s strategy slug. When unset, the scrape URL is `https://www.systemtrader.co/{slug}/portfolio` where `{slug}` is stored **per brokerage portfolio** in the database (default `gemini`) and can be changed in the admin UI on each portfolio row. |
| `LOGIN_EMAIL` | *Required* | Email for signing in to the portfolio site |
| `LOGIN_PASSWORD` | *Required* | Password for signing in to the portfolio site |
| `MAX_RETRIES` | `3` | Maximum number of retry attempts for scraping (page-level) |
| `RETRY_DELAY_MS` | `1000` | Delay in milliseconds between retry attempts (page-level) |
| `SCRAPE_JOB_RETRY_ATTEMPTS` | `3` | Number of times to retry the full daily check when scrape fails |
| `SCRAPE_JOB_RETRY_DELAY_MS` | `60000` | Delay in ms between job retries (default 60s) |
| `PUPPETEER_HEADLESS` | `true` | Run Puppeteer in headless mode (set to `false` to see browser) |
| `PUPPETEER_EXECUTABLE_PATH` | *(none)* | Path to Chrome/Chromium binary (use on servers where Puppeteer’s bundled Chrome isn’t installed) |
| `DATABASE_URL` | *Required* | Turso/LibSQL database URL |
| `DATABASE_AUTH_TOKEN` | *Required* | Turso/LibSQL authentication token |
| `SCHWAB_CLIENT_ID` | *Required for trading* | Charles Schwab OAuth client ID |
| `SCHWAB_CLIENT_SECRET` | *Required for trading* | Charles Schwab OAuth client secret |
| `SCHWAB_REDIRECT_URI` | *(optional)* | When set, OAuth uses this callback URL (e.g. `https://your-domain.com/api/schwab/callback`) and the callback is served by the app; when unset, local callback is `https://127.0.0.1:8765/callback` |
| `SCHWAB_ACCOUNT_NUMBER` | *Required for trading* | Charles Schwab account number/hash |
| `SCHWAB_ACCESS_TOKEN` | *Optional* | Schwab access token (if using stored tokens) |
| `SCHWAB_REFRESH_TOKEN` | *Optional* | Schwab refresh token (if using stored tokens) |
| `SCHWAB_ORDER_TYPE` | `MARKET` | Order type: `MARKET` or `LIMIT` |
| `SCHWAB_ENABLE_TRADING` | `false` | Enable/disable automatic trading (safety flag) |
| `UI_PORT` | `3000` | Port for the admin UI (portfolios and Schwab login) |
| `PORTFOLIO_IDS` | *(all)* | Comma-separated portfolio IDs to run trades for (e.g. `1,2`); if unset, all portfolios with credentials are used |
| `SCHWAB_REDIRECT_PORT` | `8765` | Port for OAuth callback (HTTPS); callback URL is `https://127.0.0.1:8765/callback` |

### Example .env File

Create a `.env` file in the project root:

```bash
# Ntfy configuration
NTFY_TOPIC=fcpauldiaz_notifications
NTFY_BASE_URL=https://ntfy.sh

# Portfolio configuration
PORTFOLIO_SIZE=10000

# Scraper configuration (optional: omit PORTFOLIO_URL to use UI/database strategy → https://www.systemtrader.co/{slug}/portfolio)
# PORTFOLIO_URL=https://www.systemtrader.co/gemini/portfolio
LOGIN_EMAIL=your_email@example.com
LOGIN_PASSWORD=your_password

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

### Scheduling the daily check (Coolify or any cron)

The app no longer runs an internal timer. After `pnpm run build`, run the check with the **same environment** as the UI service:

```bash
node dist/scripts/daily-check.js
# or: pnpm run daily-check
```

In **Coolify**, add a **Scheduled Task** with that command (or equivalent), using the same resource/container image and env vars as your deployment. Set the schedule in Coolify (e.g. `30 8 * * 1-5` with timezone `America/New_York` for 8:30 AM Eastern on weekdays).

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
- Start the admin UI and API (no automatic scrape/trade)
- Keep running until stopped (Ctrl+C)

Run scraping and trades on a schedule using `pnpm run daily-check` (see above).

### Running in Docker or on a server (no bundled Chrome)

The Docker image includes the **admin UI** (portfolios and Schwab login). Publish port **3000** so the UI is reachable:

```bash
docker build -t equialgo-scraper .
docker run --init -p 3000:3000 --env-file .env equialgo-scraper
```

The UI is available at `http://localhost:3000` (or `http://<host>:3000` on a remote server). If you set `UI_PORT` to another value inside the container, map that port instead (e.g. `-p 8080:8080` when `UI_PORT=8080`).

On minimal or containerized environments (without Docker), Puppeteer’s bundled Chrome often isn’t installed. Use a system Chrome/Chromium and point the app to it:

1. **Install Chromium** (Debian/Ubuntu example):
   ```bash
   apt-get update && apt-get install -y chromium
   ```
2. **Set the executable path** (path may vary; use `which chromium` or `which chromium-browser`):
   ```bash
   export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
   # or: /usr/bin/chromium-browser
   ```
3. Run the app as usual (`pnpm run build && pnpm start`).

Alternatively, install Puppeteer’s Chrome during your image build:
```bash
npx puppeteer browsers install chrome
```
Then you don’t need `PUPPETEER_EXECUTABLE_PATH` unless you want to use a different binary.

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

1. **Scrape**: For each distinct strategy slug among connected portfolios, uses Puppeteer to load that SystemTrader page (`PORTFOLIO_URL` if set, otherwise `https://www.systemtrader.co/{slug}/portfolio`) and extracts the "Today's Actions" table
2. **Parse**: Extracts Symbol, Action (BUY/SELL/INCREASE/DECREASE), Shares (from Change column), and Open Price from each row
3. **Normalize**: Maps INCREASE → BUY and DECREASE → SELL, extracts absolute share counts from change values
4. **Check State**: For each brokerage portfolio, verifies if that **calendar date and strategy slug** were already processed for that portfolio (switching strategy on the same day triggers another run for that account)
5. **Execute Trades**: If trading is enabled, places BUY orders for BUY actions and SELL orders for SELL actions via Charles Schwab API using the exact shares and prices from the scraped data
6. **Notify**: Sends a detailed notification via ntfy if it's a new date
7. **Update State**: Records the processed date and slug **per brokerage portfolio** to prevent duplicates

## Schwab API Setup

The project supports **multiple portfolios**, each linked to a different Schwab account. Credentials are stored in the database (table `schwab_credentials`), not in `.env`.

### Option A: Admin UI (recommended)

When the service is running, an admin UI is available for adding portfolios and linking each to a Schwab account via OAuth.

1. **In `.env`** set:
   - `SCHWAB_CLIENT_ID`
   - `SCHWAB_CLIENT_SECRET`
   - `DATABASE_URL` and `DATABASE_AUTH_TOKEN`

2. **In your [Schwab app](https://developer.schwab.com/dashboard/apps)** add this callback URL:
   - `http://127.0.0.1:8765/callback`

3. **Start the service** (build first):
   ```bash
   pnpm run build && pnpm start
   ```

4. **Build the admin UI** (React + TanStack Query, once or after UI changes):
   ```bash
   pnpm run build:ui
   ```

5. **Open the admin UI** in your browser (default: `http://localhost:3000`).
   - Add one or more portfolios (e.g. "Default", "IRA"). For each portfolio, set **Signal source** (Gemini, Scorpio, etc.); that SystemTrader page drives trades for that account only.
   - For each portfolio, click **Login with Schwab**. A new window opens for Schwab sign-in; after you authorize, tokens and account number are saved for that portfolio.
   - Use **Verify** to confirm the connection.

6. Each scheduled `daily-check` run performs **one scrape per distinct signal source** among connected portfolios, then executes that strategy’s actions for **each portfolio** that uses that source. Optionally set `PORTFOLIO_IDS=1,2` to limit which portfolios are used.

### Option B: CLI login script (single default portfolio)

For the default portfolio (id 1) you can still use the command-line login:

1. **In `.env`** set `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN`.

2. **Callback URL** in your Schwab app: `https://127.0.0.1:8765/callback`

3. **Run** (build first, then run):
   ```bash
   pnpm run build && pnpm run schwab-login
   ```
   - A browser opens for Schwab login; after you sign in, tokens and account number are written for the default portfolio (id 1).

4. **Verify** the connection:
   ```bash
   pnpm run verify:schwab
   ```

### Option C: Manual / .env only

To enable automatic trading with env vars only:

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

- Network errors: Logged and retried within the same `daily-check` invocation (see `SCRAPE_JOB_RETRY_*`)
- Invalid JSON: Logged and processing skipped
- Missing snapshot data: Warning logged and processing skipped
- Ntfy failures: Error logged but doesn't block state update

## Project Structure

```
equialgo-alerts/
├── src/
│   ├── index.ts          # Main service entry (UI only)
│   ├── run-check.ts      # Daily scrape + trade + notify
│   ├── scripts/
│   │   └── daily-check.ts  # CLI entry for scheduled runs
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
- `@libsql/client` - Turso/LibSQL database client
- `@sudowealth/schwab-api` - Charles Schwab API client with OAuth support
- `dotenv` - Environment variable management
- `@types/node` - Node.js type definitions

## License

ISC


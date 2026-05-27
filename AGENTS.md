# AGENTS.md

## Cursor Cloud specific instructions

### Overview

EquiAlgo Alerts is a stock trading signal scraper + trade execution service with a React admin UI. Two runtime modes:
- **UI server** (`pnpm start`) — serves admin dashboard on port 3000
- **Daily check** (`pnpm run daily-check`) — scrapes signals, trades, notifies (run via scheduler)

### Development commands

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Build backend | `pnpm run build` (runs `tsc`) |
| Build UI | `pnpm run build:ui` (installs UI deps + vite build) |
| Dev mode | `pnpm run dev` (builds + starts server) |
| Start server | `pnpm start` (requires prior `pnpm run build`) |
| Type check | `npx tsc --noEmit` |
| Type check UI | `cd ui && npx tsc --noEmit` |

### Local database

The app uses `@libsql/client`. For local development, set in `.env`:
```
DATABASE_URL=file:local.db
DATABASE_AUTH_TOKEN=unused
```
This creates a local SQLite file. No external Turso instance needed for dev.

### Puppeteer / Chrome

Google Chrome is pre-installed at `/usr/local/bin/google-chrome`. Set in `.env`:
```
PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/google-chrome
```
Puppeteer's bundled browser install is skipped (pnpm build scripts blocked); system Chrome is the correct approach in this environment.

### Key gotchas

- No ESLint or Prettier is configured; `tsc --noEmit` is the only lint-style check.
- No automated test suite exists (no test scripts, no test files).
- The app requires `DATABASE_URL` and `DATABASE_AUTH_TOKEN` env vars or it will `process.exit(1)` on startup.
- The UI must be built (`pnpm run build:ui`) before serving; otherwise the server returns a 503 placeholder message.
- After modifying backend `.ts` files, you must re-run `pnpm run build` (no hot-reload; it's a compiled `dist/` workflow).
- External services (Schwab, Tradier, SystemTrader, ntfy) are all optional for running the UI server locally.

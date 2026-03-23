import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useEffect } from "react";
import {
  fetchPortfolios,
  createPortfolio,
  startSchwabLogin,
  connectTradier,
  verifyPortfolio,
  fetchStatistics,
  fetchPortfolioPositions,
  updatePortfolioSystemTraderStrategy,
  SYSTEMTRADER_STRATEGY_SLUGS,
  type PortfolioItem,
} from "./api";

const PORTFOLIOS_QUERY_KEY = ["portfolios"] as const;
const STATISTICS_QUERY_KEY = ["statistics"] as const;

function positionsQueryKey(portfolioId: number) {
  return ["portfolios", portfolioId, "positions"] as const;
}

function usePortfolios() {
  return useQuery({
    queryKey: PORTFOLIOS_QUERY_KEY,
    queryFn: fetchPortfolios,
  });
}

function useStatistics() {
  return useQuery({
    queryKey: STATISTICS_QUERY_KEY,
    queryFn: fetchStatistics,
  });
}

function usePortfolioPositions(portfolioId: number | null) {
  return useQuery({
    queryKey: positionsQueryKey(portfolioId ?? 0),
    queryFn: () => fetchPortfolioPositions(portfolioId!),
    enabled: portfolioId != null && portfolioId > 0,
  });
}

function useCreatePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createPortfolio(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
    },
  });
}

function useStartSchwabLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (portfolioId: number) => startSchwabLogin(portfolioId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
    },
  });
}

function useConnectTradier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      apiKey,
      sandbox,
    }: {
      portfolioId: number;
      apiKey: string;
      sandbox: boolean;
    }) => connectTradier(portfolioId, apiKey, sandbox),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
    },
  });
}

function useVerifyPortfolio() {
  return useMutation({
    mutationFn: (portfolioId: number) => verifyPortfolio(portfolioId),
  });
}

function usePortfolioStrategyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      slug,
    }: {
      portfolioId: number;
      slug: string;
    }) => updatePortfolioSystemTraderStrategy(portfolioId, slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
    },
  });
}

type Route = { view: "dashboard" | "portfolios" | "portfolio-detail"; portfolioId?: number };

function getRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const path = hash.startsWith("/") ? hash : `/${hash}`;
  if (path === "/" || path === "/dashboard") {
    return { view: "dashboard" };
  }
  if (path === "/portfolios") {
    return { view: "portfolios" };
  }
  const match = path.match(/^\/portfolios\/(\d+)$/);
  if (match) {
    return { view: "portfolio-detail", portfolioId: parseInt(match[1], 10) };
  }
  return { view: "dashboard" };
}

function Nav({ route }: { route: Route }) {
  return (
    <nav className="app-nav">
      <a href="#/dashboard" className={route.view === "dashboard" ? "active" : ""}>
        Dashboard
      </a>
      <a href="#/portfolios" className={route.view === "portfolios" ? "active" : ""}>
        Portfolios
      </a>
    </nav>
  );
}

function PortfolioRow({
  portfolio,
  loginInProgress,
  onLogin,
  showTradierForm,
  onShowTradierForm,
  onCloseTradierForm,
  showPositionsLink,
  onStrategyChange,
  strategyUpdatePending,
}: {
  portfolio: PortfolioItem;
  loginInProgress: boolean;
  onLogin: (id: number) => void;
  showTradierForm: boolean;
  onShowTradierForm: () => void;
  onCloseTradierForm: () => void;
  showPositionsLink?: boolean;
  onStrategyChange: (portfolioId: number, slug: string) => void;
  strategyUpdatePending: boolean;
}) {
  const verifyMutation = useVerifyPortfolio();
  const connectTradierMutation = useConnectTradier();
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [tradierApiKey, setTradierApiKey] = useState("");
  const [tradierSandbox, setTradierSandbox] = useState(true);

  const handleVerify = () => {
    setVerifyMsg("…");
    verifyMutation.mutate(portfolio.id, {
      onSuccess: (result) => {
        setVerifyMsg(result.ok ? "OK" : result.message || "Failed");
      },
      onError: () => {
        setVerifyMsg("Error");
      },
    });
  };

  const handleTradierSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const key = tradierApiKey.trim();
    if (!key) return;
    connectTradierMutation.mutate(
      { portfolioId: portfolio.id, apiKey: key, sandbox: tradierSandbox },
      {
        onSuccess: () => {
          setTradierApiKey("");
          onCloseTradierForm();
        },
      }
    );
  };

  const statusLabel = portfolio.hasCredentials
    ? `Connected${portfolio.brokerage ? ` (${portfolio.brokerage === "tradier" ? "Tradier" : "Schwab"})` : ""}`
    : "Not connected";

  return (
    <li className="portfolio-row">
      <div className="portfolio-row-main">
        <span className="portfolio-name">{portfolio.name}</span>
        <span className={`status ${portfolio.hasCredentials ? "connected" : "disconnected"}`}>
          {statusLabel}
        </span>
      </div>
      <div style={{ marginTop: "0.35rem", marginBottom: "0.25rem" }}>
        <label style={{ fontSize: "0.9rem" }}>
          Signal source{" "}
          <select
            value={portfolio.systemtraderSlug}
            disabled={strategyUpdatePending}
            onChange={(e) => onStrategyChange(portfolio.id, e.target.value)}
          >
            {SYSTEMTRADER_STRATEGY_SLUGS.map((slug) => (
              <option key={slug} value={slug}>
                {slug.charAt(0).toUpperCase() + slug.slice(1)}
              </option>
            ))}
          </select>
        </label>
        {portfolio.lastProcessedDate != null && (
          <span style={{ fontSize: "0.8rem", marginLeft: "0.75rem", color: "#555" }}>
            Last run: {portfolio.lastProcessedDate}
            {portfolio.lastProcessedSystemtraderSlug != null &&
              ` (${portfolio.lastProcessedSystemtraderSlug})`}
          </span>
        )}
      </div>
      <div className="portfolio-actions">
        {showPositionsLink && portfolio.hasCredentials && (
          <a href={`#/portfolios/${portfolio.id}`}>Positions</a>
        )}
        {portfolio.hasCredentials && portfolio.brokerage === "schwab" && (
          <button
            type="button"
            onClick={() => onLogin(portfolio.id)}
            disabled={loginInProgress}
          >
            Re-authorize Schwab
          </button>
        )}
        {!portfolio.hasCredentials && (
          <>
            <button
              type="button"
              onClick={() => onLogin(portfolio.id)}
              disabled={loginInProgress}
            >
              Login with Schwab
            </button>
            <button type="button" onClick={onShowTradierForm} disabled={showTradierForm}>
              Connect Tradier
            </button>
          </>
        )}
        <button
          type="button"
          onClick={handleVerify}
          disabled={verifyMutation.isPending}
        >
          Verify
        </button>
        {verifyMsg !== null && (
          <span className="verify-msg">
            {verifyMsg}
            {verifyMsg !== "OK" &&
              portfolio.hasCredentials &&
              portfolio.brokerage === "schwab" && (
                <> — Use <strong>Re-authorize Schwab</strong> above to refresh your token.</>
              )}
          </span>
        )}
      </div>
      {showTradierForm && (
        <form
          className="tradier-connect-form"
          onSubmit={handleTradierSubmit}
          style={{ marginTop: "0.5rem", padding: "0.5rem", border: "1px solid #ccc", borderRadius: "4px" }}
        >
          <p className="tradier-form-note" style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
            Your API key is stored securely and cannot be viewed again.
          </p>
          <input
            type="password"
            value={tradierApiKey}
            onChange={(e) => setTradierApiKey(e.target.value)}
            placeholder="Tradier API key"
            autoComplete="off"
            style={{ marginRight: "0.5rem", width: "200px" }}
          />
          <label style={{ marginRight: "0.75rem" }}>
            <input
              type="checkbox"
              checked={tradierSandbox}
              onChange={(e) => setTradierSandbox(e.target.checked)}
            />{" "}
            Use sandbox
          </label>
          <button type="submit" disabled={connectTradierMutation.isPending || !tradierApiKey.trim()}>
            {connectTradierMutation.isPending ? "Connecting…" : "Save"}
          </button>
          <button type="button" onClick={onCloseTradierForm} style={{ marginLeft: "0.5rem" }}>
            Cancel
          </button>
          {connectTradierMutation.isError && (
            <span className="error-msg" style={{ marginLeft: "0.5rem" }}>
              {String(connectTradierMutation.error)}
            </span>
          )}
        </form>
      )}
    </li>
  );
}

function DashboardView({
  loginInProgress,
  onLogin,
  strategyMutation,
  portfolioUrlEnvOverride,
}: {
  loginInProgress: boolean;
  onLogin: (id: number) => void;
  strategyMutation: ReturnType<typeof usePortfolioStrategyMutation>;
  portfolioUrlEnvOverride: boolean;
}) {
  const { data: stats, isLoading, error } = useStatistics();
  const { data: portfolios = [] } = usePortfolios();

  return (
    <>
      <h1>Dashboard</h1>
      <section className="stats-section">
        <h2>Statistics</h2>
        {isLoading && <p>Loading…</p>}
        {error && <p className="error-msg">{String(error)}</p>}
        {stats && (
          <ul className="stats-list">
            <li>Most recent processed date: {stats.lastProcessedDate ?? "—"}</li>
            {stats.lastProcessedTimestamp != null && (
              <li>Most recent run: {new Date(stats.lastProcessedTimestamp).toLocaleString()}</li>
            )}
            <li>Portfolios: {stats.portfolioCount}</li>
            <li>Connected: {stats.connectedCount}</li>
          </ul>
        )}
      </section>
      <section className="dashboard-portfolios">
        <h2>Portfolios</h2>
        <p style={{ fontSize: "0.9rem", color: "#555", marginBottom: "0.75rem" }}>
          Each portfolio has its own SystemTrader signal source. Trades use the strategy selected for that
          portfolio.
        </p>
        {portfolioUrlEnvOverride && (
          <p className="error-msg" style={{ marginTop: 0 }}>
            <code>PORTFOLIO_URL</code> is set in the environment, so every strategy uses that URL for
            scraping until you unset it. Per-portfolio selections still apply to deduplication when the
            variable is removed.
          </p>
        )}
        <ul>
          {portfolios.map((p) => (
            <PortfolioRow
              key={p.id}
              portfolio={p}
              loginInProgress={loginInProgress}
              onLogin={onLogin}
              showTradierForm={false}
              onShowTradierForm={() => {}}
              onCloseTradierForm={() => {}}
              showPositionsLink
              onStrategyChange={(id, slug) => strategyMutation.mutate({ portfolioId: id, slug })}
              strategyUpdatePending={strategyMutation.isPending}
            />
          ))}
        </ul>
        {strategyMutation.isError && (
          <p className="error-msg">{String(strategyMutation.error)}</p>
        )}
      </section>
    </>
  );
}

function PortfolioDetailView({
  portfolioId,
  portfolios,
  strategyMutation,
  portfolioUrlEnvOverride,
}: {
  portfolioId: number;
  portfolios: PortfolioItem[];
  strategyMutation: ReturnType<typeof usePortfolioStrategyMutation>;
  portfolioUrlEnvOverride: boolean;
}) {
  const portfolio = portfolios.find((p) => p.id === portfolioId);
  const { data: positions, isLoading, error } = usePortfolioPositions(portfolioId);

  return (
    <>
      <p className="breadcrumb">
        <a href="#/dashboard">Dashboard</a> / <a href="#/portfolios">Portfolios</a>
        {portfolio ? ` / ${portfolio.name}` : ` / ${portfolioId}`}
      </p>
      <h1>{portfolio ? portfolio.name : `Portfolio ${portfolioId}`}</h1>
      {portfolio && (
        <div style={{ marginBottom: "1rem" }}>
          <label style={{ fontSize: "0.95rem" }}>
            Signal source{" "}
            <select
              value={portfolio.systemtraderSlug}
              disabled={strategyMutation.isPending}
              onChange={(e) =>
                strategyMutation.mutate({ portfolioId: portfolio.id, slug: e.target.value })
              }
            >
              {SYSTEMTRADER_STRATEGY_SLUGS.map((slug) => (
                <option key={slug} value={slug}>
                  {slug.charAt(0).toUpperCase() + slug.slice(1)}
                </option>
              ))}
            </select>
          </label>
          {portfolioUrlEnvOverride && (
            <p className="error-msg" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
              <code>PORTFOLIO_URL</code> overrides scrape URLs for all strategies.
            </p>
          )}
          {strategyMutation.isError && (
            <p className="error-msg">{String(strategyMutation.error)}</p>
          )}
        </div>
      )}
      {!portfolio?.hasCredentials && (
        <p className="error-msg">Not connected. Link this portfolio via Portfolios (Schwab or Tradier).</p>
      )}
      {portfolio?.hasCredentials && (
        <>
          {isLoading && <p>Loading positions…</p>}
          {error && <p className="error-msg">{String(error)}</p>}
          {positions && positions.length === 0 && <p>No positions.</p>}
          {positions && positions.length > 0 && (
            <table className="positions-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Quantity</th>
                  <th>Market value</th>
                  <th>Day P/L</th>
                  <th>Day P/L %</th>
                  <th>Open P/L</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => (
                  <tr key={pos.symbol}>
                    <td>{pos.symbol}</td>
                    <td>{pos.longQuantity}</td>
                    <td>
                      {pos.marketValue != null
                        ? `$${pos.marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </td>
                    <td className={pos.currentDayProfitLoss != null && pos.currentDayProfitLoss < 0 ? "pl-negative" : "pl-positive"}>
                      {pos.currentDayProfitLoss != null
                        ? `$${pos.currentDayProfitLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </td>
                    <td className={pos.currentDayProfitLossPercentage != null && pos.currentDayProfitLossPercentage < 0 ? "pl-negative" : "pl-positive"}>
                      {pos.currentDayProfitLossPercentage != null
                        ? `${pos.currentDayProfitLossPercentage.toFixed(2)}%`
                        : "—"}
                    </td>
                    <td className={pos.longOpenProfitLoss != null && pos.longOpenProfitLoss < 0 ? "pl-negative" : "pl-positive"}>
                      {pos.longOpenProfitLoss != null
                        ? `$${pos.longOpenProfitLoss.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

function PortfoliosView({
  loginInProgress,
  onLogin,
  strategyMutation,
  portfolioUrlEnvOverride,
}: {
  loginInProgress: boolean;
  onLogin: (id: number) => void;
  strategyMutation: ReturnType<typeof usePortfolioStrategyMutation>;
  portfolioUrlEnvOverride: boolean;
}) {
  const { data: portfolios = [], isLoading, error } = usePortfolios();
  const createMutation = useCreatePortfolio();
  const loginMutation = useStartSchwabLogin();
  const [name, setName] = useState("");
  const [showTradierFormForId, setShowTradierFormForId] = useState<number | null>(null);

  const handleAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed, {
      onSuccess: () => setName(""),
    });
  };

  return (
    <>
      <h1>Portfolios</h1>
      <p>Add portfolios and link each to Schwab (OAuth) or Tradier (API key). Set the SystemTrader signal source per portfolio.</p>
      {portfolioUrlEnvOverride && (
        <p className="error-msg">
          <code>PORTFOLIO_URL</code> is set; all strategies use that URL until you unset it.
        </p>
      )}

      {isLoading && <p>Loading…</p>}
      {error && <p className="error-msg">{String(error)}</p>}

      <ul>
        {portfolios.map((p) => (
          <PortfolioRow
            key={p.id}
            portfolio={p}
            loginInProgress={loginInProgress}
            onLogin={onLogin}
            showTradierForm={showTradierFormForId === p.id}
            onShowTradierForm={() => setShowTradierFormForId(p.id)}
            onCloseTradierForm={() => setShowTradierFormForId(null)}
            onStrategyChange={(id, slug) => strategyMutation.mutate({ portfolioId: id, slug })}
            strategyUpdatePending={strategyMutation.isPending}
          />
        ))}
      </ul>
      {strategyMutation.isError && (
        <p className="error-msg">{String(strategyMutation.error)}</p>
      )}

      <div className="add-form">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New portfolio name"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={createMutation.isPending || !name.trim()}
        >
          Add portfolio
        </button>
      </div>

      {createMutation.isError && (
        <p className="error-msg">{String(createMutation.error)}</p>
      )}
      {loginMutation.isError && (
        <p className="error-msg">{String(loginMutation.error)}</p>
      )}
    </>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(getRoute);
  const loginMutation = useStartSchwabLogin();
  const strategyMutation = usePortfolioStrategyMutation();
  const [loginInProgress, setLoginInProgress] = useState(false);
  const loginPopupRef = useRef<Window | null>(null);
  const queryClient = useQueryClient();
  const { data: portfolios = [] } = usePortfolios();
  const { data: stats } = useStatistics();
  const portfolioUrlEnvOverride = stats?.portfolioUrlEnvOverride ?? false;

  useEffect(() => {
    const onHashChange = () => setRoute(getRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "schwab-login-done") {
        setLoginInProgress(false);
        queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [queryClient]);
  useEffect(() => {
    if (!loginInProgress || !loginPopupRef.current) return;
    const id = setInterval(() => {
      if (loginPopupRef.current?.closed) {
        setLoginInProgress(false);
        queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
      }
    }, 300);
    return () => clearInterval(id);
  }, [loginInProgress, queryClient]);

  const handleLogin = (portfolioId: number) => {
    if (loginInProgress) return;
    loginMutation.mutate(portfolioId, {
      onSuccess: (data) => {
        setLoginInProgress(true);
        loginPopupRef.current = window.open(
          data.authUrl,
          "schwab-login",
          "width=520,height=640"
        );
      },
    });
  };

  return (
    <>
      <Nav route={route} />
      {route.view === "dashboard" && (
        <DashboardView
          loginInProgress={loginInProgress}
          onLogin={handleLogin}
          strategyMutation={strategyMutation}
          portfolioUrlEnvOverride={portfolioUrlEnvOverride}
        />
      )}
      {route.view === "portfolios" && (
        <PortfoliosView
          loginInProgress={loginInProgress}
          onLogin={handleLogin}
          strategyMutation={strategyMutation}
          portfolioUrlEnvOverride={portfolioUrlEnvOverride}
        />
      )}
      {route.view === "portfolio-detail" && route.portfolioId != null && (
        <PortfolioDetailView
          portfolioId={route.portfolioId}
          portfolios={portfolios}
          strategyMutation={strategyMutation}
          portfolioUrlEnvOverride={portfolioUrlEnvOverride}
        />
      )}
    </>
  );
}

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useEffect } from "react";
import {
  fetchPortfolios,
  createPortfolio,
  startSchwabLogin,
  connectTradier,
  verifyPortfolio,
  runPortfolioDailyCheck,
  fetchStatistics,
  fetchPortfolioPositions,
  fetchPerformance,
  fetchAuthStatus,
  login,
  logout,
  getAuthToken,
  setAuthToken,
  updatePortfolioSystemTraderStrategies,
  fetchTradierPreviewAccounts,
  fetchTradierAccountsForPortfolio,
  updateTradierPortfolioAccount,
  SYSTEMTRADER_STRATEGY_SLUGS,
  type PortfolioItem,
  type MonthlyPerformance,
  type StrategyPerformance,
  type TradierAccountChoice,
} from "./api";

const PORTFOLIOS_QUERY_KEY = ["portfolios"] as const;
const STATISTICS_QUERY_KEY = ["statistics"] as const;

function positionsQueryKey(portfolioId: number) {
  return ["portfolios", portfolioId, "positions"] as const;
}

function tradierAccountsQueryKey(portfolioId: number) {
  return ["portfolios", portfolioId, "tradier-accounts"] as const;
}

function formatTradierAccountOptionLabel(a: TradierAccountChoice): string {
  const meta = [a.classification, a.type, a.status].filter(Boolean);
  return meta.length > 0 ? `${a.accountNumber} (${meta.join(" · ")})` : a.accountNumber;
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
      accountId,
    }: {
      portfolioId: number;
      apiKey: string;
      sandbox: boolean;
      accountId: string;
    }) => connectTradier(portfolioId, apiKey, sandbox, accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
    },
  });
}

function TradierAccountPickPanel({
  portfolioId,
  storedAccountNumber,
  onClose,
}: {
  portfolioId: number;
  storedAccountNumber: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: tradierAccountsQueryKey(portfolioId),
    queryFn: () => fetchTradierAccountsForPortfolio(portfolioId),
  });
  const [sel, setSel] = useState("");
  useEffect(() => {
    const accounts = data?.accounts;
    if (!accounts?.length) return;
    const cur = storedAccountNumber?.trim() ?? "";
    const match = accounts.some((a) => a.accountNumber === cur);
    setSel(match ? cur : accounts[0].accountNumber);
  }, [data, storedAccountNumber]);
  const updateMut = useMutation({
    mutationFn: (accountId: string) =>
      updateTradierPortfolioAccount(portfolioId, accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
      queryClient.invalidateQueries({
        queryKey: tradierAccountsQueryKey(portfolioId),
      });
      onClose();
    },
  });
  return (
    <div className="tradier-account-panel">
      {isLoading && <p className="tradier-account-panel-status">Loading accounts…</p>}
      {error && <p className="error-msg">{String(error)}</p>}
      {data?.accounts && data.accounts.length > 0 && (
        <>
          <label className="tradier-account-panel-label">
            Account{" "}
            <select
              value={sel}
              onChange={(e) => setSel(e.target.value)}
              disabled={updateMut.isPending}
              className="tradier-account-select"
            >
              {data.accounts.map((a) => (
                <option key={a.accountNumber} value={a.accountNumber}>
                  {formatTradierAccountOptionLabel(a)}
                </option>
              ))}
            </select>
          </label>
          <div className="tradier-account-panel-actions">
            <button
              type="button"
              disabled={updateMut.isPending || !sel}
              onClick={() => updateMut.mutate(sel)}
            >
              {updateMut.isPending ? "Saving…" : "Save account"}
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
          {updateMut.isError && (
            <p className="error-msg">{String(updateMut.error)}</p>
          )}
        </>
      )}
      {data?.accounts && data.accounts.length === 0 && (
        <p className="error-msg">No Tradier accounts returned.</p>
      )}
    </div>
  );
}

function useVerifyPortfolio() {
  return useMutation({
    mutationFn: (portfolioId: number) => verifyPortfolio(portfolioId),
  });
}

function useRunPortfolioDailyCheck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (portfolioId: number) => runPortfolioDailyCheck(portfolioId),
    onSuccess: (_data, portfolioId) => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
      queryClient.invalidateQueries({
        queryKey: positionsQueryKey(portfolioId),
      });
    },
  });
}

function usePortfolioStrategyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      portfolioId,
      slugs,
    }: {
      portfolioId: number;
      slugs: string[];
    }) => updatePortfolioSystemTraderStrategies(portfolioId, slugs),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: STATISTICS_QUERY_KEY });
    },
  });
}

type Route = { view: "dashboard" | "portfolios" | "portfolio-detail" | "performance"; portfolioId?: number };

function getRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const path = hash.startsWith("/") ? hash : `/${hash}`;
  if (path === "/" || path === "/dashboard") {
    return { view: "dashboard" };
  }
  if (path === "/portfolios") {
    return { view: "portfolios" };
  }
  if (path === "/performance") {
    return { view: "performance" };
  }
  const match = path.match(/^\/portfolios\/(\d+)$/);
  if (match) {
    return { view: "portfolio-detail", portfolioId: parseInt(match[1], 10) };
  }
  return { view: "dashboard" };
}

function Nav({
  route,
  authEnabled,
  authenticated,
  onLoginClick,
  onLogout,
}: {
  route: Route;
  authEnabled: boolean;
  authenticated: boolean;
  onLoginClick: () => void;
  onLogout: () => void;
}) {
  return (
    <nav className="app-nav">
      <a href="#/dashboard" className={route.view === "dashboard" ? "active" : ""}>
        Dashboard
      </a>
      <a href="#/portfolios" className={route.view === "portfolios" ? "active" : ""}>
        Portfolios
      </a>
      <a href="#/performance" className={route.view === "performance" ? "active" : ""}>
        Performance
      </a>
      {authEnabled && (
        <span className="nav-auth">
          {authenticated ? (
            <button type="button" className="nav-auth-btn" onClick={onLogout}>
              Logout
            </button>
          ) : (
            <button type="button" className="nav-auth-btn" onClick={onLoginClick}>
              Login
            </button>
          )}
        </span>
      )}
    </nav>
  );
}

function LoginModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const { token } = await login(password);
      setAuthToken(token);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-overlay" onClick={onClose}>
      <form
        className="login-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2>Admin Login</h2>
        <p>Enter password to make changes.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          disabled={loading}
        />
        {error && <p className="error-msg">{error}</p>}
        <div className="login-actions">
          <button type="submit" disabled={loading || !password.trim()}>
            {loading ? "Logging in…" : "Login"}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function StrategySignalCheckboxes({
  portfolioId,
  systemtraderSlugs,
  disabled,
  onSlugsChange,
}: {
  portfolioId: number;
  systemtraderSlugs: string[];
  disabled: boolean;
  onSlugsChange: (portfolioId: number, slugs: string[]) => void;
}) {
  const toggle = (slug: string, checked: boolean) => {
    const set = new Set(systemtraderSlugs);
    if (checked) {
      set.add(slug);
    } else {
      set.delete(slug);
    }
    const next = Array.from(set);
    if (next.length === 0) {
      return;
    }
    onSlugsChange(portfolioId, next);
  };

  return (
    <div
      className={`strategy-signals${disabled ? " strategy-signals-disabled" : ""}`}
      aria-label="SystemTrader strategies"
    >
      <p className="strategy-signals-caption">Strategies</p>
      {SYSTEMTRADER_STRATEGY_SLUGS.map((slug) => (
        <label key={slug}>
          <input
            type="checkbox"
            checked={systemtraderSlugs.includes(slug)}
            disabled={disabled}
            onChange={(e) => toggle(slug, e.target.checked)}
          />
          <span>{slug.charAt(0).toUpperCase() + slug.slice(1)}</span>
        </label>
      ))}
    </div>
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
  onSlugsChange,
  strategyUpdatePending,
  canWrite = true,
}: {
  portfolio: PortfolioItem;
  loginInProgress: boolean;
  onLogin: (id: number) => void;
  showTradierForm: boolean;
  onShowTradierForm: () => void;
  onCloseTradierForm: () => void;
  showPositionsLink?: boolean;
  onSlugsChange: (portfolioId: number, slugs: string[]) => void;
  strategyUpdatePending: boolean;
  canWrite?: boolean;
}) {
  const verifyMutation = useVerifyPortfolio();
  const runDailyCheckMutation = useRunPortfolioDailyCheck();
  const connectTradierMutation = useConnectTradier();
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [runCheckMsg, setRunCheckMsg] = useState<string | null>(null);
  const [tradierApiKey, setTradierApiKey] = useState("");
  const [tradierSandbox, setTradierSandbox] = useState(true);
  const [previewAccounts, setPreviewAccounts] = useState<TradierAccountChoice[] | null>(null);
  const [selectedTradierAccount, setSelectedTradierAccount] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [tradierPickerOpen, setTradierPickerOpen] = useState(false);

  useEffect(() => {
    if (!showTradierForm) return;
    setPreviewAccounts(null);
    setSelectedTradierAccount("");
    setPreviewError(null);
  }, [showTradierForm, tradierSandbox]);

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

  const handleRunDailyCheck = () => {
    setRunCheckMsg("Running…");
    runDailyCheckMutation.mutate(portfolio.id, {
      onSuccess: (result) => {
        setRunCheckMsg(
          result.skipped === "weekend"
            ? result.message ?? "Skipped (weekend)."
            : "Done"
        );
      },
      onError: (error) => {
        setRunCheckMsg(error instanceof Error ? error.message : String(error));
      },
    });
  };

  const handleLoadTradierAccounts = async () => {
    const key = tradierApiKey.trim();
    if (!key) return;
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const { accounts } = await fetchTradierPreviewAccounts(key, tradierSandbox);
      setPreviewAccounts(accounts);
      if (accounts.length === 0) {
        setPreviewError("No accounts returned for this key.");
        setSelectedTradierAccount("");
      } else {
        const active = accounts.find(
          (a) => (a.status ?? "").toLowerCase() !== "closed"
        );
        setSelectedTradierAccount((active ?? accounts[0]).accountNumber);
      }
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
      setPreviewAccounts(null);
      setSelectedTradierAccount("");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleTradierSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const key = tradierApiKey.trim();
    if (!key) return;
    if (!previewAccounts?.length || !selectedTradierAccount) {
      setPreviewError("Load accounts and select one before saving.");
      return;
    }
    connectTradierMutation.mutate(
      {
        portfolioId: portfolio.id,
        apiKey: key,
        sandbox: tradierSandbox,
        accountId: selectedTradierAccount,
      },
      {
        onSuccess: () => {
          setTradierApiKey("");
          setPreviewAccounts(null);
          setSelectedTradierAccount("");
          onCloseTradierForm();
        },
      }
    );
  };

  const statusLabel = portfolio.hasCredentials
    ? `Connected${
        portfolio.brokerage === "tradier"
          ? portfolio.tradierAccountLast4
            ? ` (Tradier …${portfolio.tradierAccountLast4})`
            : " (Tradier)"
          : portfolio.brokerage === "schwab"
            ? " (Schwab)"
            : ""
      }`
    : "Not connected";

  return (
    <li className="portfolio-row">
      <div className="portfolio-row-header">
        <div className="portfolio-row-main">
          <span className="portfolio-name">{portfolio.name}</span>
          <span className={`status ${portfolio.hasCredentials ? "connected" : "disconnected"}`}>
            {statusLabel}
          </span>
        </div>
        <div className="portfolio-actions">
          {showPositionsLink && portfolio.hasCredentials && (
            <a href={`#/portfolios/${portfolio.id}`}>Positions</a>
          )}
          {canWrite && portfolio.hasCredentials && portfolio.brokerage === "schwab" && (
            <button
              type="button"
              onClick={() => onLogin(portfolio.id)}
              disabled={loginInProgress}
            >
              Re-authorize Schwab
            </button>
          )}
          {canWrite && !portfolio.hasCredentials && (
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
          {canWrite && portfolio.hasCredentials && portfolio.brokerage === "tradier" && (
            <button type="button" onClick={() => setTradierPickerOpen((o) => !o)}>
              {tradierPickerOpen ? "Cancel" : "Tradier account"}
            </button>
          )}
          <button
            type="button"
            onClick={handleVerify}
            disabled={verifyMutation.isPending}
          >
            Verify
          </button>
          {canWrite && portfolio.hasCredentials && (
            <button
              type="button"
              onClick={handleRunDailyCheck}
              disabled={runDailyCheckMutation.isPending}
            >
              {runDailyCheckMutation.isPending ? "Running daily check…" : "Run daily check"}
            </button>
          )}
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
          {runCheckMsg !== null && <span className="verify-msg">{runCheckMsg}</span>}
        </div>
      </div>
      <StrategySignalCheckboxes
        portfolioId={portfolio.id}
        systemtraderSlugs={portfolio.systemtraderSlugs}
        disabled={strategyUpdatePending || !canWrite}
        onSlugsChange={onSlugsChange}
      />
      {portfolio.strategyRuns.length > 0 && (
        <div className="portfolio-last-run">
          Last run:{" "}
          {portfolio.strategyRuns.map((r) => (
            <span key={r.slug} className="portfolio-last-run-item">
              {r.slug}: {r.lastProcessedDate ?? "—"}
            </span>
          ))}
        </div>
      )}
      {portfolio.hasCredentials && portfolio.brokerage === "tradier" && tradierPickerOpen && (
        <TradierAccountPickPanel
          portfolioId={portfolio.id}
          storedAccountNumber={portfolio.tradierAccountNumber}
          onClose={() => setTradierPickerOpen(false)}
        />
      )}
      {showTradierForm && (
        <form
          className="tradier-connect-form"
          onSubmit={handleTradierSubmit}
        >
          <p className="tradier-form-note">
            Your API key is stored securely and cannot be viewed again. Load accounts, pick the
            correct one, then save.
          </p>
          <div className="tradier-connect-row">
            <input
              type="password"
              value={tradierApiKey}
              onChange={(e) => setTradierApiKey(e.target.value)}
              placeholder="Tradier API key"
              autoComplete="off"
              className="tradier-api-key-input"
            />
            <label className="tradier-sandbox-label">
              <input
                type="checkbox"
                checked={tradierSandbox}
                onChange={(e) => setTradierSandbox(e.target.checked)}
              />{" "}
              Use sandbox
            </label>
            <button
              type="button"
              onClick={handleLoadTradierAccounts}
              disabled={previewLoading || !tradierApiKey.trim()}
            >
              {previewLoading ? "Loading…" : "Load accounts"}
            </button>
          </div>
          {previewAccounts != null && previewAccounts.length > 0 && (
            <label className="tradier-account-panel-label tradier-connect-account-label">
              Account{" "}
              <select
                value={selectedTradierAccount}
                onChange={(e) => setSelectedTradierAccount(e.target.value)}
                disabled={connectTradierMutation.isPending}
                className="tradier-account-select"
              >
                {previewAccounts.map((a) => (
                  <option key={a.accountNumber} value={a.accountNumber}>
                    {formatTradierAccountOptionLabel(a)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {previewError && <p className="error-msg">{previewError}</p>}
          <div className="tradier-connect-actions">
            <button
              type="submit"
              disabled={
                connectTradierMutation.isPending ||
                !tradierApiKey.trim() ||
                !previewAccounts?.length ||
                !selectedTradierAccount
              }
            >
              {connectTradierMutation.isPending ? "Connecting…" : "Save"}
            </button>
            <button type="button" onClick={onCloseTradierForm}>
              Cancel
            </button>
            {connectTradierMutation.isError && (
              <span className="error-msg tradier-connect-error">
                {String(connectTradierMutation.error)}
              </span>
            )}
          </div>
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
  canWrite,
}: {
  loginInProgress: boolean;
  onLogin: (id: number) => void;
  strategyMutation: ReturnType<typeof usePortfolioStrategyMutation>;
  portfolioUrlEnvOverride: boolean;
  canWrite: boolean;
}) {
  const { data: stats, isLoading, error } = useStatistics();
  const { data: portfolios = [] } = usePortfolios();
  const [showTradierFormForId, setShowTradierFormForId] = useState<number | null>(null);

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
              <li>Most recent run: {new Date(stats.lastProcessedTimestamp).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</li>
            )}
            <li>Portfolios: {stats.portfolioCount}</li>
            <li>Connected: {stats.connectedCount}</li>
          </ul>
        )}
      </section>
      <section className="dashboard-portfolios">
        <h2>Portfolios</h2>
        <p style={{ fontSize: "0.9rem", color: "#555", marginBottom: "0.75rem" }}>
          Each portfolio can follow one or more SystemTrader strategies on the same brokerage connection.
          Trades run for each selected strategy when the job runs.
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
              showTradierForm={showTradierFormForId === p.id}
              onShowTradierForm={() => setShowTradierFormForId(p.id)}
              onCloseTradierForm={() => setShowTradierFormForId(null)}
              showPositionsLink
              onSlugsChange={(id, slugs) =>
                strategyMutation.mutate({ portfolioId: id, slugs })
              }
              strategyUpdatePending={strategyMutation.isPending}
              canWrite={canWrite}
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
  canWrite,
}: {
  portfolioId: number;
  portfolios: PortfolioItem[];
  strategyMutation: ReturnType<typeof usePortfolioStrategyMutation>;
  portfolioUrlEnvOverride: boolean;
  canWrite: boolean;
}) {
  const portfolio = portfolios.find((p) => p.id === portfolioId);
  const { data: positions, isLoading, error } = usePortfolioPositions(portfolioId);
  const [tradierPickerOpen, setTradierPickerOpen] = useState(false);
  const runDailyCheckMutation = useRunPortfolioDailyCheck();
  const [runCheckMsg, setRunCheckMsg] = useState<string | null>(null);

  const handleRunDailyCheck = () => {
    setRunCheckMsg("Running…");
    runDailyCheckMutation.mutate(portfolioId, {
      onSuccess: (result) => {
        setRunCheckMsg(
          result.skipped === "weekend"
            ? result.message ?? "Skipped (weekend)."
            : "Done"
        );
      },
      onError: (runError) => {
        setRunCheckMsg(runError instanceof Error ? runError.message : String(runError));
      },
    });
  };

  return (
    <>
      <p className="breadcrumb">
        <a href="#/dashboard">Dashboard</a> / <a href="#/portfolios">Portfolios</a>
        {portfolio ? ` / ${portfolio.name}` : ` / ${portfolioId}`}
      </p>
      <h1>{portfolio ? portfolio.name : `Portfolio ${portfolioId}`}</h1>
      {portfolio?.brokerage === "tradier" && portfolio.hasCredentials && (
        <div className="portfolio-detail-tradier">
          <p className="portfolio-tradier-account-hint">
            {portfolio.tradierAccountLast4
              ? `Tradier account …${portfolio.tradierAccountLast4}`
              : "Tradier linked."}
          </p>
          <button type="button" onClick={() => setTradierPickerOpen((o) => !o)}>
            {tradierPickerOpen ? "Cancel" : "Change Tradier account"}
          </button>
          {tradierPickerOpen && (
            <TradierAccountPickPanel
              portfolioId={portfolio.id}
              storedAccountNumber={portfolio.tradierAccountNumber}
              onClose={() => setTradierPickerOpen(false)}
            />
          )}
        </div>
      )}
      {portfolio && (
        <div className="portfolio-detail-meta">
          <StrategySignalCheckboxes
            portfolioId={portfolio.id}
            systemtraderSlugs={portfolio.systemtraderSlugs}
            disabled={strategyMutation.isPending || !canWrite}
            onSlugsChange={(id, slugs) =>
              strategyMutation.mutate({ portfolioId: id, slugs })
            }
          />
          {portfolio.strategyRuns.length > 0 && (
            <div className="portfolio-last-run portfolio-last-run-detail">
              Last run:{" "}
              {portfolio.strategyRuns.map((r) => (
                <span key={r.slug} className="portfolio-last-run-item">
                  {r.slug}: {r.lastProcessedDate ?? "—"}
                </span>
              ))}
            </div>
          )}
          {canWrite && portfolio.hasCredentials && (
            <div className="portfolio-manual-run">
              <button
                type="button"
                onClick={handleRunDailyCheck}
                disabled={runDailyCheckMutation.isPending}
              >
                {runDailyCheckMutation.isPending
                  ? "Running daily check…"
                  : "Run daily check now"}
              </button>
              {runCheckMsg && <span className="verify-msg">{runCheckMsg}</span>}
            </div>
          )}
          {portfolioUrlEnvOverride && (
            <p className="error-msg" style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
              <code>PORTFOLIO_URL</code> overrides scrape URLs for all strategies until unset.
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

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function StrategyChart({ strategy }: { strategy: StrategyPerformance }) {
  const points = strategy.monthlyPnL;
  if (points.length < 2) return null;

  const width = 680;
  const height = 140;
  const padX = 48;
  const padY = 24;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;

  const values = points.map((p) => p.cumulativePnL);
  const maxVal = Math.max(...values, 0);
  const minVal = Math.min(...values, 0);
  const range = maxVal - minVal || 1;

  const toX = (i: number) => padX + (i / (points.length - 1)) * chartW;
  const toY = (v: number) => padY + ((maxVal - v) / range) * chartH;

  const zeroY = toY(0);
  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.cumulativePnL).toFixed(1)}`)
    .join(" ");

  const lastVal = values[values.length - 1];
  const lineColor = lastVal >= 0 ? "var(--color-positive)" : "var(--color-negative)";

  return (
    <div className="strategy-chart">
      <h3 className="strategy-chart-title">
        {strategy.strategy}
        <span className={lastVal >= 0 ? "perf-positive" : "perf-negative"}>
          {lastVal >= 0 ? "+" : ""}${formatCurrency(lastVal)}
        </span>
      </h3>
      <svg viewBox={`0 0 ${width} ${height}`} className="strategy-chart-svg">
        <line
          x1={padX} y1={zeroY} x2={width - padX} y2={zeroY}
          stroke="var(--color-rule)" strokeWidth="1" strokeDasharray="4 3"
        />
        {points.map((_, i) => (
          <line key={i} x1={toX(i)} y1={padY} x2={toX(i)} y2={height - padY}
            stroke="var(--color-rule)" strokeWidth="0.5" opacity="0.3"
          />
        ))}
        <path d={pathD} fill="none" stroke={lineColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={toX(i)} cy={toY(p.cumulativePnL)} r="3"
            fill={p.cumulativePnL >= 0 ? "var(--color-positive)" : "var(--color-negative)"}
          />
        ))}
        {points.map((p, i) => (
          <text key={`lbl-${i}`} x={toX(i)} y={height - 4}
            textAnchor="middle" fill="var(--color-ink-2)" fontSize="9"
          >
            {p.month.slice(5)}
          </text>
        ))}
        <text x={padX - 4} y={padY + 3} textAnchor="end" fill="var(--color-ink-2)" fontSize="9">
          +${formatCurrency(maxVal)}
        </text>
        <text x={padX - 4} y={height - padY + 3} textAnchor="end" fill="var(--color-ink-2)" fontSize="9">
          {minVal < 0 ? `-$${formatCurrency(Math.abs(minVal))}` : "$0"}
        </text>
      </svg>
    </div>
  );
}

function PnLBar({ value, max }: { value: number; max: number }) {
  if (max === 0) return null;
  const pct = Math.min(100, (Math.abs(value) / max) * 100);
  const isPositive = value >= 0;
  return (
    <div className="pnl-bar-track">
      <div
        className={`pnl-bar-fill ${isPositive ? "pnl-bar-positive" : "pnl-bar-negative"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function PerformanceView({ portfolios }: { portfolios: PortfolioItem[] }) {
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<number | undefined>(undefined);

  const { data, isLoading, error } = useQuery({
    queryKey: ["performance", selectedPortfolioId ?? "all"],
    queryFn: () => fetchPerformance(selectedPortfolioId),
  });

  const monthly = data?.monthly ?? [];
  const closedTrades = data?.closedTrades ?? [];
  const byStrategy = data?.byStrategy ?? [];

  const totals = monthly.reduce(
    (acc, m) => ({
      pnl: acc.pnl + m.realizedPnL,
      closed: acc.closed + m.closedTrades,
      wins: acc.wins + m.winningTrades,
      losses: acc.losses + m.losingTrades,
    }),
    { pnl: 0, closed: 0, wins: 0, losses: 0 }
  );

  const overallWinRate = totals.closed > 0
    ? Math.round((totals.wins / totals.closed) * 1000) / 10
    : 0;

  const maxAbsPnL = monthly.length > 0
    ? Math.max(...monthly.map((m) => Math.abs(m.realizedPnL)), 1)
    : 1;

  return (
    <>
      <h1>Performance</h1>
      <p className="perf-subtitle">Month-to-month trade P&L from closed positions.</p>

      <div className="perf-filter">
        <label>
          Portfolio{" "}
          <select
            value={selectedPortfolioId ?? ""}
            onChange={(e) =>
              setSelectedPortfolioId(e.target.value ? parseInt(e.target.value, 10) : undefined)
            }
          >
            <option value="">All portfolios</option>
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading && <p>Loading performance data…</p>}
      {error && <p className="error-msg">{String(error)}</p>}

      {monthly.length > 0 && (
        <div className="perf-summary">
          <div className="perf-summary-card">
            <span className={`perf-summary-value ${totals.pnl >= 0 ? "perf-positive" : "perf-negative"}`}>
              {totals.pnl >= 0 ? "+" : ""}${formatCurrency(totals.pnl)}
            </span>
            <span className="perf-summary-label">Total P&L</span>
          </div>
          <div className="perf-summary-card">
            <span className="perf-summary-value">{totals.closed}</span>
            <span className="perf-summary-label">Closed Trades</span>
          </div>
          <div className="perf-summary-card">
            <span className="perf-summary-value perf-positive">{totals.wins}</span>
            <span className="perf-summary-label">Winners</span>
          </div>
          <div className="perf-summary-card">
            <span className="perf-summary-value perf-negative">{totals.losses}</span>
            <span className="perf-summary-label">Losers</span>
          </div>
          <div className="perf-summary-card">
            <span className={`perf-summary-value ${overallWinRate >= 50 ? "perf-positive" : "perf-negative"}`}>
              {overallWinRate}%
            </span>
            <span className="perf-summary-label">Win Rate</span>
          </div>
        </div>
      )}

      {monthly.length === 0 && !isLoading && (
        <p className="perf-empty">No closed trades yet. Performance tracks realized P&L when positions are sold.</p>
      )}

      {monthly.length > 0 && (
        <>
          <h2>Monthly P&L</h2>
          <table className="perf-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>P&L</th>
                <th>Closed</th>
                <th>Win Rate</th>
                <th>Bought</th>
                <th>Sold</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m: MonthlyPerformance) => (
                <tr key={m.month}>
                  <td className="perf-month">{m.month}</td>
                  <td className={m.realizedPnL >= 0 ? "perf-positive" : "perf-negative"}>
                    {m.realizedPnL >= 0 ? "+" : ""}${formatCurrency(m.realizedPnL)}
                  </td>
                  <td>{m.closedTrades}</td>
                  <td className={m.winRate >= 50 ? "perf-positive" : "perf-negative"}>
                    {m.winRate}%
                  </td>
                  <td>${formatCurrency(m.totalBought)}</td>
                  <td>${formatCurrency(m.totalSold)}</td>
                  <td className="perf-bar-cell">
                    <PnLBar value={m.realizedPnL} max={maxAbsPnL} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {byStrategy.length > 0 && (
        <>
          <h2>Performance by Strategy</h2>
          <table className="perf-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>P&L</th>
                <th>Trades</th>
                <th>Win Rate</th>
              </tr>
            </thead>
            <tbody>
              {byStrategy.map((s: StrategyPerformance) => (
                <tr key={s.strategy}>
                  <td className="perf-month">{s.strategy}</td>
                  <td className={s.realizedPnL >= 0 ? "perf-positive" : "perf-negative"}>
                    {s.realizedPnL >= 0 ? "+" : ""}${formatCurrency(s.realizedPnL)}
                  </td>
                  <td>{s.closedTrades}</td>
                  <td className={s.winRate >= 50 ? "perf-positive" : "perf-negative"}>
                    {s.winRate}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {byStrategy.filter((s) => s.monthlyPnL.length > 1).map((s) => (
            <StrategyChart key={s.strategy} strategy={s} />
          ))}
        </>
      )}

      {closedTrades.length > 0 && (
        <>
          <h2>Recent Closed Trades</h2>
          <table className="perf-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Shares</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>P&L</th>
                <th>Return</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {closedTrades.map((t, i) => (
                <tr key={`${t.symbol}-${t.closedAt}-${i}`}>
                  <td className="perf-month">{t.symbol}</td>
                  <td>{t.shares}</td>
                  <td>${formatCurrency(t.buyPrice)}</td>
                  <td>${formatCurrency(t.sellPrice)}</td>
                  <td className={t.pnl >= 0 ? "perf-positive" : "perf-negative"}>
                    {t.pnl >= 0 ? "+" : ""}${formatCurrency(t.pnl)}
                  </td>
                  <td className={t.pnlPercent >= 0 ? "perf-positive" : "perf-negative"}>
                    {t.pnlPercent >= 0 ? "+" : ""}{t.pnlPercent}%
                  </td>
                  <td>{new Date(t.closedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  canWrite,
}: {
  loginInProgress: boolean;
  onLogin: (id: number) => void;
  strategyMutation: ReturnType<typeof usePortfolioStrategyMutation>;
  portfolioUrlEnvOverride: boolean;
  canWrite: boolean;
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
      <p>
        Add portfolios and link each to Schwab (OAuth) or Tradier (API key). Choose one or more
        SystemTrader signal sources per portfolio.
      </p>
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
            onSlugsChange={(id, slugs) =>
              strategyMutation.mutate({ portfolioId: id, slugs })
            }
            strategyUpdatePending={strategyMutation.isPending}
            canWrite={canWrite}
          />
        ))}
      </ul>
      {strategyMutation.isError && (
        <p className="error-msg">{String(strategyMutation.error)}</p>
      )}

      {canWrite && (
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
      )}

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

  const [authEnabled, setAuthEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);

  useEffect(() => {
    fetchAuthStatus(getAuthToken()).then((status) => {
      setAuthEnabled(status.authEnabled);
      setAuthenticated(status.authenticated);
    }).catch(() => {});
  }, []);

  const handleLogout = async () => {
    const token = getAuthToken();
    if (token) {
      await logout(token).catch(() => {});
    }
    setAuthToken(null);
    setAuthenticated(false);
  };

  const handleLoginSuccess = () => {
    setAuthenticated(true);
    setShowLoginModal(false);
  };

  const canWrite = !authEnabled || authenticated;

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
      <Nav
        route={route}
        authEnabled={authEnabled}
        authenticated={authenticated}
        onLoginClick={() => setShowLoginModal(true)}
        onLogout={handleLogout}
      />
      {showLoginModal && (
        <LoginModal
          onClose={() => setShowLoginModal(false)}
          onSuccess={handleLoginSuccess}
        />
      )}
      {route.view === "dashboard" && (
        <DashboardView
          loginInProgress={loginInProgress}
          onLogin={handleLogin}
          strategyMutation={strategyMutation}
          portfolioUrlEnvOverride={portfolioUrlEnvOverride}
          canWrite={canWrite}
        />
      )}
      {route.view === "portfolios" && (
        <PortfoliosView
          loginInProgress={loginInProgress}
          onLogin={handleLogin}
          strategyMutation={strategyMutation}
          portfolioUrlEnvOverride={portfolioUrlEnvOverride}
          canWrite={canWrite}
        />
      )}
      {route.view === "performance" && (
        <PerformanceView portfolios={portfolios} />
      )}
      {route.view === "portfolio-detail" && route.portfolioId != null && (
        <PortfolioDetailView
          portfolioId={route.portfolioId}
          portfolios={portfolios}
          strategyMutation={strategyMutation}
          portfolioUrlEnvOverride={portfolioUrlEnvOverride}
          canWrite={canWrite}
        />
      )}
    </>
  );
}

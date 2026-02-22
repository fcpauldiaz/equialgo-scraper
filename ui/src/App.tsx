import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useEffect } from "react";
import {
  fetchPortfolios,
  createPortfolio,
  startSchwabLogin,
  verifyPortfolio,
  type PortfolioItem,
} from "./api";

const PORTFOLIOS_QUERY_KEY = ["portfolios"] as const;

function usePortfolios() {
  return useQuery({
    queryKey: PORTFOLIOS_QUERY_KEY,
    queryFn: fetchPortfolios,
  });
}

function useCreatePortfolio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createPortfolio(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
    },
  });
}

function useStartSchwabLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (portfolioId: number) => startSchwabLogin(portfolioId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
    },
  });
}

function useVerifyPortfolio() {
  return useMutation({
    mutationFn: (portfolioId: number) => verifyPortfolio(portfolioId),
  });
}

function PortfolioRow({
  portfolio,
  loginInProgress,
  onLogin,
}: {
  portfolio: PortfolioItem;
  loginInProgress: boolean;
  onLogin: (id: number) => void;
}) {
  const verifyMutation = useVerifyPortfolio();
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

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

  return (
    <li className="portfolio-row">
      <span className="portfolio-name">{portfolio.name}</span>
      <span className={`status ${portfolio.hasCredentials ? "connected" : "disconnected"}`}>
        {portfolio.hasCredentials ? "Connected" : "Not connected"}
      </span>
      <div className="portfolio-actions">
        <button
          type="button"
          onClick={() => onLogin(portfolio.id)}
          disabled={loginInProgress}
        >
          Login with Schwab
        </button>
        <button
          type="button"
          onClick={handleVerify}
          disabled={verifyMutation.isPending}
        >
          Verify
        </button>
        {verifyMsg !== null && <span className="verify-msg">{verifyMsg}</span>}
      </div>
    </li>
  );
}

export default function App() {
  const { data: portfolios = [], isLoading, error } = usePortfolios();
  const createMutation = useCreatePortfolio();
  const loginMutation = useStartSchwabLogin();
  const [name, setName] = useState("");
  const [loginInProgress, setLoginInProgress] = useState(false);
  const loginPopupRef = useRef<Window | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "schwab-login-done") {
        setLoginInProgress(false);
        queryClient.invalidateQueries({ queryKey: PORTFOLIOS_QUERY_KEY });
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
      }
    }, 300);
    return () => clearInterval(id);
  }, [loginInProgress, queryClient]);

  const handleAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed, {
      onSuccess: () => setName(""),
    });
  };

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
      <h1>Portfolios</h1>
      <p>Add portfolios and link each to a Schwab account via OAuth.</p>

      {isLoading && <p>Loading…</p>}
      {error && <p className="error-msg">{String(error)}</p>}

      <ul>
        {portfolios.map((p) => (
          <PortfolioRow
            key={p.id}
            portfolio={p}
            loginInProgress={loginInProgress}
            onLogin={handleLogin}
          />
        ))}
      </ul>

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

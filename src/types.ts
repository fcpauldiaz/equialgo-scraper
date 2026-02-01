export interface Signal {
  symbol: string;
  action: "ENTER" | "EXIT" | "KEEP";
  score: number;
  rank: number;
  current_price: number;
}

export interface Holding {
  symbol: string;
  shares: number;
  avg_cost: number;
  current_price: number;
  current_value: number;
  pnl: number;
  pnl_percent: number;
}

export interface Trade {
  date: string;
  symbol: string;
  action: "BUY" | "SELL";
  price: number;
  shares: number;
  value: number;
  pre_trade_shares: number;
  shares_after: number;
  close_price: number;
  position_value_open: number;
  position_value_close: number;
  portfolio_impact: number;
  daily_change: number;
}

export interface PortfolioAction {
  symbol: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
}

export interface ScrapedPortfolioData {
  date: string;
  actions: PortfolioAction[];
}

export interface Snapshot {
  date: string;
  holdings: Holding[];
  cash: number;
  portfolio_value: number;
  overnight_change: number;
  overnight_change_percent: number;
  peak_value: number;
  drawdown: number;
  drawdown_percent: number;
  signals: Signal[];
  trades_today: Trade[];
}

export interface BacktestData {
  initial_capital: number;
  final_capital: number;
  total_return: number;
  total_return_percent: number;
  total_trades: number;
  snapshots: Snapshot[];
}

export interface ProcessedSignals {
  enterSignals: (Signal & { shares: number; allocation: number })[];
  keepSignals: (Signal & { shares: number; allocation: number })[];
  exitSignals: Signal[];
  date: string;
}

export interface TradeExecutionResult {
  symbol: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
  success: boolean;
  error?: string;
  orderId?: string;
}

export interface TradeExecutionSummary {
  successful: TradeExecutionResult[];
  failed: TradeExecutionResult[];
  skipped: Array<{ symbol: string; reason: string }>;
}

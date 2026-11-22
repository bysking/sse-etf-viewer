CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  strategy_version_id TEXT,
  config_snapshot TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  code_hash TEXT,
  data_version TEXT,
  symbol TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  metrics_json TEXT,
  equity_json TEXT,
  trades_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_version
  ON backtest_runs(strategy_version_id);

CREATE TABLE IF NOT EXISTS paper_accounts (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  ledger TEXT NOT NULL,
  cash REAL NOT NULL,
  units INTEGER NOT NULL,
  sellable_units INTEGER NOT NULL,
  avg_cost REAL NOT NULL,
  last_equity REAL,
  updated_at TEXT NOT NULL,
  UNIQUE(strategy_id, ledger)
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  signal_id TEXT,
  ledger TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER NOT NULL,
  signal_date TEXT NOT NULL,
  stop_level REAL,
  fill_date TEXT,
  fill_price REAL,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL,
  trade_date TEXT NOT NULL,
  signal_id TEXT,
  pnl REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  range_id TEXT,
  event_type TEXT NOT NULL,
  occurred_at TEXT,
  detected_at TEXT NOT NULL,
  action TEXT NOT NULL,
  price REAL,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  UNIQUE(strategy_id, symbol, range_id, event_type, occurred_at, detected_at, action)
);

CREATE TABLE IF NOT EXISTS strategy_state (
  strategy_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  last_bar TEXT,
  last_phase TEXT,
  last_confidence REAL,
  last_action TEXT,
  last_event_key TEXT,
  state_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_log (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  signal_id TEXT,
  payload_preview TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 不可变策略版本：AI 生成 / 手工编辑都先落成 draft，校验后才是 validated，人工审核后 active
CREATE TABLE IF NOT EXISTS strategy_versions (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL,
  code TEXT,
  code_hash TEXT,
  manifest_json TEXT,
  engine_version TEXT NOT NULL,
  status TEXT NOT NULL,
  provenance_json TEXT,
  validation_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(strategy_id, version)
);

CREATE INDEX IF NOT EXISTS idx_strategy_versions_strategy
  ON strategy_versions(strategy_id, version DESC);

-- AI 调用用量：用于成本可见性，只记 token 与元信息，不记提示词全文
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- analyze | strategy | chat | test
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  symbol TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created
  ON ai_usage(created_at DESC);

-- 分红/除息事件：yunhq 日K不复权，用它把价格序列换算成前复权
CREATE TABLE IF NOT EXISTS dividend_events (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  amount REAL NOT NULL,          -- 每股分红金额（元），由跳空幅度反推
  drop_pct REAL NOT NULL,        -- 相对基准的额外低开幅度，正数
  source TEXT NOT NULL,          -- auto | manual
  confirmed INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(code, ex_date)
);

CREATE INDEX IF NOT EXISTS idx_dividend_code_date
  ON dividend_events(code, ex_date);

CREATE INDEX IF NOT EXISTS idx_signals_strategy_date
  ON signals(strategy_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_orders_status
  ON paper_orders(status, signal_date);
CREATE INDEX IF NOT EXISTS idx_notify_log_created
  ON notify_log(created_at);

-- 人工模拟训练：一次「从头开始按 K 线推进做决策」的练习会话。
-- user_name 只是输入的用户名（无密码、无鉴权），用于把不同人的记录隔开。
CREATE TABLE IF NOT EXISTS training_sessions (
  id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  symbol_name TEXT,
  timeframe TEXT NOT NULL,          -- 1w | 1d | 60m | 30m | 15m | 5m
  start_date TEXT NOT NULL,         -- 用户指定的开始训练日期
  actual_start TEXT NOT NULL,       -- 实际第一根 bar 的时间（数据不足时会晚于 start_date）
  initial_cash REAL NOT NULL,
  position_pct REAL NOT NULL,       -- 每次买入使用「当前现金 × 该比例」
  cursor INTEGER NOT NULL DEFAULT 0,-- 已推进到第几根 bar（不包含）
  cash REAL NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | finished
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_training_sessions_user
  ON training_sessions(user_name, created_at DESC);

CREATE TABLE IF NOT EXISTS training_trades (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,             -- 该会话内第几笔
  bar_index INTEGER NOT NULL,       -- 成交时推进到的 bar 下标
  bar_ts TEXT NOT NULL,             -- 成交 bar 的时间键
  side TEXT NOT NULL,               -- buy | sell
  qty INTEGER NOT NULL,
  price REAL NOT NULL,
  cash_after REAL NOT NULL,
  units_after INTEGER NOT NULL,
  avg_cost_after REAL NOT NULL,
  pnl REAL,                         -- 仅卖出时有值（已实现盈亏）
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_training_trades_session
  ON training_trades(session_id, seq);

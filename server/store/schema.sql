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
  config_snapshot TEXT NOT NULL,
  engine_version TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_signals_strategy_date
  ON signals(strategy_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_orders_status
  ON paper_orders(status, signal_date);
CREATE INDEX IF NOT EXISTS idx_notify_log_created
  ON notify_log(created_at);

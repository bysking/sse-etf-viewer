// 策略 / 回测任务的基础仓储。所有 JSON 字段在读写边界做序列化/反序列化。
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'

const now = () => new Date().toISOString()
const parse = (s, fallback = null) => {
  if (s == null) return fallback
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

const mapStrategy = (row) =>
  row
    ? {
        id: row.id,
        name: row.name,
        config: parse(row.config_json, {}),
        engineVersion: row.engine_version,
        enabled: !!row.enabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null

const mapRun = (row) =>
  row
    ? {
        id: row.id,
        strategyId: row.strategy_id,
        configSnapshot: parse(row.config_snapshot, {}),
        engineVersion: row.engine_version,
        symbol: row.symbol,
        start: row.start,
        end: row.end,
        status: row.status,
        progress: row.progress,
        metrics: parse(row.metrics_json, null),
        equity: parse(row.equity_json, null),
        trades: parse(row.trades_json, null),
        error: row.error,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      }
    : null

export function createStrategy({ name, config, engineVersion = 'wyckoff-v1', enabled = true }) {
  const db = getDb()
  const id = randomUUID()
  const ts = now()
  db.prepare(
    `INSERT INTO strategies (id, name, config_json, engine_version, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, String(name), JSON.stringify(config ?? {}), engineVersion, enabled ? 1 : 0, ts, ts)
  return getStrategy(id)
}

export function getStrategy(id) {
  const row = getDb().prepare('SELECT * FROM strategies WHERE id = ?').get(id)
  return mapStrategy(row)
}

export function listStrategies() {
  return getDb()
    .prepare('SELECT * FROM strategies ORDER BY updated_at DESC')
    .all()
    .map(mapStrategy)
}

export function updateStrategy(id, patch = {}) {
  const cur = getStrategy(id)
  if (!cur) return null
  const name = patch.name != null ? String(patch.name) : cur.name
  const config = patch.config != null ? patch.config : cur.config
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled ? 1 : 0
  getDb()
    .prepare('UPDATE strategies SET name = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?')
    .run(name, JSON.stringify(config), enabled, now(), id)
  return getStrategy(id)
}

export function deleteStrategy(id) {
  const r = getDb().prepare('DELETE FROM strategies WHERE id = ?').run(id)
  return r.changes > 0
}

export function createRun({ strategyId, configSnapshot, engineVersion, symbol, start, end }) {
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO backtest_runs
     (id, strategy_id, config_snapshot, engine_version, symbol, start, end, status, progress, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
  ).run(id, strategyId, JSON.stringify(configSnapshot ?? {}), engineVersion, symbol, start, end, now())
  return getRun(id)
}

export function getRun(id) {
  const row = getDb().prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id)
  return mapRun(row)
}

export function listRuns(strategyId) {
  return getDb()
    .prepare('SELECT * FROM backtest_runs WHERE strategy_id = ? ORDER BY created_at DESC')
    .all(strategyId)
    .map(mapRun)
}

export function setRunProgress(id, status, progress) {
  getDb().prepare('UPDATE backtest_runs SET status = ?, progress = ? WHERE id = ?').run(status, progress, id)
}

export function finishRun(id, { metrics, equity, trades }) {
  getDb()
    .prepare(
      `UPDATE backtest_runs
       SET status = 'done', progress = 1, metrics_json = ?, equity_json = ?, trades_json = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(metrics ?? null), JSON.stringify(equity ?? null), JSON.stringify(trades ?? null), now(), id)
}

export function failRun(id, error) {
  getDb()
    .prepare(`UPDATE backtest_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
    .run(String(error ?? 'unknown error'), now(), id)
}

export function insertSignal(signal) {
  const id = signal.id || randomUUID()
  const ts = now()
  try {
    getDb()
      .prepare(
        `INSERT INTO signals
         (id, strategy_id, symbol, range_id, event_type, occurred_at, detected_at, action, price, evidence_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        signal.strategyId,
        signal.symbol,
        signal.rangeId ?? null,
        signal.eventType,
        signal.occurredAt ?? null,
        signal.detectedAt,
        signal.action,
        signal.price ?? null,
        JSON.stringify(signal.evidence ?? {}),
        signal.status ?? 'candidate',
        ts,
      )
    return { ...signal, id, createdAt: ts }
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e.message)) return null
    throw e
  }
}

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value_json)
  } catch {
    return fallback
  }
}

export function setSetting(key, value) {
  const ts = now()
  getDb()
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value ?? null), ts)
  return value
}

export function listSignals(strategyId, limit = 100) {
  const rows = getDb()
    .prepare('SELECT * FROM signals WHERE strategy_id = ? ORDER BY detected_at DESC LIMIT ?')
    .all(strategyId, limit)
  return rows.map((r) => ({
    id: r.id,
    strategyId: r.strategy_id,
    symbol: r.symbol,
    rangeId: r.range_id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    detectedAt: r.detected_at,
    action: r.action,
    price: r.price,
    evidence: parse(r.evidence_json, {}),
    status: r.status,
    createdAt: r.created_at,
  }))
}

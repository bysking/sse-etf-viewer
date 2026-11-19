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
        strategyVersionId: row.strategy_version_id ?? null,
        configSnapshot: parse(row.config_snapshot, {}),
        engineVersion: row.engine_version,
        codeHash: row.code_hash ?? null,
        dataVersion: row.data_version ?? null,
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
  getDb().prepare('DELETE FROM strategy_versions WHERE strategy_id = ?').run(id)
  const r = getDb().prepare('DELETE FROM strategies WHERE id = ?').run(id)
  return r.changes > 0
}

/* ---------------------------- 策略版本 ---------------------------- */

export const VERSION_STATUSES = ['draft', 'validated', 'active', 'archived']

const mapVersion = (row) =>
  row
    ? {
        id: row.id,
        strategyId: row.strategy_id,
        version: row.version,
        kind: row.kind,
        config: parse(row.config_json, {}),
        code: row.code ?? null,
        codeHash: row.code_hash ?? null,
        manifest: parse(row.manifest_json, null),
        engineVersion: row.engine_version,
        status: row.status,
        provenance: parse(row.provenance_json, null),
        validation: parse(row.validation_json, null),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null

function nextVersion(strategyId) {
  const row = getDb()
    .prepare('SELECT MAX(version) AS v FROM strategy_versions WHERE strategy_id = ?')
    .get(strategyId)
  return (Number(row?.v) || 0) + 1
}

export function createStrategyVersion({
  strategyId,
  kind = 'dsl',
  config,
  code = null,
  codeHash = null,
  manifest = null,
  engineVersion = 'wyckoff-v1',
  status = 'draft',
  provenance = null,
  validation = null,
}) {
  if (!VERSION_STATUSES.includes(status)) throw new Error(`未知版本状态：${status}`)
  if (kind !== 'dsl' && kind !== 'js') throw new Error('kind 仅支持 dsl / js')
  const db = getDb()
  const id = randomUUID()
  const ts = now()
  const version = nextVersion(strategyId)
  db.prepare(
    `INSERT INTO strategy_versions
     (id, strategy_id, version, kind, config_json, code, code_hash, manifest_json,
      engine_version, status, provenance_json, validation_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    strategyId,
    version,
    kind,
    JSON.stringify(config ?? {}),
    code,
    codeHash,
    manifest == null ? null : JSON.stringify(manifest),
    engineVersion,
    status,
    provenance == null ? null : JSON.stringify(provenance),
    validation == null ? null : JSON.stringify(validation),
    ts,
    ts,
  )
  return getStrategyVersion(id)
}

export function getStrategyVersion(id) {
  return mapVersion(getDb().prepare('SELECT * FROM strategy_versions WHERE id = ?').get(id))
}

export function listStrategyVersions(strategyId) {
  return getDb()
    .prepare('SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC')
    .all(strategyId)
    .map(mapVersion)
}

export function getLatestStrategyVersion(strategyId) {
  return mapVersion(
    getDb()
      .prepare('SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC LIMIT 1')
      .get(strategyId),
  )
}

export function getActiveStrategyVersion(strategyId) {
  return mapVersion(
    getDb()
      .prepare(`SELECT * FROM strategy_versions WHERE strategy_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`)
      .get(strategyId),
  )
}

/** 版本内容不可变；只允许更新状态、校验结果和 provenance */
export function setStrategyVersionStatus(id, status, { validation = null } = {}) {
  if (!VERSION_STATUSES.includes(status)) throw new Error(`未知版本状态：${status}`)
  const cur = getStrategyVersion(id)
  if (!cur) return null
  if (status === 'active') {
    // 同一策略只能有一个 active 版本
    getDb()
      .prepare(`UPDATE strategy_versions SET status = 'archived', updated_at = ? WHERE strategy_id = ? AND status = 'active'`)
      .run(now(), cur.strategyId)
  }
  getDb()
    .prepare('UPDATE strategy_versions SET status = ?, validation_json = COALESCE(?, validation_json), updated_at = ? WHERE id = ?')
    .run(status, validation == null ? null : JSON.stringify(validation), now(), id)
  return getStrategyVersion(id)
}

export function setStrategyVersionValidation(id, validation) {
  const cur = getStrategyVersion(id)
  if (!cur) return null
  getDb()
    .prepare('UPDATE strategy_versions SET validation_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(validation ?? null), now(), id)
  return getStrategyVersion(id)
}

export function createRun({
  strategyId,
  strategyVersionId = null,
  configSnapshot,
  engineVersion,
  codeHash = null,
  dataVersion = null,
  symbol,
  start,
  end,
}) {
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO backtest_runs
     (id, strategy_id, strategy_version_id, config_snapshot, engine_version, code_hash, data_version,
      symbol, start, end, status, progress, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
  ).run(
    id,
    strategyId,
    strategyVersionId,
    JSON.stringify(configSnapshot ?? {}),
    engineVersion,
    codeHash,
    dataVersion,
    symbol,
    start,
    end,
    now(),
  )
  return getRun(id)
}

export function listRunsByVersion(versionId) {
  return getDb()
    .prepare('SELECT * FROM backtest_runs WHERE strategy_version_id = ? ORDER BY created_at DESC')
    .all(versionId)
    .map(mapRun)
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

export function setRunDataVersion(id, dataVersion) {
  getDb().prepare('UPDATE backtest_runs SET data_version = ? WHERE id = ?').run(dataVersion ?? null, id)
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

/* ---------------------------- 策略运行状态 ---------------------------- */

export function getStrategyState(strategyId) {
  const row = getDb().prepare('SELECT * FROM strategy_state WHERE strategy_id = ?').get(strategyId)
  if (!row) return null
  const parsed = parse(row.state_json, {})
  return {
    strategyId: row.strategy_id,
    symbol: row.symbol,
    lastBar: row.last_bar,
    lastPhase: row.last_phase,
    lastConfidence: row.last_confidence,
    lastAction: row.last_action,
    lastEventKey: row.last_event_key,
    updatedAt: row.updated_at,
    // 扩展字段（持仓、账本状态）存在 state_json 里，避免频繁改表
    ...parsed,
  }
}

export function setStrategyState(strategyId, patch = {}) {
  const cur = getStrategyState(strategyId) || {}
  const next = { ...cur, ...patch }
  const db = getDb()
  const ts = now()
  db.prepare(
    `INSERT INTO strategy_state
     (strategy_id, symbol, last_bar, last_phase, last_confidence, last_action, last_event_key, state_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(strategy_id) DO UPDATE SET
       symbol = excluded.symbol,
       last_bar = excluded.last_bar,
       last_phase = excluded.last_phase,
       last_confidence = excluded.last_confidence,
       last_action = excluded.last_action,
       last_event_key = excluded.last_event_key,
       state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
  ).run(
    strategyId,
    next.symbol ?? '',
    next.lastBar ?? null,
    next.lastPhase ?? null,
    next.lastConfidence ?? null,
    next.lastAction ?? null,
    next.lastEventKey ?? null,
    JSON.stringify({ holding: next.holding ?? false, ...(next.extra ?? {}) }),
    ts,
  )
  return getStrategyState(strategyId)
}

/* ---------------------------- 分红 / 除息 ---------------------------- */

const mapDividend = (row) =>
  row
    ? {
        id: row.id,
        code: row.code,
        exDate: row.ex_date,
        amount: row.amount,
        dropPct: row.drop_pct,
        source: row.source,
        confirmed: !!row.confirmed,
        note: row.note,
        createdAt: row.created_at,
      }
    : null

export function listDividends(code, { onlyConfirmed = false } = {}) {
  const sql = onlyConfirmed
    ? 'SELECT * FROM dividend_events WHERE code = ? AND confirmed = 1 ORDER BY ex_date'
    : 'SELECT * FROM dividend_events WHERE code = ? ORDER BY ex_date'
  return getDb()
    .prepare(sql)
    .all(code)
    .map(mapDividend)
}

/** 人工确认/取消确认（confirmed=1 才参与复权） */
export function setDividendConfirmed(id, confirmed = true) {
  const r = getDb()
    .prepare('UPDATE dividend_events SET confirmed = ?, source = ? WHERE id = ?')
    .run(confirmed ? 1 : 0, 'manual', id)
  return r.changes > 0
}

/** 写入自动识别的除息事件；已人工确认的记录不被覆盖 */
export function upsertDividends(code, items = [], { source = 'auto' } = {}) {
  const db = getDb()
  let added = 0
  for (const it of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) continue
    const existing = db.prepare('SELECT id, confirmed FROM dividend_events WHERE code = ? AND ex_date = ?').get(code, it.date)
    if (existing) {
      if (existing.confirmed) continue
      db.prepare('UPDATE dividend_events SET amount = ?, drop_pct = ?, source = ? WHERE id = ?').run(
        Number(it.amount) || 0,
        Number(it.dropPct) || 0,
        source,
        existing.id,
      )
      continue
    }
    db.prepare(
      `INSERT INTO dividend_events (id, code, ex_date, amount, drop_pct, source, confirmed, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    ).run(randomUUID(), code, it.date, Number(it.amount) || 0, Number(it.dropPct) || 0, source, now())
    added++
  }
  return added
}

export function deleteDividend(id) {
  return getDb().prepare('DELETE FROM dividend_events WHERE id = ?').run(id).changes > 0
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

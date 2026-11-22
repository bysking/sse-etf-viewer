// 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给已有表补列，这里按需 ALTER。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DB_FILE = () => path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'app.db')

/** 需要补齐的列：[表, 列, 列定义] */
const COLUMNS = [
  ['backtest_runs', 'strategy_version_id', 'TEXT'],
  ['backtest_runs', 'code_hash', 'TEXT'],
  ['backtest_runs', 'data_version', 'TEXT'],
  ['paper_orders', 'stop_level', 'REAL'],
  ['strategy_state', 'state_json', 'TEXT'],
  ['training_trades', 'pnl', 'REAL'],
  ['training_trades', 'ratio', 'REAL'],
]

function existingColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name))
  } catch {
    return new Set()
  }
}

/** 对已存在的库补齐新增列；返回补了哪些列，便于日志和测试断言 */
export function migrate(db) {
  const added = []
  for (const [table, column, type] of COLUMNS) {
    const cols = existingColumns(db, table)
    if (!cols.size) continue // 表还不存在，schema.sql 会建
    if (cols.has(column)) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    added.push(`${table}.${column}`)
  }
  // 迁移后补索引（旧库里没有）
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_backtest_runs_version ON backtest_runs(strategy_version_id)')
  } catch {
    /* 索引已存在或表不存在 */
  }
  return added
}

export { DB_FILE }

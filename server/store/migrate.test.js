import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrate.js'

/** 模拟旧版库：backtest_runs 缺少后来新增的列 */
function legacyDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE backtest_runs (
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
    )
  `)
  return db
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)

test('migrate：给旧库补上新增列', () => {
  const db = legacyDb()
  try {
    const before = columns(db, 'backtest_runs')
    assert.ok(!before.includes('strategy_version_id'))

    const added = migrate(db)
    assert.deepEqual(added.sort(), ['backtest_runs.code_hash', 'backtest_runs.data_version', 'backtest_runs.strategy_version_id'])

    const after = columns(db, 'backtest_runs')
    for (const c of ['strategy_version_id', 'code_hash', 'data_version']) assert.ok(after.includes(c))
    // 原有数据不受影响
    db.prepare(
      `INSERT INTO backtest_runs (id, strategy_id, config_snapshot, engine_version, symbol, start, end, status, created_at)
       VALUES ('r1','s1','{}','wyckoff-v1','510300','2024-01-01','2024-06-30','done','2024-07-01')`,
    ).run()
    const row = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get('r1')
    assert.equal(row.symbol, '510300')
    assert.equal(row.strategy_version_id, null)
  } finally {
    db.close()
  }
})

test('migrate：已是最新结构时不重复加列', () => {
  const db = legacyDb()
  try {
    migrate(db)
    assert.deepEqual(migrate(db), [], '第二次迁移应无操作')
  } finally {
    db.close()
  }
})

test('migrate：表不存在时跳过，不抛错', () => {
  const db = new DatabaseSync(':memory:')
  try {
    assert.deepEqual(migrate(db), [])
  } finally {
    db.close()
  }
})

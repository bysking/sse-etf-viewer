import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from './db.js'

test('SQLite schema 可用，策略可读写', () => {
  const db = openDatabase(':memory:')
  try {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO strategies (id, name, config_json, engine_version, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('s1', '测试策略', '{}', 'wyckoff-v1', 1, now, now)
    const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get('s1')
    assert.equal(row.name, '测试策略')
    assert.equal(row.engine_version, 'wyckoff-v1')
  } finally {
    db.close()
  }
})

test('signals 唯一约束保证重复计算不重复写入', () => {
  const db = openDatabase(':memory:')
  try {
    const west = new Date().toISOString()
    const run = () =>
      db
        .prepare(
          `INSERT INTO signals
           (id, strategy_id, symbol, range_id, event_type, occurred_at, detected_at, action, price, evidence_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('sig1', 's1', '510300', 'R-2024-01-01', 'Spring', '2024-01-10', '2024-01-10', 'entry_candidate', 4.0, '{}', 'candidate', west)
    run()
    assert.throws(run, /UNIQUE|constraint/i)
    const count = db.prepare('SELECT COUNT(*) AS n FROM signals').get().n
    assert.equal(count, 1)
  } finally {
    db.close()
  }
})

test('paper_accounts 同一策略的 rule/manual 两个账本可并存，但同账本唯一', () => {
  const db = openDatabase(':memory:')
  try {
    const now = new Date().toISOString()
    const insert = (id, ledger) =>
      db
        .prepare(
          `INSERT INTO paper_accounts
           (id, strategy_id, symbol, ledger, cash, units, sellable_units, avg_cost, last_equity, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, 's1', '510300', ledger, 100000, 0, 0, 0, 100000, now)
    insert('a1', 'rule')
    insert('a2', 'manual')
    assert.throws(() => insert('a3', 'rule'), /UNIQUE|constraint/i)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_accounts').get().n, 2)
  } finally {
    db.close()
  }
})

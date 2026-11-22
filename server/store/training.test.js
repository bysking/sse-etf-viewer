import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-training-'))
process.env.DATA_DIR = dir

const repo = await import('./repositories.js')
const { closeDb } = await import('./db.js')

after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

const base = {
  symbol: '510300',
  symbolName: '沪深300ETF',
  timeframe: '1d',
  startDate: '2024-01-01',
  actualStart: '2024-01-02',
  initialCash: 100000,
  positionPct: 0.3,
}

test('createTrainingSession：初始账户状态与游标', () => {
  const s = repo.createTrainingSession({ userName: 'alice', ...base, cursor: 30 })
  assert.ok(s.id)
  assert.equal(s.userName, 'alice')
  assert.equal(s.cash, 100000)
  assert.equal(s.units, 0)
  assert.equal(s.avgCost, 0)
  assert.equal(s.cursor, 30)
  assert.equal(s.status, 'active')
})

test('用户名规范化：去空白、拒绝空值', () => {
  assert.equal(repo.normalizeUserName('  alice  '), 'alice')
  assert.throws(() => repo.normalizeUserName('   '), /用户名不能为空/)
  assert.throws(() => repo.normalizeUserName(null), /用户名不能为空/)
})

test('不支持的时间周期被拒绝', () => {
  assert.throws(() => repo.createTrainingSession({ userName: 'bob', ...base, timeframe: '3m' }), /不支持的周期/)
})

test('用户隔离：别人的会话查不到', () => {
  const s = repo.createTrainingSession({ userName: 'alice2', ...base })
  assert.ok(repo.getTrainingSession(s.id, { userName: 'alice2' }))
  assert.equal(repo.getTrainingSession(s.id, { userName: 'bob2' }), null)
  // 不传 userName 时不校验归属（内部调用用）
  assert.ok(repo.getTrainingSession(s.id))
})

test('listTrainingSessions：只返回自己的，按创建时间倒序', () => {
  repo.createTrainingSession({ userName: 'carol', ...base })
  repo.createTrainingSession({ userName: 'carol', ...base, symbol: '510050' })
  const mine = repo.listTrainingSessions('carol')
  assert.equal(mine.length, 2)
  assert.ok(mine.every((s) => s.userName === 'carol'))
  assert.equal(repo.listTrainingSessions('nobody').length, 0)
})

test('advanceTrainingCursor：推进并写库', () => {
  const s = repo.createTrainingSession({ userName: 'dave', ...base, cursor: 10 })
  const updated = repo.advanceTrainingCursor(s.id, 42)
  assert.equal(updated.cursor, 42)
  assert.equal(repo.getTrainingSession(s.id).cursor, 42)
})

test('insertTrainingTrade：写入成交并同步账户，seq 递增', () => {
  const s = repo.createTrainingSession({ userName: 'erin', ...base })
  const t1 = repo.insertTrainingTrade({
    sessionId: s.id,
    barIndex: 30,
    barTs: '2024-02-01',
    side: 'buy',
    qty: 5000,
    price: 10,
    cash: 50000,
    units: 5000,
    avgCost: 10,
  })
  assert.equal(t1.seq, 1)
  assert.equal(t1.pnl, null)

  const afterBuy = repo.getTrainingSession(s.id)
  assert.equal(afterBuy.cash, 50000)
  assert.equal(afterBuy.units, 5000)
  assert.equal(afterBuy.avgCost, 10)

  const t2 = repo.insertTrainingTrade({
    sessionId: s.id,
    barIndex: 40,
    barTs: '2024-03-01',
    side: 'sell',
    qty: 5000,
    price: 12,
    cash: 110000,
    units: 0,
    avgCost: 0,
    pnl: 10000,
  })
  assert.equal(t2.seq, 2)
  assert.equal(t2.pnl, 10000)

  const trades = repo.listTrainingTrades(s.id)
  assert.equal(trades.length, 2)
  assert.deepEqual(trades.map((t) => t.side), ['buy', 'sell'])
})

test('insertTrainingTrade：会话不存在时报错', () => {
  assert.throws(
    () =>
      repo.insertTrainingTrade({
        sessionId: 'nope',
        barIndex: 1,
        barTs: '2024-01-01',
        side: 'buy',
        qty: 100,
        price: 10,
        cash: 1000,
        units: 100,
        avgCost: 10,
      }),
    /训练会话不存在/,
  )
})

test('finishTrainingSession：改状态与标题', () => {
  const s = repo.createTrainingSession({ userName: 'frank', ...base })
  const done = repo.finishTrainingSession(s.id, { status: 'finished', title: '我的复盘' })
  assert.equal(done.status, 'finished')
  assert.equal(done.title, '我的复盘')
  assert.throws(() => repo.finishTrainingSession(s.id, { status: 'nope' }), /未知训练状态/)
})

test('deleteTrainingSession：连带删除成交，且校验归属', () => {
  const s = repo.createTrainingSession({ userName: 'grace', ...base })
  repo.insertTrainingTrade({
    sessionId: s.id,
    barIndex: 5,
    barTs: '2024-01-08',
    side: 'buy',
    qty: 100,
    price: 10,
    cash: 99000,
    units: 100,
    avgCost: 10,
  })
  // 别人的用户名删不掉
  assert.equal(repo.deleteTrainingSession(s.id, { userName: 'hacker' }), false)
  assert.ok(repo.getTrainingSession(s.id))

  assert.equal(repo.deleteTrainingSession(s.id, { userName: 'grace' }), true)
  assert.equal(repo.getTrainingSession(s.id), null)
  assert.equal(repo.listTrainingTrades(s.id).length, 0)
})

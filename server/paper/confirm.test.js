import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb, getDb } from '../store/db.js'
import * as repo from '../store/repositories.js'
import { confirmSignal, ignoreSignal, manualPositionOf } from './confirm.js'
import { ensureAccount, listOrders, getAccount } from './service.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-confirm-'))
process.env.DATA_DIR = dir

after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

const strategyConfig = {
  symbol: '510300',
  entry: { all: [{ event: 'Spring', withinBars: 5 }] },
  exit: { any: [{ stopLoss: { reference: 'rangeLow', bufferAtr: 0.5 } }] },
  execution: { position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1 }, lotSize: 100, minFee: 5, feeRate: 0.0003, slippageBps: 2 },
  initialCash: 100000,
}

function setup(name = '确认测试') {
  const s = repo.createStrategy({ name, config: strategyConfig })
  const sig = repo.insertSignal({
    strategyId: s.id,
    symbol: '510300',
    rangeId: 'R-2026-10-23',
    eventType: 'Spring',
    occurredAt: '2026-11-17',
    detectedAt: '2026-11-17',
    action: 'entry_candidate',
    price: 4.02,
    evidence: { phase: 'accumulation_C', stopLevel: 3.92 },
  })
  return { strategy: s, signal: sig }
}

test('确认入场信号：人工账本挂买单，信号变为 confirmed', () => {
  const { strategy, signal } = setup()
  ensureAccount({ strategyId: strategy.id, symbol: '510300', ledger: 'manual', initialCash: 100000 })

  const r = confirmSignal({ signalId: signal.id })
  assert.equal(r.signal.status, 'confirmed')
  assert.equal(r.order.side, 'buy')
  assert.equal(r.order.ledger, 'manual')
  assert.equal(r.order.qty % 100, 0)
  assert.ok(r.order.qty > 0)
  assert.equal(r.order.stopLevel, 3.92)
  assert.equal(r.order.signalDate, '2026-11-17')

  // 规则账本不受影响
  assert.equal(listOrders({ strategyId: strategy.id, ledger: 'rule' }).length, 0)
  assert.equal(listOrders({ strategyId: strategy.id, ledger: 'manual' }).length, 1)
})

test('重复确认不会重复下单', () => {
  const { signal } = setup('重复确认')
  confirmSignal({ signalId: signal.id })
  const again = confirmSignal({ signalId: signal.id })
  assert.equal(again.reason, 'alreadyHandled')
  assert.equal(again.order, null)
})

test('已持仓时确认入场信号不会加仓，但标记为已处理', () => {
  const { strategy, signal } = setup('已持仓')
  const acc = ensureAccount({ strategyId: strategy.id, symbol: '510300', ledger: 'manual', initialCash: 100000 })
  // 手动模拟已有持仓
  const db = getDb()
  db.prepare('UPDATE paper_accounts SET units = 1000, sellable_units = 1000, avg_cost = 4.0 WHERE id = ?').run(acc.id)

  const r = confirmSignal({ signalId: signal.id })
  assert.equal(r.order, null)
  assert.equal(r.reason, 'notExecutable')
  assert.equal(r.signal.status, 'confirmed', '仍应标记已处理，避免反复出现')
})

test('忽略信号：状态变 ignored，不产生订单', () => {
  const { strategy, signal } = setup('忽略')
  const r = ignoreSignal({ signalId: signal.id })
  assert.equal(r.signal.status, 'ignored')
  assert.equal(listOrders({ strategyId: strategy.id, ledger: 'manual' }).length, 0)

  const again = ignoreSignal({ signalId: signal.id })
  assert.equal(again.reason, 'alreadyHandled')
})

test('不存在的信号或跨策略操作被拒绝', () => {
  assert.throws(() => confirmSignal({ signalId: 'nope' }), /信号不存在/)
  const a = setup('策略A')
  const b = repo.createStrategy({ name: '策略B', config: strategyConfig })
  assert.throws(() => confirmSignal({ signalId: a.signal.id, strategyId: b.id }), /不属于该策略/)
})

test('离场信号确认后生成卖单，数量为当前持仓', () => {
  const s = repo.createStrategy({ name: '离场确认', config: strategyConfig })
  const acc = ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'manual', initialCash: 100000 })
  const db = getDb()
  db.prepare('UPDATE paper_accounts SET units = 2500, sellable_units = 2500, avg_cost = 4.0 WHERE id = ?').run(acc.id)

  const sig = repo.insertSignal({
    strategyId: s.id,
    symbol: '510300',
    rangeId: 'R-2026-10-23',
    eventType: 'SOS',
    occurredAt: '2026-11-18',
    detectedAt: '2026-11-18',
    action: 'exit_candidate',
    price: 4.3,
    evidence: {},
  })
  const r = confirmSignal({ signalId: sig.id })
  assert.equal(r.order.side, 'sell')
  assert.equal(r.order.qty, 2500)
})

test('manualPositionOf 返回人工账本持仓', () => {
  const s = repo.createStrategy({ name: '持仓查询', config: strategyConfig })
  assert.equal(manualPositionOf(s.id, '510300'), null)
  ensureAccount({ strategyId: s.id, symbol: '510300', ledger: 'manual', initialCash: 80000 })
  const p = manualPositionOf(s.id, '510300')
  assert.equal(p.cash, 80000)
  assert.equal(p.units, 0)
})

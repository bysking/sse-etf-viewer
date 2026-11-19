import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb } from '../store/db.js'
import { planOrder } from './check.js'
import { isCheckDue, getSchedulerStatus } from './scheduler.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-check-'))
process.env.DATA_DIR = dir

after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

// 说明：executeCheck 会拉真实行情 + 份额，耗时随网络波动，
// 不放进单元测试；它的端到端行为由手动验证覆盖。这里只测纯逻辑。

test('planOrder：入场按风险仓位算数量且受最小单位约束', () => {
  const ex = { position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1 }, lotSize: 100 }
  const sig = { action: 'entry_candidate', price: 4.0, stopLevel: 3.8 }
  const order = planOrder({ strategy: {}, signal: sig, acc: { cash: 100000, units: 0 }, execution: ex })
  assert.equal(order.side, 'buy')
  assert.equal(order.qty % 100, 0)
  // 风险预算 1000 元 / 止损距离 0.2 元 = 5000 股
  assert.equal(order.qty, 5000)
  assert.equal(order.stopLevel, 3.8)
})

test('planOrder：已持仓不加仓', () => {
  const ex = { position: { type: 'riskBased', riskPct: 0.01 }, lotSize: 100 }
  const sig = { action: 'entry_candidate', price: 4.0, stopLevel: 3.8 }
  assert.equal(planOrder({ strategy: {}, signal: sig, acc: { cash: 100000, units: 1000 }, execution: ex }), null)
})

test('planOrder：没有止损位或止损位不低于入场价时不下单', () => {
  const ex = { position: { type: 'riskBased', riskPct: 0.01 }, lotSize: 100 }
  const sig = { action: 'entry_candidate', price: 4.0, stopLevel: null }
  assert.equal(planOrder({ strategy: {}, signal: sig, acc: { cash: 100000, units: 0 }, execution: ex }), null)

  const bad = { action: 'entry_candidate', price: 4.0, stopLevel: 4.2 }
  assert.equal(planOrder({ strategy: {}, signal: bad, acc: { cash: 100000, units: 0 }, execution: ex }), null)
})

test('planOrder：离场清空全部持仓', () => {
  const ex = { position: { type: 'riskBased', riskPct: 0.01 }, lotSize: 100 }
  const exit = { action: 'exit_candidate', price: 4.2 }
  assert.deepEqual(planOrder({ strategy: {}, signal: exit, acc: { cash: 0, units: 3000 }, execution: ex }), {
    side: 'sell',
    qty: 3000,
  })
  assert.equal(planOrder({ strategy: {}, signal: exit, acc: { cash: 1000, units: 0 }, execution: ex }), null)
})

test('isCheckDue：价格策略 15:10 后检查，份额策略 18:40–22:00', () => {
  const at = (h, m = 0) => new Date(`2026-11-19T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`)
  assert.equal(isCheckDue({ usesShares: false }, at(15, 0)), false)
  assert.equal(isCheckDue({ usesShares: false }, at(15, 10)), true)
  assert.equal(isCheckDue({ usesShares: false }, at(20)), true)

  assert.equal(isCheckDue({ usesShares: true }, at(17)), false)
  assert.equal(isCheckDue({ usesShares: true }, at(18, 40)), true)
  assert.equal(isCheckDue({ usesShares: true }, at(21, 30)), true)
  assert.equal(isCheckDue({ usesShares: true }, at(22, 30)), false, '超过重试窗口不再检查')
})

test('getSchedulerStatus 暴露时点配置且测试环境未启动', () => {
  const s = getSchedulerStatus()
  assert.equal(s.priceCheckAt, '15:10')
  assert.equal(s.shareCheckAt, '18:40')
  assert.equal(s.shareRetryUntil, '22:00')
  assert.equal(s.enabled, false)
})

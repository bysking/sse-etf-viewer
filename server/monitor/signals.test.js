import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb } from '../store/db.js'
import * as repo from '../store/repositories.js'
import { analyzeWyckoff } from '../../shared/wyckoff/analyzer.js'
import { detectSignalsAtLatest, persistSignal, strategyUsesShares } from './signals.js'
import { accumulationBars, WYCKOFF_TEST_CONFIG } from '../../test-support/fixtures.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-signal-'))
process.env.DATA_DIR = dir

after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

const strategy = {
  symbol: '510300',
  entry: {
    all: [
      { event: 'Spring', withinBars: 5 },
      { phase: { in: ['accumulation_C', 'accumulation_D'], minConfidence: 0.5 } },
    ],
  },
  exit: {
    any: [{ event: 'SOS', withinBars: 4 }, { stopLoss: { reference: 'eventLow', event: 'Spring', bufferAtr: 0.5 } }],
  },
  execution: { position: { type: 'riskBased', riskPct: 0.01 }, lotSize: 100, minFee: 5, feeRate: 0.0003, slippageBps: 2 },
}

/** 取到 Spring 确认日为止的数据，保证最后一根触发入场 */
function barsUpToSpring() {
  const all = accumulationBars()
  const analysisFull = analyzeWyckoff(all, WYCKOFF_TEST_CONFIG)
  const spring = analysisFull.events.find((e) => e.type === 'Spring')
  return all.slice(0, spring.detectedIndex + 1)
}

test('空仓且最新 bar 满足入场条件时产生 entry_candidate 与失效位', () => {
  const bars = barsUpToSpring()
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG)
  const signals = detectSignalsAtLatest({ bars, analysis, strategy, state: { holding: false } })
  assert.equal(signals.length, 1)
  assert.equal(signals[0].action, 'entry_candidate')
  assert.equal(signals[0].detectedAt, bars[bars.length - 1].date)
  assert.ok(signals[0].stopLevel > 0, '应带结构止损位')
  assert.equal(signals[0].evidence.phase.startsWith('accumulation'), true)
})

test('已持仓时不再产生入场信号', () => {
  const bars = barsUpToSpring()
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG)
  const signals = detectSignalsAtLatest({ bars, analysis, strategy, state: { holding: true } })
  assert.equal(signals.filter((s) => s.action === 'entry_candidate').length, 0)
})

test('持仓且出现离场条件时产生 exit_candidate，且不重复产生入场', () => {
  const all = accumulationBars()
  const analysisFull = analyzeWyckoff(all, WYCKOFF_TEST_CONFIG)
  const sos = analysisFull.events.find((e) => e.type === 'SOS')
  const bars = all.slice(0, sos.detectedIndex + 1)
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG)
  const signals = detectSignalsAtLatest({ bars, analysis, strategy, state: { holding: true } })
  assert.equal(signals.length, 1)
  assert.equal(signals[0].action, 'exit_candidate')
})

test('条件不满足时不产生信号', () => {
  const bars = accumulationBars().slice(0, 60)
  const analysis = analyzeWyckoff(bars, WYCKOFF_TEST_CONFIG)
  const signals = detectSignalsAtLatest({ bars, analysis, strategy, state: { holding: false } })
  assert.equal(signals.length, 0)
})

test('同一信号重复入库返回 null（去重）', () => {
  const s = repo.createStrategy({ name: '去重', config: strategy })
  const sig = {
    action: 'entry_candidate',
    eventType: 'Spring',
    detectedAt: '2024-03-25',
    price: 4.02,
    evidence: { range: { id: 'R-2024-03-01' }, phase: 'accumulation_C' },
  }
  const first = persistSignal({ strategyId: s.id, symbol: '510300', signal: sig })
  assert.ok(first)
  const second = persistSignal({ strategyId: s.id, symbol: '510300', signal: sig })
  assert.equal(second, null)
  assert.equal(repo.listSignals(s.id).length, 1)
})

test('strategyUsesShares 判断策略是否依赖份额流', () => {
  assert.equal(strategyUsesShares(strategy), false)
  const withShares = {
    ...strategy,
    entry: { all: [...strategy.entry.all, { shareFlow: { cumulativeDays: 3, gt: 0 } }] },
  }
  assert.equal(strategyUsesShares(withShares), true)
})

test('策略运行状态可读写并保留扩展字段', () => {
  const s = repo.createStrategy({ name: '状态', config: strategy })
  assert.equal(repo.getStrategyState(s.id), null)

  repo.setStrategyState(s.id, { symbol: '510300', lastBar: '2024-03-25', lastPhase: 'accumulation_C', holding: true })
  const st = repo.getStrategyState(s.id)
  assert.equal(st.symbol, '510300')
  assert.equal(st.lastBar, '2024-03-25')
  assert.equal(st.holding, true)

  repo.setStrategyState(s.id, { lastBar: '2024-03-26' })
  const st2 = repo.getStrategyState(s.id)
  assert.equal(st2.lastBar, '2024-03-26')
  assert.equal(st2.holding, true, '未传入的字段应保留')
})

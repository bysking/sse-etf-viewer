import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb } from './db.js'
import * as repo from './repositories.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-repo-'))
process.env.DATA_DIR = dir

after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('策略 CRUD', () => {
  const s = repo.createStrategy({ name: '测试', config: { symbol: '510300', wyckoff: {} } })
  assert.equal(s.name, '测试')
  assert.equal(s.config.symbol, '510300')
  assert.equal(s.enabled, true)
  assert.ok(repo.listStrategies().some((x) => x.id === s.id))

  const u = repo.updateStrategy(s.id, { name: '改名', enabled: false })
  assert.equal(u.name, '改名')
  assert.equal(u.enabled, false)
  assert.equal(repo.updateStrategy('nope', { name: 'x' }), null)
  assert.equal(repo.deleteStrategy(s.id), true)
  assert.equal(repo.getStrategy(s.id), null)
})

test('回测任务状态流转与 JSON 结果', () => {
  const run = repo.createRun({
    strategyId: 's1',
    configSnapshot: { symbol: '510300' },
    engineVersion: 'wyckoff-v1',
    symbol: '510300',
    start: '2025-01-01',
    end: '2025-12-31',
  })
  assert.equal(run.status, 'queued')
  repo.setRunProgress(run.id, 'running', 0.5)
  assert.equal(repo.getRun(run.id).progress, 0.5)
  repo.finishRun(run.id, { metrics: { totalReturn: 0.1 }, equity: [{ date: '2025-01-01', equity: 100000 }], trades: [] })
  const done = repo.getRun(run.id)
  assert.equal(done.status, 'done')
  assert.equal(done.metrics.totalReturn, 0.1)
  assert.equal(done.equity.length, 1)
  assert.ok(done.finishedAt)
  assert.equal(repo.listRuns('s1').length, 1)
})

test('信号去重：同一唯一键第二次写入返回 null', () => {
  const sig = {
    strategyId: 's1',
    symbol: '510300',
    rangeId: 'R-2024-01-01',
    eventType: 'Spring',
    occurredAt: '2024-01-10',
    detectedAt: '2024-01-10',
    action: 'entry_candidate',
    price: 4,
    evidence: { volZ: 1.8 },
  }
  assert.ok(repo.insertSignal(sig))
  assert.equal(repo.insertSignal(sig), null)
  const list = repo.listSignals('s1')
  assert.equal(list.length, 1)
  assert.equal(list[0].evidence.volZ, 1.8)
})

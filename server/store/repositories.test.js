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

test('策略版本：递增、不可变、active 唯一', () => {
  const s = repo.createStrategy({ name: '版本测试', config: { symbol: '510300' } })

  const v1 = repo.createStrategyVersion({
    strategyId: s.id,
    config: { symbol: '510300', entry: { all: [{ event: 'Spring' }] } },
    provenance: { source: 'ai', model: 'mock-model' },
  })
  assert.equal(v1.version, 1)
  assert.equal(v1.status, 'draft')
  assert.equal(v1.provenance.source, 'ai')

  const v2 = repo.createStrategyVersion({ strategyId: s.id, config: { symbol: '510050' } })
  assert.equal(v2.version, 2)

  const list = repo.listStrategyVersions(s.id)
  assert.equal(list.length, 2)
  assert.equal(list[0].version, 2, '应按版本倒序')
  assert.equal(repo.getLatestStrategyVersion(s.id).version, 2)

  // 状态推进
  const validated = repo.setStrategyVersionStatus(v1.id, 'validated', { validation: { ok: true, errors: [] } })
  assert.equal(validated.status, 'validated')
  assert.equal(validated.validation.ok, true)

  assert.equal(repo.setStrategyVersionStatus(v1.id, 'active').status, 'active')
  assert.equal(repo.getActiveStrategyVersion(s.id).id, v1.id)

  // 同一策略只能有一个 active
  repo.setStrategyVersionStatus(v2.id, 'active')
  assert.equal(repo.getActiveStrategyVersion(s.id).id, v2.id)
  assert.equal(repo.getStrategyVersion(v1.id).status, 'archived')

  // 内容不可变：状态变更不影响 config
  assert.equal(repo.getStrategyVersion(v2.id).config.symbol, '510050')

  assert.throws(() => repo.createStrategyVersion({ strategyId: s.id, kind: 'python' }), /kind/)
  assert.throws(() => repo.setStrategyVersionStatus(v1.id, 'deleted'), /未知版本状态/)

  // 删除策略时清理版本，避免残留
  assert.equal(repo.deleteStrategy(s.id), true)
  assert.equal(repo.listStrategyVersions(s.id).length, 0)
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

test('settings 读写与覆盖', () => {
  assert.equal(repo.getSetting('missing', 'fallback'), 'fallback')
  repo.setSetting('ai_config', { model: 'test-model', temperature: 0.3 })
  assert.equal(repo.getSetting('ai_config').model, 'test-model')
  repo.setSetting('ai_config', { model: 'next-model' })
  assert.equal(repo.getSetting('ai_config').model, 'next-model')
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

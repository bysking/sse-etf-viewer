import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECOMMEND_GROUPS,
  SHRINK_K,
  DEFAULT_MIN_SAMPLES,
  expandAxes,
  segmentMetrics,
  scoreOf,
  setPath,
  defaultTrainEnd,
  suggestWyckoffParams,
} from './recommend.js'
import { analyzeWyckoff } from './analyzer.js'
import { eventStudy } from './eventStudy.js'
import { accumulationBars, distributionBars, mk, WYCKOFF_TEST_CONFIG } from '../../test-support/fixtures.js'

/** 拼一段足够长的行情：吸筹场景重复若干次，保证样本量与训练/验证两段都有数据 */
function longBars(repeats = 6) {
  const out = []
  let day = 0
  const push = (bar) => {
    out.push({ ...bar, date: new Date(Date.UTC(2019, 0, 1) + day++ * 864e5).toISOString().slice(0, 10) })
  }
  for (let k = 0; k < repeats; k++) {
    for (const b of accumulationBars()) push(b)
    for (const b of distributionBars()) push(b)
  }
  return out
}

test('expandAxes 展开组合并限制上限', () => {
  const combos = expandAxes([
    { path: 'a.b', values: [1, 2] },
    { path: 'a.c', values: [3, 4] },
  ])
  assert.equal(combos.length, 4)
  assert.ok(combos.some((c) => c['a.b'] === 2 && c['a.c'] === 4))
  assert.throws(() => expandAxes([{ path: 'a.b', values: Array.from({ length: 30 }, (_, i) => i) }]), /组合超过/)
})

test('setPath 不修改原对象且把字符串数字转成 number', () => {
  const base = { swing: { atrMult: 1.5 } }
  const out = setPath(base, 'swing.atrMult', '2.0')
  assert.equal(out.swing.atrMult, 2)
  assert.equal(base.swing.atrMult, 1.5)
  assert.notEqual(out.swing, base.swing)
})

test('segmentMetrics 只统计完整落在段内的样本', () => {
  const rows = [
    { type: 'Spring', detectedDate: '2024-01-02', horizons: { 5: { return: 0.02, mfe: 0.03, mae: -0.01, endDate: '2024-01-09' } } },
    { type: 'Spring', detectedDate: '2024-01-20', horizons: { 5: { return: -0.01, mfe: 0.01, mae: -0.02, endDate: '2024-02-05' } } },
    { type: 'SOS', detectedDate: '2024-01-03', horizons: { 5: { return: 0.5, mfe: 0.5, mae: 0, endDate: '2024-01-10' } } },
  ]
  // 第二行持有窗口跨过 01-31，应被排除
  const m = segmentMetrics(rows, { horizon: 5, type: 'Spring', from: '2024-01-01', to: '2024-01-31' })
  assert.equal(m.count, 1)
  assert.ok(Math.abs(m.avgReturn - 0.02) < 1e-9)
})

test('scoreOf 做小样本收缩并对反向事件取负', () => {
  const m = { count: SHRINK_K, avgReturn: 0.04, medianReturn: 0.04 }
  const long = scoreOf(m, 'long', 5)
  assert.ok(Math.abs(long - 0.02) < 1e-9, '样本量=SHRINK_K 时折半')

  const inverse = scoreOf(m, 'inverse', 5)
  assert.ok(inverse < 0)

  assert.equal(scoreOf(m, 'long', 20), null, '样本不足时不给分')
  assert.equal(scoreOf({ count: 10, avgReturn: null }, 'long', 5), null)
})

test('defaultTrainEnd 取约 70% 位置的日期', () => {
  const bars = Array.from({ length: 100 }, (_, i) => ({ date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}` }))
  const bars2 = bars.map((b, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10) }))
  assert.equal(defaultTrainEnd(bars2), bars2[70].date)
  assert.equal(defaultTrainEnd([]), null)
})

test('suggestWyckoffParams 在样本足够时给出建议值', () => {
  const bars = longBars(6)
  const res = suggestWyckoffParams({ bars, baseConfig: {}, horizon: 10, minSamples: 3 })
  assert.equal(res.horizon, 10)
  assert.ok(res.trainEnd > res.dataRange.start && res.trainEnd < res.dataRange.end)
  assert.ok(res.groups.length === RECOMMEND_GROUPS.length)
  assert.ok(res.recommended && typeof res.recommended === 'object')
  // 至少有一组拿到候选（否则说明打分链路完全没跑通）
  assert.ok(res.groups.some((g) => g.best), '至少一个分组应给出建议')
  for (const g of res.groups) {
    if (!g.best) continue
    assert.ok(g.best.score != null)
    assert.ok(Number.isFinite(g.best.train.count))
    for (const path of Object.keys(g.best.params)) {
      assert.ok(path.includes('.'), '建议值必须是点分路径')
    }
  }
})

test('suggestWyckoffParams 校验区间与数据量', () => {
  assert.throws(() => suggestWyckoffParams({ bars: [] }), /数据太少/)
  const bars = longBars(1)
  assert.throws(() => suggestWyckoffParams({ bars, trainEnd: '1990-01-01' }), /不在 K 线日期里/)
})

test('suggestWyckoffParams 的 groups 过滤生效', () => {
  const bars = longBars(6)
  const res = suggestWyckoffParams({ bars, groups: ['spring'], minSamples: 3 })
  assert.equal(res.groups.length, 1)
  assert.equal(res.groups[0].key, 'spring')
})

test('minGain 门槛：增益太小的分组不给建议，并标记原因', () => {
  const bars = longBars(6)
  const strict = suggestWyckoffParams({ bars, minSamples: 3, minGain: 1 })
  assert.equal(strict.changes.length, 0, '门槛为 1 时不可能有增益达标')
  assert.ok(strict.groups.every((g) => g.best == null))
  assert.ok(strict.groups.some((g) => g.reason === 'gainTooSmall'), '样本够但增益不足时应标记 gainTooSmall')

  const loose = suggestWyckoffParams({ bars, minSamples: 3, minGain: 0 })
  const better = loose.groups.filter((g) => g.best)
  assert.ok(better.length > 0, '门槛为 0 时应给出建议')
  for (const g of better) {
    assert.equal(g.reason, 'better')
    assert.ok(g.gain >= 0)
  }
})

test('推荐口径与事件研究一致：高分组的训练段均值应高于当前值', () => {
  const bars = longBars(6)
  const res = suggestWyckoffParams({ bars, groups: ['spring'], minSamples: 3 })
  const g = res.groups[0]
  if (g.best && g.baseline?.score != null) {
    const score = (m) => 0.5 * m.avgReturn + 0.5 * (m.medianReturn ?? m.avgReturn)
    assert.ok(score(g.best.train) >= score(g.baseline.train) - 1e-9)
  }
})

test('事件研究与分析器在同一份数据上可用（推荐链路的输入前提）', () => {
  const bars = longBars(2)
  const analysis = analyzeWyckoff(bars, {})
  assert.ok(analysis.events.length > 0)
  const study = eventStudy(bars, analysis.events, { horizons: [10] })
  assert.ok(study.rows.length > 0)
  assert.ok(study.rows.every((r) => r.detectedDate && r.type))
})

test('合成行情能构造出核心事件（防止 fixture 漂移导致推荐测试空跑）', () => {
  const simple = [mk(0, 100, 101, 99, 100, 1_000_000)]
  assert.equal(simple.length, 1)
  const types = new Set(analyzeWyckoff(accumulationBars(), WYCKOFF_TEST_CONFIG).events.map((e) => e.type))
  assert.ok(types.has('Spring'), `期望出现 Spring，实际：${[...types].join(',')}`)
})

// Wyckoff 参数推荐：用「事件研究」的历史样本统计给小范围网格打分，
// 直接给出每类事件在当前 ETF 上的合适阈值，替代手动试参数。
//
// 打分口径（可解释、可复现）：
//   1. 只看事件确认日之后 horizon 根的前瞻收益（与事件研究同口径：次日开盘买入）；
//   2. 均值与中位数各取一半，抑制个别极端样本；
//   3. 乘 n/(n+8) 做小样本收缩：样本越少越向 0 靠，避免「2 个样本 +8%」被当成最优；
//   4. 入场类事件取正向漂移，出场类事件取负向漂移（出现后跌得越干净越有用）；
//   5. 训练段选值、验证段复核。两段都只统计「事件与完整持有窗口都在段内」的样本，
//      避免跨段泄漏。
//
// 明确不做的事：不自动改用户参数，只给建议值 + 变化量与两段表现，是否采纳由人决定。
import { analyzeWyckoff } from './analyzer.js'
import { eventStudy } from './eventStudy.js'

/** 每组轴最多展开多少个组合 */
export const MAX_GROUP_COMBOS = 24
/** 小样本收缩强度：样本量等于该值时分数折半 */
export const SHRINK_K = 8
/** 默认最少样本量，低于此值不给建议 */
export const DEFAULT_MIN_SAMPLES = 5
/**
 * 默认最小增益：训练段评分至少提升这么多（比例，0.002 = 0.2 个百分点）才值得改参数。
 * 没有这个门槛时，0.000x 的评分差也会被当成「更优」，白白改掉用户已经调好的值。
 */
export const DEFAULT_MIN_GAIN = 0.002

export const ENTRY_TYPES = ['SC', 'AR', 'ST', 'Spring', 'Test', 'SOS', 'LPS']

/**
 * 推荐分组：每组只扫「该类事件自己的阈值」，其他参数保持用户当前值。
 * structure 组影响全部事件，用入场类事件的分数合计评估。
 */
export const RECOMMEND_GROUPS = [
  {
    key: 'spring',
    event: 'Spring',
    direction: 'long',
    axes: [
      { path: 'spring.maxBreakAtr', values: [0.5, 1.0, 1.5] },
      { path: 'spring.confirmBars', values: [3, 5, 7] },
    ],
  },
  {
    key: 'sos',
    event: 'SOS',
    direction: 'long',
    axes: [
      { path: 'sos.volZ', values: [0.2, 0.5, 0.8] },
      { path: 'sos.breakAtr', values: [0.2, 0.3, 0.5] },
    ],
  },
  {
    key: 'sc',
    event: 'SC',
    direction: 'long',
    axes: [
      { path: 'sc.volZ', values: [1.0, 1.2, 1.5] },
      { path: 'sc.spreadAtr', values: [0.8, 1.0, 1.2] },
    ],
  },
  {
    key: 'bc',
    event: 'BC',
    direction: 'inverse',
    axes: [
      { path: 'bc.volZ', values: [1.0, 1.2, 1.5] },
      { path: 'bc.spreadAtr', values: [0.8, 1.0, 1.2] },
    ],
  },
  {
    key: 'ar',
    event: 'AR',
    direction: 'long',
    axes: [
      { path: 'ar.reboundAtr', values: [1.0, 1.2, 1.5] },
      { path: 'ar.maxBars', values: [10, 15] },
    ],
  },
  {
    key: 'st',
    event: 'ST',
    direction: 'long',
    axes: [{ path: 'st.toleranceAtr', values: [0.3, 0.5, 0.8] }],
  },
  {
    key: 'utad',
    event: 'UTAD',
    direction: 'inverse',
    axes: [
      { path: 'utad.maxBreakAtr', values: [0.5, 1.0, 1.5] },
      { path: 'utad.confirmBars', values: [3, 5, 7] },
    ],
  },
  {
    key: 'sow',
    event: 'SOW',
    direction: 'inverse',
    axes: [
      { path: 'sow.volZ', values: [0.5, 1.0, 1.5] },
      { path: 'sow.breakAtr', values: [0.2, 0.3, 0.5] },
    ],
  },
  {
    key: 'lps',
    event: 'LPS',
    direction: 'long',
    axes: [
      { path: 'lps.maxPullbackAtr', values: [0.7, 1.0, 1.4] },
      { path: 'lps.maxBars', values: [8, 10, 12] },
    ],
  },
  {
    key: 'lpsy',
    event: 'LPSY',
    direction: 'inverse',
    axes: [
      { path: 'lpsy.maxRallyAtr', values: [0.7, 1.0, 1.4] },
      { path: 'lpsy.maxBars', values: [8, 10, 12] },
    ],
  },
  {
    key: 'structure',
    event: null,
    direction: 'long',
    label: '整体结构',
    axes: [{ path: 'swing.atrMult', values: [1.2, 1.5, 2.0] }],
  },
]

/** 按点分路径写值，返回新对象（不改入参）；数字字符串转成 number */
export function setPath(obj, path, value) {
  const out = Array.isArray(obj) ? [...obj] : { ...obj }
  const parts = path.split('.')
  let cur = out
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    cur[k] = cur[k] != null && typeof cur[k] === 'object' ? { ...cur[k] } : {}
    cur = cur[k]
  }
  const last = parts[parts.length - 1]
  cur[last] = typeof value === 'string' && value.trim() !== '' && Number.isFinite(+value) ? +value : value
  return out
}

/** 单组轴展开成组合列表 */
export function expandAxes(axes = []) {
  let combos = [{}]
  for (const axis of axes) {
    const values = Array.isArray(axis.values) ? axis.values : []
    if (!values.length) continue
    const next = []
    for (const cur of combos) for (const v of values) next.push({ ...cur, [axis.path]: v })
    combos = next
    if (combos.length > MAX_GROUP_COMBOS) {
      throw new Error(`参数组合超过 ${MAX_GROUP_COMBOS} 个，请减少扫描取值`)
    }
  }
  return combos
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
function median(a) {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 按日期切段汇总事件研究样本。要求持有窗口也在段内，避免跨段泄漏。
 * @param {Array} rows eventStudy().rows
 * @param {object} p { horizon, from, to, type }
 */
export function segmentMetrics(rows, { horizon, from, to, type } = {}) {
  const rets = []
  const mfes = []
  const maes = []
  for (const r of rows) {
    if (type && r.type !== type) continue
    if (from && r.detectedDate < from) continue
    if (to && r.detectedDate > to) continue
    const h = r.horizons?.[horizon]
    if (!h || !Number.isFinite(h.return)) continue
    if (to && h.endDate > to) continue
    rets.push(h.return)
    if (Number.isFinite(h.mfe)) mfes.push(h.mfe)
    if (Number.isFinite(h.mae)) maes.push(h.mae)
  }
  return {
    count: rets.length,
    avgReturn: mean(rets),
    medianReturn: median(rets),
    winRate: rets.length ? rets.filter((x) => x > 0).length / rets.length : null,
    avgMfe: mean(mfes),
    avgMae: mean(maes),
  }
}

/** 打分：均值与中位数各半 + 小样本收缩 + 方向调整；样本不足返回 null */
export function scoreOf(m, direction = 'long', minSamples = DEFAULT_MIN_SAMPLES) {
  if (!m || !m.count || m.count < minSamples || m.avgReturn == null) return null
  const sharp = 0.5 * m.avgReturn + 0.5 * (m.medianReturn ?? m.avgReturn)
  const shrink = m.count / (m.count + SHRINK_K)
  const raw = sharp * shrink
  return direction === 'inverse' ? -raw : raw
}

/** 默认训练截止日：按 bar 数量取前 70% */
export function defaultTrainEnd(bars) {
  if (!Array.isArray(bars) || !bars.length) return null
  const i = Math.max(0, Math.min(bars.length - 1, Math.floor(bars.length * 0.7)))
  return bars[i].date
}

function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/**
 * 主入口：给出一只 ETF 在给定区间上的参数建议。
 * @param {object} p
 * @param {Array} p.bars seriesToBars 的结果（已复权）
 * @param {object} [p.baseConfig] 用户当前的 wyckoff 配置（嵌套）
 * @param {number} [p.horizon] 前瞻窗口，默认 10
 * @param {string} [p.trainEnd] 训练段截止日（含），之后为验证段
 * @param {Array} [p.shares] 份额序列
 * @param {number} [p.minSamples] 最少样本量
 * @param {Array} [p.groups] 只扫指定分组 key
 * @param {(done:number,total:number)=>void} [p.onProgress]
 */
export function suggestWyckoffParams({
  bars,
  baseConfig = {},
  horizon = 10,
  trainEnd,
  shares = null,
  minSamples = DEFAULT_MIN_SAMPLES,
  minGain = DEFAULT_MIN_GAIN,
  groups,
  onProgress,
} = {}) {
  if (!Array.isArray(bars) || bars.length < 60) {
    throw new Error('数据太少（至少 60 根日 K），无法给出参数建议')
  }
  const h = Math.max(1, Math.min(60, Number(horizon) || 10))
  const cut = trainEnd || defaultTrainEnd(bars)
  if (!bars.some((b) => b.date === cut)) throw new Error(`训练截止日 ${cut} 不在 K 线日期里`)
  if (bars[0].date >= cut) throw new Error('训练截止日太早，训练段没有数据')
  const startDate = bars[0].date
  const endDate = bars[bars.length - 1].date
  const trainSeg = { horizon: h, from: startDate, to: cut }
  const valSeg = { horizon: h, from: cut, to: endDate }

  const picked = Array.isArray(groups) && groups.length
    ? RECOMMEND_GROUPS.filter((g) => groups.includes(g.key))
    : RECOMMEND_GROUPS
  const total = picked.reduce((n, g) => n + expandAxes(g.axes).length + 1, 0)
  let done = 0
  const tick = () => onProgress?.(++done, total)

  const out = []
  for (const g of picked) {
    const types = g.event ? [g.event] : ENTRY_TYPES
    const measure = (config) => {
      const analysis = analyzeWyckoff(bars, config, { shares })
      const study = eventStudy(bars, analysis.events, { horizons: [h], types })
      if (g.event) {
        const train = segmentMetrics(study.rows, { ...trainSeg, type: g.event })
        const validation = segmentMetrics(study.rows, { ...valSeg, type: g.event })
        return { train, validation, score: scoreOf(train, g.direction, minSamples) }
      }
      // 结构组：各入场类事件分别收缩打分后相加
      let score = 0
      let any = false
      const trainTotal = { count: 0 }
      for (const t of ENTRY_TYPES) {
        const tr = segmentMetrics(study.rows, { ...trainSeg, type: t })
        const s = scoreOf(tr, 'long', minSamples)
        trainTotal.count += tr.count
        if (s != null) {
          score += s
          any = true
        }
      }
      const train = { ...segmentMetrics(study.rows, trainSeg), count: trainTotal.count }
      const validation = segmentMetrics(study.rows, valSeg)
      return { train, validation, score: any ? score : null }
    }

    const baseline = measure(baseConfig)
    tick()

    const candidates = []
    for (const combo of expandAxes(g.axes)) {
      let cfg = baseConfig
      for (const [path, value] of Object.entries(combo)) cfg = setPath(cfg, path, value)
      candidates.push({ params: combo, ...measure(cfg) })
      tick()
    }

    const usable = candidates.filter((c) => c.score != null)
    usable.sort((a, b) => b.score - a.score || b.validation.count - a.validation.count)
    const current = {}
    for (const axis of g.axes) current[axis.path] = readPath(baseConfig, axis.path) ?? null
    const gain = usable[0] && baseline.score != null ? usable[0].score - baseline.score : null
    // 增益达不到 minGain 就等于「当前值已经够好」，不给出改动建议
    const best = gain != null && gain >= minGain ? usable[0] : null

    out.push({
      key: g.key,
      event: g.event,
      label: g.label || g.event,
      direction: g.direction,
      axes: g.axes,
      current,
      baseline,
      best,
      gain,
      // 有建议但幅度太小 / 没有建议时都说明原因，避免用户以为「系统没算」
      reason: best
        ? 'better'
        : usable.length === 0
          ? 'insufficientSamples'
          : baseline.score == null
            ? 'baselineInsufficient'
            : 'gainTooSmall',
      changes: best
        ? Object.entries(best.params)
            .filter(([path, v]) => current[path] == null || +current[path] !== +v)
            .map(([path, to]) => ({ path, from: current[path], to }))
        : [],
      candidates: usable.map((c) => ({
        params: c.params,
        score: c.score,
        train: c.train,
        validation: c.validation,
      })),
    })
  }

  // 合并各组的建议值；同一 path 被多组改到冲突时以第一个为准（分组目前互不重叠）
  const recommended = {}
  const changes = []
  const seen = new Set()
  for (const g of out) {
    for (const c of g.changes) {
      if (seen.has(c.path)) continue
      seen.add(c.path)
      changes.push({ group: g.key, ...c })
      writePath(recommended, c.path, c.to)
    }
  }

  return {
    horizon: h,
    trainEnd: cut,
    dataRange: { start: startDate, end: endDate },
    barCount: bars.length,
    minSamples,
    minGain,
    groups: out,
    changes,
    recommended,
    // 没有足够样本的分组：明确告知，避免用户误以为「系统认为不用改」
    emptyGroups: out.filter((g) => g.reason === 'insufficientSamples' || g.reason === 'baselineInsufficient').map((g) => g.key),
    // 样本够但建议增益太小的分组：说明「当前值已经够好」
    noGainGroups: out.filter((g) => g.reason === 'gainTooSmall').map((g) => g.key),
  }
}

function writePath(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

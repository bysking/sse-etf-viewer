// 研究页可调 Wyckoff 参数：扁平 path ↔ 嵌套配置，以及每项参数的中文释义。
import { mergeConfig } from '../shared/wyckoff/config.js'

export const PARAM_GROUPS = [
  {
    title: '结构与区间',
    items: [
      { path: 'swing.atrPeriod', label: 'ATR 周期', min: 2, max: 100, step: 1, hint: '算 ATR 的回溯天数。所有「X 倍 ATR」阈值都以它为尺度；调大 → ATR 更平滑、事件更少。' },
      { path: 'swing.atrMult', label: 'ZigZag 阈值', min: 0.5, max: 5, step: 0.1, hint: '反转多少倍 ATR 才确认一个高低点。调大 → 区间更大更少；调小 → 区间更碎、事件更多。' },
      { path: 'swing.confirmBars', label: '确认 bar', min: 0, max: 10, step: 1, hint: '高低点要等几根 bar 才确认。调大更保守（但信号更迟）。' },
      { path: 'range.minBars', label: '区间最短', min: 5, max: 200, step: 1, hint: '区间至少多少根 bar 才算成立。调大 → 过滤掉短期震荡。' },
      { path: 'range.maxWidthAtr', label: '区间最大宽度', min: 0.5, max: 8, step: 0.1, hint: '区间高度上限（ATR 倍数）。调大 → 容纳更宽的震荡；过大会把趋势也当区间。' },
      { path: 'range.minTouches', label: '最少触碰', min: 1, max: 6, step: 1, hint: '上下沿各需要几个 pivot 才成区间。调大 → 区间更严格。' },
      { path: 'range.breakAtr', label: '突破缓冲', min: 0, max: 2, step: 0.1, hint: '收盘超出台沿多少 ATR 才算真突破（不是 SOS/SOW，是通用区间结束）。调大 → 假突破更少。' },
      { path: 'range.sideLookbackBars', label: '方向推断窗口', min: 0, max: 250, step: 10, hint: '用区间起点前多少根的价格变化判断吸筹/派发方向。' },
      { path: 'range.sideMinReturn', label: '方向推断阈值', min: 0, max: 0.5, step: 0.01, hint: '前段涨跌幅超过该值才判方向：跌多了后面算吸筹，涨多了算派发。' },
    ],
  },
  {
    title: '量能与高潮',
    items: [
      { path: 'volume.maPeriod', label: '量能均线', min: 2, max: 120, step: 1, hint: '成交量均线周期，LPS/LPSY 的「缩量」判定用。' },
      { path: 'volume.zWindow', label: '量能 Z 窗口', min: 5, max: 250, step: 1, hint: '成交量 Z 分数的统计窗口。调大 → 量能标准更长期、极端值更少。' },
      { path: 'volume.highZ', label: '高量 Z', min: 0, max: 8, step: 0.1, hint: '努力/结果分类里的「高量」门槛，只影响 effortResult 标签，不直接产生事件。' },
      { path: 'volume.lowZ', label: '低量 Z', min: -8, max: 0, step: 0.1, hint: '「低量」门槛（负值），同上，仅用于努力/结果分类。' },
      { path: 'sc.lookback', label: 'SC 回溯', min: 10, max: 250, step: 1, hint: '多少根 bar 内的最低价算「新低」。调大 → SC 更稀有。' },
      { path: 'sc.volZ', label: 'SC 量能 Z', min: 0, max: 8, step: 0.1, hint: '卖出高潮要多少倍标准差的放量。调大 → SC 更少、更极端。' },
      { path: 'sc.spreadAtr', label: 'SC 振幅 ATR', min: 0, max: 5, step: 0.1, hint: '当根振幅下限（ATR 倍数），要求是宽振幅恐慌日。' },
      { path: 'sc.closePos', label: 'SC 收盘位置', min: 0, max: 1, step: 0.05, hint: '收盘要落在当日区间的什么位置之上（0=最低，1=最高），要求有下影收回。' },
      { path: 'bc.volZ', label: 'BC 量能 Z', min: 0, max: 8, step: 0.1, hint: '买入高潮的放量门槛。' },
      { path: 'bc.spreadAtr', label: 'BC 振幅 ATR', min: 0, max: 5, step: 0.1, hint: '买入高潮的振幅下限。' },
      { path: 'bc.closePos', label: 'BC 收盘位置', min: 0, max: 1, step: 0.05, hint: '收盘要压在当日区间低位之下（上影出货），调小更严格。' },
    ],
  },
  {
    title: '反弹 / 测试 / 弹簧',
    items: [
      { path: 'ar.reboundAtr', label: 'AR 反弹 ATR', min: 0.5, max: 6, step: 0.1, hint: '高潮后反向走多少 ATR 才承认 AR。调大 → 区间更窄、AR 更少。' },
      { path: 'ar.maxBars', label: 'AR 最大 bar', min: 2, max: 30, step: 1, hint: '高潮后多少根内没等到 AR 就放弃这次高潮。' },
      { path: 'st.toleranceAtr', label: 'ST 容差 ATR', min: 0.1, max: 2, step: 0.1, hint: '二次测试 / Test 允许离关键价位多远。调大 → 更容易出现 ST / Test。' },
      { path: 'spring.maxBreakAtr', label: 'Spring 破位 ATR', min: 0, max: 3, step: 0.1, hint: 'Spring 允许跌穿下沿的最大深度。调大 → Spring 更多（含更深的假破位）。' },
      { path: 'spring.confirmBars', label: 'Spring 确认 bar', min: 0, max: 10, step: 1, hint: '跌破后多少根内收回下沿才算确认。调大 → 容忍更久的破位，信号更迟。' },
      { path: 'utad.maxBreakAtr', label: 'UTAD 破位 ATR', min: 0, max: 3, step: 0.1, hint: 'UTAD 允许冲出上沿的最大幅度。' },
      { path: 'utad.confirmBars', label: 'UTAD 确认 bar', min: 0, max: 10, step: 1, hint: '冲出后多少根内跌回上沿之下才算确认。' },
    ],
  },
  {
    title: '强弱信号 / 回踩',
    items: [
      { path: 'sos.spreadAtr', label: 'SOS 振幅 ATR', min: 0, max: 5, step: 0.1, hint: '突破当根的振幅下限，要求是「宽振幅」突破。' },
      { path: 'sos.closePos', label: 'SOS 收盘位置', min: 0, max: 1, step: 0.05, hint: '收盘要在当日区间偏高位（需求接管）。调大更严格。' },
      { path: 'sos.volZ', label: 'SOS 量能 Z', min: -2, max: 5, step: 0.1, hint: 'SOS 的放量门槛。调高 → 突破信号更少但更真。' },
      { path: 'sos.breakAtr', label: 'SOS 突破 ATR', min: 0, max: 2, step: 0.1, hint: '收盘要高出上沿多少 ATR。调大 → 过滤小幅假突破。' },
      { path: 'sow.spreadAtr', label: 'SOW 振幅 ATR', min: 0, max: 5, step: 0.1, hint: '跌破当根的振幅下限。' },
      { path: 'sow.closePos', label: 'SOW 收盘位置', min: 0, max: 1, step: 0.05, hint: '收盘要压在当日区间偏低位。调小更严格。' },
      { path: 'sow.volZ', label: 'SOW 量能 Z', min: -2, max: 5, step: 0.1, hint: 'SOW 的放量门槛。' },
      { path: 'sow.breakAtr', label: 'SOW 突破 ATR', min: 0, max: 2, step: 0.1, hint: '收盘要低于下沿多少 ATR。' },
      { path: 'lps.maxPullbackAtr', label: 'LPS 回撤 ATR', min: 0.2, max: 4, step: 0.1, hint: 'SOS 之后回踩的深度上限。调大 → LPS 更容易出现。' },
      { path: 'lps.maxBars', label: 'LPS 最大 bar', min: 2, max: 30, step: 1, hint: 'SOS 之后多少根内回踩才算 LPS。' },
      { path: 'lpsy.maxRallyAtr', label: 'LPSY 反弹 ATR', min: 0.2, max: 4, step: 0.1, hint: 'SOW 之后反弹的高度上限。' },
      { path: 'lpsy.maxBars', label: 'LPSY 最大 bar', min: 2, max: 30, step: 1, hint: 'SOW 之后多少根内反弹才算 LPSY。' },
    ],
  },
]

const DEFAULTS = mergeConfig({})

function getIn(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function setIn(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

export const PARAM_ITEMS = PARAM_GROUPS.flatMap((g) => g.items)

export function defaultParams() {
  const out = {}
  for (const item of PARAM_ITEMS) out[item.path] = getIn(DEFAULTS, item.path)
  return out
}

/** 扁平参数 → 可提交给后端的嵌套 wyckoff 配置 */
export function buildWyckoffConfig(flat = {}) {
  const out = {}
  for (const item of PARAM_ITEMS) {
    const v = flat[item.path]
    if (v == null || !Number.isFinite(+v)) continue
    setIn(out, item.path, +v)
  }
  return out
}

/** 嵌套配置 → 扁平参数（只保留 PARAM_ITEMS 认识的 path） */
export function flattenConfig(nested = {}) {
  const out = {}
  for (const item of PARAM_ITEMS) {
    const v = getIn(nested, item.path)
    if (v != null && Number.isFinite(+v)) out[item.path] = +v
  }
  return out
}

/** 扁平参数里某项是否与默认值不同 */
export function isParamChanged(flat, path) {
  const def = getIn(DEFAULTS, path)
  const cur = flat[path]
  if (cur == null || def == null) return cur !== def
  return +cur !== +def
}

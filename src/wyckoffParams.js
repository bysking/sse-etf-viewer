// 研究页可调 Wyckoff 参数：扁平 path ↔ 嵌套配置。
import { mergeConfig } from '../shared/wyckoff/config.js'

export const PARAM_GROUPS = [
  {
    title: '结构与区间',
    items: [
      { path: 'swing.atrPeriod', label: 'ATR 周期', min: 2, max: 100, step: 1 },
      { path: 'swing.atrMult', label: 'ZigZag 阈值', min: 0.5, max: 5, step: 0.1 },
      { path: 'swing.confirmBars', label: '确认 bar', min: 0, max: 10, step: 1 },
      { path: 'range.minBars', label: '区间最短', min: 5, max: 200, step: 1 },
      { path: 'range.maxWidthAtr', label: '区间最大宽度', min: 0.5, max: 8, step: 0.1 },
      { path: 'range.minTouches', label: '最少触碰', min: 1, max: 6, step: 1 },
      { path: 'range.breakAtr', label: '突破缓冲', min: 0, max: 2, step: 0.1 },
      { path: 'range.sideLookbackBars', label: '方向推断窗口', min: 0, max: 250, step: 10 },
      { path: 'range.sideMinReturn', label: '方向推断阈值', min: 0, max: 0.5, step: 0.01 },
    ],
  },
  {
    title: '量能与高潮',
    items: [
      { path: 'volume.maPeriod', label: '量能均线', min: 2, max: 120, step: 1 },
      { path: 'volume.zWindow', label: '量能 Z 窗口', min: 5, max: 250, step: 1 },
      { path: 'volume.highZ', label: '高量 Z', min: 0, max: 8, step: 0.1 },
      { path: 'volume.lowZ', label: '低量 Z', min: -8, max: 0, step: 0.1 },
      { path: 'sc.lookback', label: 'SC 回溯', min: 10, max: 250, step: 1 },
      { path: 'sc.volZ', label: 'SC 量能 Z', min: 0, max: 8, step: 0.1 },
      { path: 'sc.spreadAtr', label: 'SC 振幅 ATR', min: 0, max: 5, step: 0.1 },
      { path: 'sc.closePos', label: 'SC 收盘位置', min: 0, max: 1, step: 0.05 },
      { path: 'bc.volZ', label: 'BC 量能 Z', min: 0, max: 8, step: 0.1 },
      { path: 'bc.spreadAtr', label: 'BC 振幅 ATR', min: 0, max: 5, step: 0.1 },
      { path: 'bc.closePos', label: 'BC 收盘位置', min: 0, max: 1, step: 0.05 },
    ],
  },
  {
    title: '反弹 / 测试 / 弹簧',
    items: [
      { path: 'ar.reboundAtr', label: 'AR 反弹 ATR', min: 0.5, max: 6, step: 0.1 },
      { path: 'ar.maxBars', label: 'AR 最大 bar', min: 2, max: 30, step: 1 },
      { path: 'st.toleranceAtr', label: 'ST 容差 ATR', min: 0.1, max: 2, step: 0.1 },
      { path: 'spring.maxBreakAtr', label: 'Spring 破位 ATR', min: 0, max: 3, step: 0.1 },
      { path: 'spring.confirmBars', label: 'Spring 确认 bar', min: 0, max: 10, step: 1 },
      { path: 'utad.maxBreakAtr', label: 'UTAD 破位 ATR', min: 0, max: 3, step: 0.1 },
      { path: 'utad.confirmBars', label: 'UTAD 确认 bar', min: 0, max: 10, step: 1 },
    ],
  },
  {
    title: '强弱信号 / 回踩',
    items: [
      { path: 'sos.spreadAtr', label: 'SOS 振幅 ATR', min: 0, max: 5, step: 0.1 },
      { path: 'sos.closePos', label: 'SOS 收盘位置', min: 0, max: 1, step: 0.05 },
      { path: 'sos.volZ', label: 'SOS 量能 Z', min: -2, max: 5, step: 0.1 },
      { path: 'sos.breakAtr', label: 'SOS 突破 ATR', min: 0, max: 2, step: 0.1 },
      { path: 'sow.spreadAtr', label: 'SOW 振幅 ATR', min: 0, max: 5, step: 0.1 },
      { path: 'sow.closePos', label: 'SOW 收盘位置', min: 0, max: 1, step: 0.05 },
      { path: 'sow.volZ', label: 'SOW 量能 Z', min: -2, max: 5, step: 0.1 },
      { path: 'sow.breakAtr', label: 'SOW 突破 ATR', min: 0, max: 2, step: 0.1 },
      { path: 'lps.maxPullbackAtr', label: 'LPS 回撤 ATR', min: 0.2, max: 4, step: 0.1 },
      { path: 'lps.maxBars', label: 'LPS 最大 bar', min: 2, max: 30, step: 1 },
      { path: 'lpsy.maxRallyAtr', label: 'LPSY 反弹 ATR', min: 0.2, max: 4, step: 0.1 },
      { path: 'lpsy.maxBars', label: 'LPSY 最大 bar', min: 2, max: 30, step: 1 },
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

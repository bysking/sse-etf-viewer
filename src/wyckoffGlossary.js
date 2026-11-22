// Wyckoff 事件释义：页面上点事件旁的 ⓘ 弹出解释。
// 文案与 shared/wyckoff/analyzer.js 的实际识别条件保持一致；改阈值实现时请同步更新。
export const EVENT_DOCS = {
  SC: {
    label: '卖出高潮',
    en: 'Selling Climax',
    side: 'accumulation',
    summary: '下跌末端的放量恐慌抛售，长下影收回，供给被一次性吸收。',
    detect: '创新低 + 量能 Z ≥ sc.volZ + 振幅 ≥ sc.spreadAtr ATR + 收盘在当日区间上半部',
    usage: '只作背景，不单独入场：之后要等 AR 划出区间，再到 ST / Spring 才谈买点。',
  },
  BC: {
    label: '买入高潮',
    en: 'Buying Climax',
    side: 'distribution',
    summary: '上涨末端的放量抢筹，宽振幅但收盘压在当日低位，需求被一次性耗尽。',
    detect: '创新高 + 量能 Z ≥ bc.volZ + 振幅 ≥ bc.spreadAtr ATR + 收盘在当日区间下半部',
    usage: '长多策略里是减仓与风险提示，校准结果显示它不是可靠的清仓信号。',
  },
  AR: {
    label: '自动反弹 / 自动回落',
    en: 'Automatic Rally / Reaction',
    side: 'neutral',
    summary: '高潮之后的第一段反向走势，与高潮价位一起划定交易区间的上下沿。',
    detect: 'SC / BC 之后 ar.maxBars 根内反向走出 ≥ ar.reboundAtr ATR',
    usage: 'AR 出现才算「有区间」。区间没成形之前，Spring / SOS 都无从判断。',
  },
  ST: {
    label: '二次测试',
    en: 'Secondary Test',
    side: 'neutral',
    summary: '价格再次回到高潮价位附近，但量能明显小于高潮量，说明该方向力量在衰减。',
    detect: '回到高潮价 ± st.toleranceAtr ATR，且成交量低于高潮当日（st.volBelowClimax）',
    usage: '区间成立的证据。ST 之后区间内的事件（Spring / UTAD）才更可信。',
  },
  Spring: {
    label: '弹簧 / 诱空',
    en: 'Spring',
    side: 'accumulation',
    summary: '吸筹区间内短暂跌破下沿又收回，把最后一批浮筹洗出去。',
    detect: '跌破区间下沿但幅度 ≤ spring.maxBreakAtr ATR，并在 spring.confirmBars 根内收盘回到下沿之上',
    usage: '校准里最稳定的多头入场事件。务必用确认日，不是跌破当天。',
  },
  Test: {
    label: '测试',
    en: 'Test',
    side: 'accumulation',
    summary: 'Spring 之后再次回踩低点，量更小且收盘高于 Spring 低点，确认供给真的枯竭。',
    detect: 'Spring 后回踩 Spring 低点 ± st.toleranceAtr ATR，量小于 Spring 当日，收盘高于 Spring 低点',
    usage: 'Spring 的确认信号。带 Test 的 Spring 通常比孤立的 Spring 更干净。',
  },
  UTAD: {
    label: '派发后上冲 / 诱多',
    en: 'Upthrust After Distribution',
    side: 'distribution',
    summary: '派发区间内向上假突破又跌回区间，诱多出货。',
    detect: '上破区间上沿但幅度 ≤ utad.maxBreakAtr ATR，并在 utad.confirmBars 根内收盘跌回上沿之下',
    usage: '出场的风险提示与「不追高」信号，不要当作精确卖点。',
  },
  SOS: {
    label: '强势信号',
    en: 'Sign of Strength',
    side: 'accumulation',
    summary: '放量宽振幅向上突破区间上沿并收在高位，需求接管。',
    detect: '收盘 > 上沿 + sos.breakAtr ATR，且振幅 ≥ sos.spreadAtr ATR、收盘位置 ≥ sos.closePos、量能 Z ≥ sos.volZ',
    usage: '突破确认，进入 markup。ETF 上依赖市场环境，建议叠加周线或份额流确认。',
  },
  SOW: {
    label: '弱势信号',
    en: 'Sign of Weakness',
    side: 'distribution',
    summary: '放量收阴向下突破区间下沿，供给接管。',
    detect: '收盘 < 下沿 − sow.breakAtr ATR，且振幅 ≥ sow.spreadAtr ATR、收盘位置 ≤ sow.closePos、量能 Z ≥ sow.volZ',
    usage: 'markdown 的起点。多头持仓时用来收紧止损；本系统不做空，不据此反手。',
  },
  LPS: {
    label: '最后支撑点',
    en: 'Last Point of Support',
    side: 'accumulation',
    summary: 'SOS 突破后缩量回踩上沿附近不破，确认支撑。',
    detect: 'SOS 后 lps.maxBars 根内回踩 ≤ lps.maxPullbackAtr ATR、收盘仍在上沿之上、量能低于量能均线',
    usage: '突破回踩的加仓点。单独当入场信号偏弱，更适合做确认。',
  },
  LPSY: {
    label: '最后供给点',
    en: 'Last Point of Supply',
    side: 'distribution',
    summary: 'SOW 跌破后缩量反弹到下沿附近失败，确认上方压力。',
    detect: 'SOW 后 lpsy.maxBars 根内反弹 ≤ lpsy.maxRallyAtr ATR、收盘仍在下沿之下、量能低于量能均线',
    usage: '反弹逃命点。长多策略里作风险提示，不是可靠卖点。',
  },
}

export const SIDE_TEXT = { accumulation: '吸筹', distribution: '派发', neutral: '结构' }

export const EVENT_TYPES_DOC = Object.keys(EVENT_DOCS)

export function eventDoc(type) {
  return EVENT_DOCS[type] || null
}

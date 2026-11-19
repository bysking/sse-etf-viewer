// 上交所实时快照（yunhq）。仅用于盘中辅助，日频监控不依赖。
import { httpGet, stripJsonp, YUNHQ_BASES, INDEX_REFERER } from '../sse.js'

const SELECT = 'code,name,last,open,high,low,prev_close,volume,amount'

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 纯函数：解析 snap 响应，便于单测 */
export function parseSnap(json) {
  const s = json?.snap
  if (!Array.isArray(s) || s.length < 9) throw new Error('快照响应格式异常')
  const rawDate = String(Math.trunc(Number(json.date)))
  return {
    code: String(s[0] ?? json.code ?? ''),
    name: String(s[1] ?? ''),
    date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}`,
    time: String(json.time ?? ''),
    last: num(s[2]),
    open: num(s[3]),
    high: num(s[4]),
    low: num(s[5]),
    prevClose: num(s[6]),
    volume: num(s[7]),
    amount: num(s[8]),
  }
}

export async function getSnap(code) {
  const qs = new URLSearchParams({ select: SELECT })
  let lastErr = null
  for (const base of YUNHQ_BASES) {
    try {
      const text = await httpGet(`${base}/v1/sh1/snap/${code}?${qs}`, INDEX_REFERER)
      return parseSnap(JSON.parse(stripJsonp(text)))
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`获取实时快照失败（${code}）：${lastErr?.message || '无可用行情地址'}`)
}

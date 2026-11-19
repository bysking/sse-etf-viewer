// 交易日历：以上证指数日 K 的日期集合为准（含节假日停市）。
import { getKline } from './kline.js'

export async function getCalendar(start, end) {
  const k = await getKline('000001', start, end)
  return { dates: k.series.map((r) => r[0]), asof: k.asof }
}

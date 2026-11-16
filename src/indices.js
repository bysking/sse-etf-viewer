// 可叠加的指数：代码 → 名称。默认上证指数。
// 均经过 yunhq dayk 接口实测可用；用户也可输入任意 6 位代码。
export const INDICES = [
  { code: '000001', name: '上证指数' },
  { code: '000300', name: '沪深300' },
  { code: '000016', name: '上证50' },
  { code: '000905', name: '中证500' },
  { code: '000688', name: '科创50' },
  { code: '000852', name: '中证1000' },
  { code: '000903', name: '中证100' },
  { code: '000010', name: '上证180' },
  { code: '000015', name: '上证红利' },
]

export const DEFAULT_INDEX = '000001'

const MAP = new Map(INDICES.map((i) => [i.code, i.name]))

/** 有内置名称就用内置，否则回退成代码本身（自定义指数） */
export const indexName = (code) => MAP.get(code) || (code ? `指数 ${code}` : '指数')

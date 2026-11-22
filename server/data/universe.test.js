import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStockRows, boardOf } from './universe.js'

const row = (code, name, extra = {}) => ({
  A_STOCK_CODE: code,
  SEC_NAME_CN: name,
  COMPANY_ABBR: name,
  DELIST_DATE: '-',
  ...extra,
})

test('parseStockRows：保留正常 A 股，过滤占位与退市', () => {
  const rows = [
    row('600000', '浦发银行'),
    row('600001', '-'), // 占位行
    row('600002', '-'),
    row('600003', '已退市', { DELIST_DATE: '20200101' }),
    row('-', '无代码'),
    row('12345', '代码不足 6 位'),
    row('688981', '中芯国际'),
  ]
  const out = parseStockRows(rows)
  assert.deepEqual(out.map((x) => x.code), ['600000', '688981'])
  assert.equal(out[0].type, 'stock')
  assert.equal(out[0].name, '浦发银行')
})

test('parseStockRows：名称回退到 COMPANY_ABBR / SEC_NAME_FULL', () => {
  const out = parseStockRows([
    { A_STOCK_CODE: '600004', SEC_NAME_CN: '-', COMPANY_ABBR: '白云机场', DELIST_DATE: '-' },
    { A_STOCK_CODE: '600005', SEC_NAME_FULL: '某某股份', DELIST_DATE: '-' },
  ])
  assert.equal(out[0].name, '白云机场')
  assert.equal(out[1].name, '某某股份')
})

test('parseStockRows：空输入返回空数组', () => {
  assert.deepEqual(parseStockRows([]), [])
  assert.deepEqual(parseStockRows(null), [])
})

test('boardOf：按代码前缀区分板块', () => {
  assert.equal(boardOf('600519'), '主板')
  assert.equal(boardOf('601318'), '主板')
  assert.equal(boardOf('603288'), '主板')
  assert.equal(boardOf('605499'), '主板')
  assert.equal(boardOf('688981'), '科创板')
  assert.equal(boardOf('510300'), 'ETF')
  assert.equal(boardOf('000001'), '指数')
  assert.equal(boardOf('300750'), '其他')
})

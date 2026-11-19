import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDayk } from './kline.js'
import { parseSnap } from './snap.js'

test('parseDayk：日期转换、排序与非法行过滤', () => {
  const out = parseDayk({
    code: '510300',
    total: 3,
    kline: [
      [20261119, 4.05, 4.2, 4.0, 4.15, 2000],
      [20261118, 4.0, 4.1, 3.9, 4.05, 1000],
      [20261117, 'bad', 1, 2, 3, 4],
    ],
  })
  assert.equal(out.code, '510300')
  assert.equal(out.series.length, 2)
  assert.deepEqual(out.series[0], ['2026-11-18', 4.0, 4.1, 3.9, 4.05, 1000])
  assert.deepEqual(out.series[1], ['2026-11-19', 4.05, 4.2, 4.0, 4.15, 2000])
})

test('parseSnap：按 select 顺序解析快照字段', () => {
  const snap = parseSnap({
    code: '510300',
    date: 20261119,
    time: 162902,
    snap: ['510300', '300ETF', 4.06, 4.046, 4.072, 4.013, 4.058, 2790941681, 11293465472],
  })
  assert.equal(snap.code, '510300')
  assert.equal(snap.name, '300ETF')
  assert.equal(snap.date, '2026-11-19')
  assert.equal(snap.last, 4.06)
  assert.equal(snap.prevClose, 4.058)
  assert.equal(snap.amount, 11293465472)
})

test('parseSnap：格式异常时报错', () => {
  assert.throws(() => parseSnap({ snap: [] }), /格式异常/)
})

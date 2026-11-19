import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apiMiddleware } from './api.js'
import { closeDb } from './store/db.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-api-'))
process.env.DATA_DIR = dir

let server
let base

before(async () => {
  const api = apiMiddleware()
  server = http.createServer((req, res) => api(req, res, () => {
    res.statusCode = 404
    res.end('not found')
  }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function call(method, pathname, body) {
  const r = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await r.json().catch(() => null)
  return { status: r.status, body: j }
}

const validConfig = {
  symbol: '510300',
  wyckoff: { swing: { atrPeriod: 14, atrMult: 1.5, confirmBars: 2 } },
  entry: { all: [{ event: 'Spring', withinBars: 5 }] },
  exit: { any: [{ event: 'SOS', withinBars: 3 }] },
}

test('策略 CRUD API', async () => {
  const created = await call('POST', '/api/strategies', { name: 'API 测试', config: validConfig })
  assert.equal(created.status, 201)
  assert.ok(created.body.id)

  const list = await call('GET', '/api/strategies')
  assert.equal(list.status, 200)
  assert.ok(list.body.items.some((s) => s.id === created.body.id))

  const one = await call('GET', `/api/strategies/${created.body.id}`)
  assert.equal(one.status, 200)
  assert.equal(one.body.config.symbol, '510300')

  const updated = await call('PUT', `/api/strategies/${created.body.id}`, { enabled: false, name: '改名' })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.enabled, false)
  assert.equal(updated.body.name, '改名')

  const del = await call('DELETE', `/api/strategies/${created.body.id}`)
  assert.equal(del.status, 200)
  const missing = await call('GET', `/api/strategies/${created.body.id}`)
  assert.equal(missing.status, 404)
})

test('非法策略配置返回 400', async () => {
  const r1 = await call('POST', '/api/strategies', { name: 'bad', config: { symbol: '123' } })
  assert.equal(r1.status, 400)
  assert.match(r1.body.error, /6 位代码/)

  const r2 = await call('POST', '/api/strategies', {
    name: 'bad2',
    config: { symbol: '510300', wyckoff: { swing: { atrMult: -1 } } },
  })
  assert.equal(r2.status, 400)
  assert.match(r2.body.error, /atrMult/)
})

test('未知回测任务返回 404', async () => {
  const r = await call('GET', '/api/backtests/not-exist')
  assert.equal(r.status, 404)
})

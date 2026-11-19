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
let llmServer
let llmBase
let lastLlm = null

before(async () => {
  const api = apiMiddleware()
  server = http.createServer((req, res) => api(req, res, () => {
    res.statusCode = 404
    res.end('not found')
  }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`

  // 本地 mock OpenAI-compatible 端点，避免测试依赖外部模型
  llmServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      lastLlm = { url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          model: 'mock-model',
          choices: [{ message: { role: 'assistant', content: 'AI OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      )
    })
  })
  await new Promise((r) => llmServer.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${llmServer.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
  await new Promise((r) => llmServer.close(r))
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
  exit: {
    any: [
      { event: 'SOS', withinBars: 3 },
      { stopLoss: { reference: 'rangeLow', bufferAtr: 0.5 } },
    ],
  },
  execution: {
    fillAt: 'nextOpen',
    position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1 },
    feeRate: 0.0003,
    lotSize: 100,
  },
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

test('策略编写 schema 可供 AI 读取', async () => {
  const r = await call('GET', '/api/strategy-authoring/schema')
  assert.equal(r.status, 200)
  assert.equal(r.body.engine, 'wyckoff-v1')
  assert.ok(r.body.events.includes('Spring'))
  assert.ok(r.body.constraints.some((c) => /stopLoss/.test(c)))
  assert.ok(r.body.example.entry && r.body.example.exit)
})

test('AI 配置脱敏、测试连接与聊天', async () => {
  const beforeCfg = await call('GET', '/api/ai/config')
  assert.equal(beforeCfg.status, 200)
  assert.equal(beforeCfg.body.configured, false)

  const saved = await call('PUT', '/api/ai/config', {
    baseUrl: `${llmBase}/v1`,
    model: 'mock-model',
    apiKey: 'secret-key',
    temperature: 0.2,
    maxTokens: 128,
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.configured, true)
  assert.equal(saved.body.apiKeySet, true)
  assert.ok(!JSON.stringify(saved.body).includes('secret-key'))

  const cfg = await call('GET', '/api/ai/config')
  assert.equal(cfg.body.model, 'mock-model')
  assert.equal(cfg.body.apiKeySet, true)
  assert.ok(!JSON.stringify(cfg.body).includes('secret-key'))

  const test = await call('POST', '/api/ai/test', {})
  assert.equal(test.status, 200)
  assert.equal(test.body.ok, true)
  assert.equal(test.body.content, 'AI OK')
  assert.equal(lastLlm.auth, 'Bearer secret-key')
  assert.equal(lastLlm.url, '/v1/chat/completions')

  const chat = await call('POST', '/api/ai/chat', {
    messages: [{ role: 'user', content: '你好' }],
    contextText: 'CONTEXT',
  })
  assert.equal(chat.status, 200)
  assert.equal(chat.body.content, 'AI OK')
  assert.equal(lastLlm.body.messages[0].role, 'system')
  assert.match(lastLlm.body.messages[0].content, /CONTEXT/)
  assert.equal(lastLlm.body.messages[1].role, 'user')

  const badCfg = await call('PUT', '/api/ai/config', { baseUrl: 'ftp://bad', model: 'm' })
  assert.equal(badCfg.status, 400)
})

test('快速回测路由先于 /api/backtests/:id 匹配，并校验配置', async () => {
  const r = await call('POST', '/api/backtests/quick', {
    config: { symbol: '123', wyckoff: {} },
    start: '2025-01-01',
    end: '2025-12-31',
  })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /6 位代码/)
})

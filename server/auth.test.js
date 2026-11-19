import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createAuthMiddleware, isAuthEnabled, authToken } from './auth.js'

const ORIGINAL = process.env.APP_AUTH_TOKEN

after(() => {
  if (ORIGINAL === undefined) delete process.env.APP_AUTH_TOKEN
  else process.env.APP_AUTH_TOKEN = ORIGINAL
})

function run(mw, { url = '/api/strategies', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = { url, headers }
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v
      },
      end(body) {
        resolve({ status: this.statusCode, body, headers: this.headers })
      },
    }
    const ok = mw(req, res)
    if (ok) resolve({ passed: true, status: res.statusCode })
  })
}

test('未配置 token 时不启用鉴权', () => {
  delete process.env.APP_AUTH_TOKEN
  assert.equal(isAuthEnabled(), false)
  assert.equal(authToken(), null)
  assert.equal(createAuthMiddleware(), null)
})

test('过短的 token 视为未配置', () => {
  process.env.APP_AUTH_TOKEN = 'short'
  assert.equal(isAuthEnabled(), false)
  assert.equal(createAuthMiddleware(), null)
})

test('配置 token 后：无凭据返回 401', async () => {
  process.env.APP_AUTH_TOKEN = 'valid-token-123456'
  const mw = createAuthMiddleware()
  const r = await run(mw)
  assert.equal(r.status, 401)
  assert.match(r.body, /访问令牌/)
})

test('Bearer 头正确才放行', async () => {
  process.env.APP_AUTH_TOKEN = 'valid-token-123456'
  const mw = createAuthMiddleware()
  assert.equal((await run(mw, { headers: { authorization: 'Bearer valid-token-123456' } })).passed, true)
  const bad = await run(mw, { headers: { authorization: 'Bearer wrong-token-123456' } })
  assert.equal(bad.status, 401)
})

test('支持 x-auth-token 与 ?token= 两种方式', async () => {
  process.env.APP_AUTH_TOKEN = 'valid-token-123456'
  const mw = createAuthMiddleware()
  assert.equal((await run(mw, { headers: { 'x-auth-token': 'valid-token-123456' } })).passed, true)
  assert.equal((await run(mw, { url: '/api/strategies?token=valid-token-123456' })).passed, true)
  const wrong = await run(mw, { url: '/api/strategies?token=nope' })
  assert.equal(wrong.status, 401)
})

test('健康检查在白名单内，无需凭据', async () => {
  process.env.APP_AUTH_TOKEN = 'valid-token-123456'
  const mw = createAuthMiddleware()
  assert.equal((await run(mw, { url: '/api/health' })).passed, true)
})

test('长度不同也返回 401（常量时间比较不抛错）', async () => {
  process.env.APP_AUTH_TOKEN = 'valid-token-123456'
  const mw = createAuthMiddleware()
  const r = await run(mw, { headers: { authorization: 'Bearer x' } })
  assert.equal(r.status, 401)
})

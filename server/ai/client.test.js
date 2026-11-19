import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { AiError, chatCompletion, normalizeBaseUrl } from './client.js'

let server
let baseUrl
let mode = 'ok'
let lastReq = null

before(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      lastReq = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }
      res.setHeader('Content-Type', 'application/json')
      if (mode === 'error') {
        res.statusCode = 401
        res.end(JSON.stringify({ error: { message: 'bad key', type: 'invalid_request_error' } }))
        return
      }
      if (mode === 'ratelimit') {
        res.statusCode = 429
        res.end(JSON.stringify({ error: { message: 'slow down' } }))
        return
      }
      if (mode === 'server') {
        res.statusCode = 500
        res.end(JSON.stringify({ error: { message: 'boom' } }))
        return
      }
      if (mode === 'empty') {
        res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }))
        return
      }
      if (mode === 'array') {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'world' }] } }],
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          model: 'mock-model',
          choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      )
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
})

test('normalizeBaseUrl 兼容常见 baseUrl 写法', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com'), 'https://api.openai.com/v1')
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1')
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
  assert.equal(normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1')
  // 用户误填完整端点时去掉后缀，避免 SDK 重复拼接
  assert.equal(normalizeBaseUrl('https://example.com/v1/chat/completions'), 'https://example.com/v1')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), /http/)
  assert.throws(() => normalizeBaseUrl(''), /baseUrl/)
})

test('chatCompletion 发送标准 OpenAI 请求并解析响应', async () => {
  mode = 'ok'
  const res = await chatCompletion(
    { baseUrl: `${baseUrl}/v1`, apiKey: 'secret', model: 'mock-model', temperature: 0.2, maxTokens: 128 },
    [{ role: 'user', content: 'hi' }],
  )
  assert.equal(res.content, 'OK')
  assert.equal(res.model, 'mock-model')
  assert.equal(res.finishReason, 'stop')
  assert.equal(res.usage.prompt_tokens, 10)
  assert.equal(lastReq.url, '/v1/chat/completions')
  assert.equal(lastReq.headers.authorization, 'Bearer secret')
  assert.equal(lastReq.body.model, 'mock-model')
  assert.equal(lastReq.body.max_tokens, 128)
  assert.equal(lastReq.body.temperature, 0.2)
  assert.equal(lastReq.body.stream, false)
  assert.deepEqual(lastReq.body.messages, [{ role: 'user', content: 'hi' }])
})

test('没有 apiKey 时也能调用本地端点（占位 Key，不发送空 Authorization）', async () => {
  mode = 'ok'
  await chatCompletion({ baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model' }, [{ role: 'user', content: 'hi' }])
  assert.ok(lastReq.headers.authorization, 'SDK 需要占位 Key 才会发请求')
})

test('上游 401 映射为鉴权错误，且不泄漏密钥', async () => {
  mode = 'error'
  await assert.rejects(
    chatCompletion({ baseUrl: `${baseUrl}/v1`, apiKey: 'secret', model: 'mock-model' }, [{ role: 'user', content: 'hi' }]),
    (e) => {
      assert.ok(e instanceof AiError)
      assert.equal(e.status, 401)
      assert.equal(e.code, 'auth')
      assert.equal(e.retryable, false)
      assert.match(e.message, /鉴权|API Key/)
      assert.ok(!e.message.includes('secret'))
      return true
    },
  )
})

test('429 标记为可重试，5xx 标记为可重试', async () => {
  mode = 'ratelimit'
  await assert.rejects(
    chatCompletion({ baseUrl: `${baseUrl}/v1`, apiKey: 'k', model: 'mock-model' }, [{ role: 'user', content: 'hi' }]),
    (e) => e instanceof AiError && e.code === 'rate_limit' && e.retryable === true,
  )
  mode = 'server'
  await assert.rejects(
    chatCompletion({ baseUrl: `${baseUrl}/v1`, apiKey: 'k', model: 'mock-model' }, [{ role: 'user', content: 'hi' }]),
    (e) => e instanceof AiError && e.status === 500 && e.retryable === true,
  )
})

test('content 数组分段会被合并', async () => {
  mode = 'array'
  const res = await chatCompletion({ baseUrl: `${baseUrl}/v1`, model: 'mock-model' }, [{ role: 'user', content: 'hi' }])
  assert.equal(res.content, 'Hello\nworld')
})

test('空内容映射为明确错误', async () => {
  mode = 'empty'
  await assert.rejects(
    chatCompletion({ baseUrl: `${baseUrl}/v1`, model: 'mock-model' }, [{ role: 'user', content: 'hi' }]),
    (e) => e instanceof AiError && e.code === 'empty',
  )
})

test('连接失败与超时映射为可重试错误', async () => {
  // 未监听的端口 → 连接错误
  await assert.rejects(
    chatCompletion({ baseUrl: 'http://127.0.0.1:1/v1', model: 'mock-model' }, [{ role: 'user', content: 'hi' }], {
      timeoutMs: 1500,
    }),
    (e) => e instanceof AiError && (e.code === 'connection' || e.code === 'api') && e.retryable === true,
  )

  // 服务端故意慢响应 → 超时
  const slow = http.createServer((req, res) => setTimeout(() => res.end('{}'), 3000))
  await new Promise((r) => slow.listen(0, '127.0.0.1', r))
  const slowBase = `http://127.0.0.1:${slow.address().port}/v1`
  try {
    await assert.rejects(
      chatCompletion({ baseUrl: slowBase, model: 'mock-model' }, [{ role: 'user', content: 'hi' }], { timeoutMs: 300 }),
      (e) => e instanceof AiError && e.code === 'timeout',
    )
  } finally {
    await new Promise((r) => slow.close(r))
  }
})

test('缺少 model / 非法 temperature 被拒绝', async () => {
  await assert.rejects(chatCompletion({ baseUrl, model: '' }, [{ role: 'user', content: 'hi' }]), /模型/)
  await assert.rejects(
    chatCompletion({ baseUrl, model: 'm', temperature: 3 }, [{ role: 'user', content: 'hi' }]),
    /temperature/,
  )
  await assert.rejects(chatCompletion({ baseUrl, model: 'm' }, []), /messages/)
  await assert.rejects(
    chatCompletion({ baseUrl, model: 'm' }, [{ role: 'tool', content: 'hi' }]),
    /role/,
  )
})

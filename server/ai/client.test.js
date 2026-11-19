import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { AiError, chatCompletion, normalizeChatUrl } from './client.js'

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
        res.end(JSON.stringify({ error: { message: 'bad key' } }))
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

test('normalizeChatUrl 兼容常见 baseUrl 写法', () => {
  assert.equal(normalizeChatUrl('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(normalizeChatUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(normalizeChatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions')
  assert.equal(normalizeChatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(normalizeChatUrl('https://example.com/chat/completions'), 'https://example.com/chat/completions')
  assert.throws(() => normalizeChatUrl('ftp://example.com'), /http/)
})

test('chatCompletion 发送标准 OpenAI 请求并解析响应', async () => {
  mode = 'ok'
  const res = await chatCompletion(
    { baseUrl: `${baseUrl}/v1`, apiKey: 'secret', model: 'mock-model', temperature: 0.2, maxTokens: 128 },
    [{ role: 'user', content: 'hi' }],
  )
  assert.equal(res.content, 'OK')
  assert.equal(res.model, 'mock-model')
  assert.equal(res.usage.prompt_tokens, 10)
  assert.equal(lastReq.url, '/v1/chat/completions')
  assert.equal(lastReq.headers.authorization, 'Bearer secret')
  assert.equal(lastReq.body.model, 'mock-model')
  assert.equal(lastReq.body.max_tokens, 128)
  assert.equal(lastReq.body.stream, false)
  assert.deepEqual(lastReq.body.messages, [{ role: 'user', content: 'hi' }])
})

test('没有 apiKey 时不发送 Authorization 头（兼容本地 Ollama 等）', async () => {
  mode = 'ok'
  await chatCompletion({ baseUrl: `${baseUrl}/v1`, apiKey: '', model: 'mock-model' }, [{ role: 'user', content: 'hi' }])
  assert.equal(lastReq.headers.authorization, undefined)
})

test('上游错误解析为 AiError，且不泄漏密钥', async () => {
  mode = 'error'
  await assert.rejects(
    chatCompletion({ baseUrl: `${baseUrl}/v1`, apiKey: 'secret', model: 'mock-model' }, [{ role: 'user', content: 'hi' }]),
    (e) => {
      assert.ok(e instanceof AiError)
      assert.equal(e.status, 401)
      assert.match(e.message, /bad key/)
      assert.ok(!e.message.includes('secret'))
      return true
    },
  )
})

test('content 数组分段会被合并', async () => {
  mode = 'array'
  const res = await chatCompletion({ baseUrl: `${baseUrl}/v1`, model: 'mock-model' }, [{ role: 'user', content: 'hi' }])
  assert.equal(res.content, 'Hello\nworld')
})

test('空内容与超时映射为明确错误', async () => {
  mode = 'empty'
  await assert.rejects(
    chatCompletion({ baseUrl: `${baseUrl}/v1`, model: 'mock-model' }, [{ role: 'user', content: 'hi' }]),
    /内容为空/,
  )
  const timeoutFetch = async () => {
    const e = new Error('timeout')
    e.name = 'TimeoutError'
    throw e
  }
  await assert.rejects(
    chatCompletion({ baseUrl: 'https://example.com/v1', model: 'mock-model' }, [{ role: 'user', content: 'hi' }], {
      fetchImpl: timeoutFetch,
      timeoutMs: 10,
    }),
    /超时/,
  )
})

test('缺少 model / 非法 temperature 被拒绝', async () => {
  await assert.rejects(chatCompletion({ baseUrl: baseUrl, model: '' }, [{ role: 'user', content: 'hi' }]), /模型/)
  await assert.rejects(
    chatCompletion({ baseUrl: baseUrl, model: 'm', temperature: 3 }, [{ role: 'user', content: 'hi' }]),
    /temperature/,
  )
})

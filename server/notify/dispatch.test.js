import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb } from '../store/db.js'
import feishu, { signFeishu, buildPayload } from './feishu.js'
import telegram, { buildMessageText, endpointOf } from './telegram.js'
import {
  createChannel,
  dispatch,
  listChannels,
  listNotifyLog,
  publicChannel,
  sendToChannel,
  signalMessage,
  updateChannel,
} from './dispatch.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-notify-'))
process.env.DATA_DIR = dir

after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

const msg = { level: 'candidate', title: '测试标题', markdown: '第一行\n第二行' }

test('飞书签名与消息体', () => {
  const sig = signFeishu('secret', 1700000000)
  assert.equal(typeof sig, 'string')
  assert.ok(sig.length > 10)

  const text = buildPayload({ webhookUrl: 'https://x.com/hook' }, msg)
  assert.equal(text.msg_type, 'text')
  assert.match(text.content.text, /测试标题/)

  const card = buildPayload({ webhookUrl: 'https://x.com/hook', useCard: true }, msg)
  assert.equal(card.msg_type, 'interactive')
  assert.equal(card.card.header.title.content, '测试标题')

  const signed = buildPayload({ webhookUrl: 'https://x.com/hook', secret: 'abc' }, msg, 1700000000000)
  assert.equal(signed.timestamp, '1700000000')
  assert.ok(signed.sign)
})

test('飞书配置校验', () => {
  assert.match(feishu.validateConfig({}), /webhookUrl/)
  assert.match(feishu.validateConfig({ webhookUrl: 'ftp://x' }), /http/)
  assert.equal(feishu.validateConfig({ webhookUrl: 'https://x.com/hook' }), null)
})

test('Telegram 消息体：HTML 转义、截断、apiBase', () => {
  const text = buildMessageText({ title: 'A<B>', markdown: 'x & y' })
  assert.match(text, /&lt;/)
  assert.match(text, /&amp;/)

  const long = buildMessageText({ title: 'T', markdown: 'x'.repeat(5000) })
  assert.ok(long.length <= 4000)
  assert.match(long, /截断/)

  assert.equal(endpointOf({ botToken: '123:abc' }), 'https://api.telegram.org/bot123:abc/sendMessage')
  assert.equal(
    endpointOf({ botToken: 't', apiBase: 'http://127.0.0.1:8081/' }),
    'http://127.0.0.1:8081/bott/sendMessage',
  )
})

test('Telegram 配置校验', () => {
  assert.match(telegram.validateConfig({}), /botToken/)
  assert.match(telegram.validateConfig({ botToken: 't' }), /chatId/)
  assert.equal(telegram.validateConfig({ botToken: 't', chatId: '1' }), null)
})

test('渠道 CRUD 与脱敏', () => {
  const ch = createChannel({
    type: 'telegram',
    name: '我的 TG',
    config: { botToken: 'secret-token-abcd', chatId: '123' },
  })
  assert.equal(ch.type, 'telegram')
  assert.equal(ch.enabled, true)

  const pub = publicChannel(ch)
  assert.ok(!JSON.stringify(pub).includes('secret-token-abcd'))
  assert.match(pub.config.botToken, /abcd$/)

  const updated = updateChannel(ch.id, { enabled: false })
  assert.equal(updated.enabled, false)

  assert.throws(() => createChannel({ type: 'wecom', name: 'x', config: {} }), /不支持/)
  assert.throws(() => createChannel({ type: 'feishu', name: 'x', config: {} }), /webhookUrl/)

  assert.ok(listChannels().some((c) => c.id === ch.id))
})

test('发送成功写入日志', async () => {
  let received = null
  const fetchImpl = async (url, init) => {
    received = { url, body: JSON.parse(init.body) }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
  }
  const ch = createChannel({ type: 'telegram', name: 'ok', config: { botToken: 't', chatId: '1' } })
  const r = await sendToChannel(ch, msg, { fetchImpl, signalId: 'sig1' })
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 1)
  assert.equal(received.body.chat_id, '1')
  assert.match(received.body.text, /测试标题/)

  const logs = listNotifyLog()
  assert.equal(logs[0].status, 'ok')
  assert.equal(logs[0].signalId, 'sig1')
})

test('发送失败重试后记录失败日志', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: false, status: 500, text: async () => 'boom' }
  }
  const ch = createChannel({ type: 'telegram', name: 'fail', config: { botToken: 't', chatId: '1' } })
  const r = await sendToChannel(ch, msg, { fetchImpl, retries: 2 })
  assert.equal(r.ok, false)
  assert.equal(calls, 3, '应重试 2 次')
  const logs = listNotifyLog()
  assert.equal(logs[0].status, 'failed')
  assert.match(logs[0].error, /500/)
})

test('飞书 code!=0 即使 HTTP 200 也算失败', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ code: 19021, msg: 'sign match fail' }),
  })
  const ch = createChannel({ type: 'feishu', name: 'feishu', config: { webhookUrl: 'https://x.com/hook' } })
  const r = await sendToChannel(ch, msg, { fetchImpl, retries: 0 })
  assert.equal(r.ok, false)
  assert.match(r.error, /sign match fail/)
})

test('dispatch 只发给启用的渠道，单个失败不影响其他', async () => {
  // 清空已有渠道，构造一个成功一个失败
  for (const c of listChannels()) await import('./dispatch.js').then((m) => m.deleteChannel(c.id))
  const ok = createChannel({ type: 'telegram', name: 'ok', config: { botToken: 't', chatId: '1' } })
  const bad = createChannel({ type: 'telegram', name: 'bad', config: { botToken: 't', chatId: '2' } })
  createChannel({ type: 'telegram', name: 'disabled', config: { botToken: 't', chatId: '3' }, enabled: false })

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.chat_id === '2') return { ok: false, status: 400, text: async () => 'bad' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }
  }
  const r = await dispatch(msg, { fetchImpl })
  assert.equal(r.sent, 1)
  assert.equal(r.failed, 1)
  assert.equal(r.results.length, 2, '停用渠道不应被发送')
  assert.equal(r.results.find((x) => x.channelId === ok.id).ok, true)
  assert.equal(r.results.find((x) => x.channelId === bad.id).ok, false)
})

test('signalMessage 输出候选语义与失效位', () => {
  const m = signalMessage({
    strategyName: 'Spring 反转',
    symbol: '510300',
    signal: {
      action: 'entry_candidate',
      eventType: 'Spring',
      detectedAt: '2026-11-19',
      evidence: { phase: 'accumulation_C', confidence: 0.72, range: { id: 'R-2026-10-23', low: 4.03, high: 4.19 } },
      stopLevel: 3.91,
    },
    price: 4.06,
  })
  assert.match(m.title, /买入观察/)
  assert.match(m.markdown, /Spring/)
  assert.match(m.markdown, /失效位：3\.910/)
  assert.match(m.markdown, /候选信号/)
})

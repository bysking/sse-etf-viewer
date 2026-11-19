// 通知分发：统一消息结构、按渠道发送、重试、限流、落日志。
import { randomUUID } from 'node:crypto'
import { getDb } from '../store/db.js'
import feishu from './feishu.js'
import telegram from './telegram.js'

export const ADAPTERS = { feishu, telegram }

const now = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mapChannel = (row) =>
  row
    ? {
        id: row.id,
        type: row.type,
        name: row.name,
        config: safeParse(row.config_json, {}),
        enabled: !!row.enabled,
        createdAt: row.created_at,
      }
    : null

function safeParse(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}

/** 对外返回时脱敏：不暴露 webhook / token */
export function publicChannel(ch) {
  if (!ch) return null
  const c = { ...ch.config }
  if (c.webhookUrl) c.webhookUrl = maskUrl(c.webhookUrl)
  if (c.botToken) c.botToken = maskSecret(c.botToken)
  if (c.secret) c.secret = maskSecret(c.secret)
  return { ...ch, config: c }
}

const maskSecret = (s) => (String(s).length <= 4 ? '****' : `…${String(s).slice(-4)}`)
function maskUrl(u) {
  try {
    const url = new URL(u)
    return `${url.protocol}//${url.hostname}${url.pathname.slice(0, 12)}…`
  } catch {
    return '…'
  }
}

export function listChannels() {
  return getDb()
    .prepare('SELECT * FROM notify_channels ORDER BY created_at')
    .all()
    .map(mapChannel)
}

export function getChannel(id) {
  return mapChannel(getDb().prepare('SELECT * FROM notify_channels WHERE id = ?').get(id))
}

export function createChannel({ type, name, config = {}, enabled = true }) {
  const adapter = ADAPTERS[type]
  if (!adapter) throw new Error(`不支持的通知渠道：${type}`)
  const err = adapter.validateConfig(config)
  if (err) throw new Error(err)
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO notify_channels (id, type, name, config_json, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, type, String(name || type), JSON.stringify(config), enabled ? 1 : 0, now())
  return getChannel(id)
}

export function updateChannel(id, patch = {}) {
  const cur = getChannel(id)
  if (!cur) return null
  const config = patch.config != null ? patch.config : cur.config
  const adapter = ADAPTERS[cur.type]
  const err = adapter.validateConfig(config)
  if (err) throw new Error(err)
  const name = patch.name != null ? String(patch.name) : cur.name
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled ? 1 : 0
  getDb()
    .prepare('UPDATE notify_channels SET name = ?, config_json = ?, enabled = ? WHERE id = ?')
    .run(name, JSON.stringify(config), enabled, id)
  return getChannel(id)
}

export function deleteChannel(id) {
  return getDb().prepare('DELETE FROM notify_channels WHERE id = ?').run(id).changes > 0
}

export function listNotifyLog(limit = 100) {
  return getDb()
    .prepare('SELECT * FROM notify_log ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      signalId: r.signal_id,
      payloadPreview: r.payload_preview,
      status: r.status,
      httpStatus: r.http_status,
      error: r.error,
      createdAt: r.created_at,
    }))
}

function logSend({ channelId, signalId, preview, status, httpStatus = null, error = null }) {
  getDb()
    .prepare(
      `INSERT INTO notify_log (id, channel_id, signal_id, payload_preview, status, http_status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), channelId, signalId ?? null, preview ?? null, status, httpStatus, error, now())
}

/**
 * 发送到单个渠道，带指数退避重试，并把结果写入 notify_log。
 */
export async function sendToChannel(channel, message, { signalId = null, retries = 2, fetchImpl } = {}) {
  const adapter = ADAPTERS[channel.type]
  if (!adapter) throw new Error(`不支持的通知渠道：${channel.type}`)
  const preview = String(`${message.title || ''} ${message.markdown || ''}`).slice(0, 200)
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await adapter.send(channel.config, message, { fetchImpl })
      logSend({ channelId: channel.id, signalId, preview, status: 'ok', httpStatus: r.status })
      return { ok: true, attempts: attempt + 1, status: r.status }
    } catch (e) {
      lastErr = e
      if (attempt < retries) await sleep(400 * (attempt + 1))
    }
  }
  logSend({ channelId: channel.id, signalId, preview, status: 'failed', error: lastErr?.message ?? 'unknown' })
  return { ok: false, attempts: retries + 1, error: lastErr?.message ?? 'unknown' }
}

/** 发送到多个渠道；单个渠道失败不影响其他渠道 */
export async function dispatch(message, { channelIds = null, signalId = null, fetchImpl } = {}) {
  const all = listChannels().filter((c) => c.enabled)
  const targets = channelIds?.length ? all.filter((c) => channelIds.includes(c.id)) : all
  const results = []
  for (const ch of targets) {
    // 串行发送，避免触发渠道限流
    results.push({ channelId: ch.id, type: ch.type, ...(await sendToChannel(ch, message, { signalId, fetchImpl })) })
  }
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }
}

/** 把候选信号格式化成统一消息 */
export function signalMessage({ strategyName, symbol, signal, price, extra = '' }) {
  const isEntry = signal.action === 'entry_candidate'
  const title = `【威科夫候选】${symbol} ${isEntry ? '买入观察' : '离场观察'}`
  const ev = signal.evidence || {}
  const lines = [
    `策略：${strategyName}`,
    `事件：${signal.eventType}（阶段 ${ev.phase ?? '-'}，置信度 ${ev.confidence ?? '-'}）`,
    `确认日：${signal.detectedAt}　参考价：${price != null ? Number(price).toFixed(3) : '-'}`,
  ]
  if (ev.range) lines.push(`区间：${Number(ev.range.low).toFixed(2)}–${Number(ev.range.high).toFixed(2)}（${ev.range.id}）`)
  if (signal.stopLevel != null) lines.push(`失效位：${Number(signal.stopLevel).toFixed(3)}`)
  if (extra) lines.push(extra)
  lines.push('说明：候选信号，需人工确认；回测按次日开盘成交，未计费用。')
  return { level: 'candidate', title, markdown: lines.join('\n') }
}

// 飞书自定义机器人：支持 text 与 interactive card；可选签名校验。
import crypto from 'node:crypto'

export const type = 'feishu'

const POST = (url, body, fetchImpl) =>
  fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/** 飞书签名：以 timestamp + "\n" + secret 为密钥，对空串做 HmacSHA256，再 base64 */
export function signFeishu(secret, timestampSec) {
  const key = `${timestampSec}\n${secret}`
  return crypto.createHmac('sha256', key).update('').digest('base64')
}

/** 校验配置；返回错误字符串或 null */
export function validateConfig(config = {}) {
  if (!config.webhookUrl) return '飞书需要 webhookUrl'
  try {
    const u = new URL(config.webhookUrl)
    if (!['http:', 'https:'].includes(u.protocol)) return 'webhookUrl 必须是 http/https'
  } catch {
    return 'webhookUrl 不是合法 URL'
  }
  if (config.secret != null && typeof config.secret !== 'string') return 'secret 必须是字符串'
  return null
}

/** 组装飞书消息体 */
export function buildPayload(config, message, now = Date.now()) {
  const base = {}
  if (config.secret) {
    const ts = Math.floor(now / 1000)
    base.timestamp = String(ts)
    base.sign = signFeishu(config.secret, ts)
  }
  if (config.useCard) {
    return {
      ...base,
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: message.level === 'risk' ? 'red' : 'blue',
          title: { tag: 'plain_text', content: String(message.title || '策略信号') },
        },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: String(message.markdown || '') } },
          ...(message.link
            ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看详情' }, url: message.link, type: 'primary' }] }]
            : []),
        ],
      },
    }
  }
  return {
    ...base,
    msg_type: 'text',
    content: { text: `${message.title || '策略信号'}\n\n${message.markdown || ''}${message.link ? `\n\n${message.link}` : ''}` },
  }
}

/** 发送；失败抛错，由上层统一重试与记录 */
export async function send(config, message, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const err = validateConfig(config)
  if (err) throw new Error(err)
  const payload = buildPayload(config, message)
  let res
  try {
    res = await fetchImpl(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    })
  } catch (e) {
    throw new Error(`飞书请求失败：${e.message}`)
  }
  const text = await res.text().catch(() => '')
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    /* 非 JSON 响应 */
  }
  // 飞书即使 HTTP 200 也可能返回 code != 0
  if (!res.ok) throw new Error(`飞书返回 ${res.status}：${text.slice(0, 200)}`)
  if (body && typeof body.code === 'number' && body.code !== 0) {
    throw new Error(`飞书返回错误 ${body.code}：${body.msg || text.slice(0, 200)}`)
  }
  return { ok: true, status: res.status, response: text.slice(0, 500) }
}

export default { type, validateConfig, buildPayload, send, signFeishu }

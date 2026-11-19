// Telegram Bot API：sendMessage，HTML 解析；apiBase 可配置以支持代理/自建 Bot API。
export const type = 'telegram'

export function validateConfig(config = {}) {
  if (!config.botToken) return 'Telegram 需要 botToken'
  if (!config.chatId) return 'Telegram 需要 chatId'
  if (typeof config.botToken !== 'string' || config.botToken.length > 200) return 'botToken 不合法'
  if (config.apiBase) {
    try {
      const u = new URL(config.apiBase)
      if (!['http:', 'https:'].includes(u.protocol)) return 'apiBase 必须是 http/https'
    } catch {
      return 'apiBase 不是合法 URL'
    }
  }
  return null
}

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** 组装纯文本/HTML 消息，4096 字节上限内截断 */
export function buildMessageText(message, maxLen = 4000) {
  const title = escapeHtml(message.title || '策略信号')
  const body = escapeHtml(message.markdown || '')
  const link = message.link ? `\n\n<a href="${escapeHtml(message.link)}">查看详情</a>` : ''
  let text = `<b>${title}</b>\n\n${body}${link}`
  if (text.length > maxLen) text = text.slice(0, maxLen - 20) + '\n…（内容过长已截断）'
  return text
}

export function endpointOf(config) {
  const base = (config.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')
  return `${base}/bot${config.botToken}/sendMessage`
}

export async function send(config, message, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const err = validateConfig(config)
  if (err) throw new Error(err)
  const body = {
    chat_id: config.chatId,
    text: buildMessageText(message),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  let res
  try {
    res = await fetchImpl(endpointOf(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    })
  } catch (e) {
    throw new Error(`Telegram 请求失败：${e.message}`)
  }
  const text = await res.text().catch(() => '')
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  if (!res.ok || (parsed && parsed.ok === false)) {
    const desc = parsed?.description || text.slice(0, 200)
    throw new Error(`Telegram 返回 ${res.status}：${desc}`)
  }
  return { ok: true, status: res.status, response: text.slice(0, 500) }
}

export default { type, validateConfig, buildMessageText, endpointOf, send }
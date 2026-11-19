// OpenAI-compatible Chat Completions 客户端。
// 只支持非流式请求；Anthropic Messages API 等非 chat-completion 端点需要单独适配器。
export class AiError extends Error {
  constructor(message, { status = null, code = null, cause = null } = {}) {
    super(message)
    this.name = 'AiError'
    this.status = status
    this.code = code
    this.cause = cause
  }
}

const trimSlash = (s) => s.replace(/\/+$/, '')

/** 把用户填写的 baseUrl 规范到 chat/completions 端点 */
export function normalizeChatUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') throw new AiError('未配置 AI baseUrl')
  let url
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new AiError('AI baseUrl 不是合法 URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AiError('AI baseUrl 仅支持 http / https')
  const path = trimSlash(url.pathname)
  if (path.endsWith('/chat/completions')) {
    url.pathname = path
    return url.toString()
  }
  if (path.endsWith('/v1')) url.pathname = path + '/chat/completions'
  else if (url.hostname === 'api.openai.com' && !path.startsWith('/v1')) url.pathname = path + '/v1/chat/completions'
  else url.pathname = path + '/chat/completions'
  return url.toString()
}

function contentOf(message) {
  const c = message?.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && typeof p.text === 'string' && (p.type === 'text' || p.type == null))
      .map((p) => p.text)
      .join('\n')
      .trim()
  }
  return ''
}

/**
 * @param {object} config { baseUrl, apiKey, model, temperature, maxTokens }
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} options { fetchImpl, timeoutMs }
 * @returns {Promise<{content:string, usage:object|null, model:string, finishReason:string|null}>}
 */
export async function chatCompletion(config, messages, options = {}) {
  if (!config || !config.model) throw new AiError('未配置 AI 模型')
  if (!Array.isArray(messages) || !messages.length) throw new AiError('messages 不能为空')
  for (const m of messages) {
    if (!['system', 'user', 'assistant'].includes(m?.role)) throw new AiError(`不支持的 message role：${m?.role}`)
    if (typeof m.content !== 'string' || !m.content.trim()) throw new AiError('message content 不能为空')
  }

  const url = normalizeChatUrl(config.baseUrl)
  const temperature = Number.isFinite(config.temperature) ? Number(config.temperature) : 0.3
  const maxTokens = Number.isFinite(config.maxTokens) ? Math.trunc(Number(config.maxTokens)) : 2048
  if (temperature < 0 || temperature > 2) throw new AiError('temperature 应在 0–2')
  if (maxTokens < 1 || maxTokens > 32768) throw new AiError('maxTokens 应在 1–32768')

  const fetchImpl = options.fetchImpl || globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 60_000
  const headers = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`

  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new AiError(`AI 请求超时（${timeoutMs}ms）`, { cause: e })
    throw new AiError(`无法连接 AI 服务：${e?.message || e}`, { cause: e })
  }

  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      try {
        const j = JSON.parse(text)
        detail = j?.error?.message || j?.message || text
      } catch {
        detail = text
      }
    } catch {
      /* ignore */
    }
    throw new AiError(`AI 服务返回 ${res.status}${detail ? `：${String(detail).slice(0, 300)}` : ''}`, { status: res.status })
  }

  let data
  try {
    data = await res.json()
  } catch (e) {
    throw new AiError('AI 响应不是合法 JSON', { cause: e })
  }
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null
  const content = contentOf(choice?.message) || (typeof choice?.text === 'string' ? choice.text.trim() : '')
  if (!content) throw new AiError('AI 返回内容为空（可能被 max_tokens 截断）')
  return {
    content,
    usage: data?.usage ?? null,
    model: data?.model || config.model,
    finishReason: choice?.finish_reason ?? null,
  }
}

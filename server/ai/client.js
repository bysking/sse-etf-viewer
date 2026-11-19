// OpenAI-compatible Chat Completions 客户端，使用官方 openai npm 包。
// 兼容 OpenAI / DeepSeek / Moonshot / 通义 / Ollama 等 OpenAI-compatible 端点。
import OpenAI, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from 'openai'

export class AiError extends Error {
  constructor(message, { status = null, code = null, cause = null, retryable = false } = {}) {
    super(message)
    this.name = 'AiError'
    this.status = status
    this.code = code
    this.retryable = retryable
    this.cause = cause
  }
}

const trimSlash = (s) => s.replace(/\/+$/, '')

/**
 * 规范 baseURL：openai SDK 会自己在末尾拼 /chat/completions，
 * 所以这里只保留到 /v1（或用户自定义的前缀）。
 */
export function normalizeBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') throw new AiError('未配置 AI baseUrl')
  let url
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new AiError('AI baseUrl 不是合法 URL')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AiError('AI baseUrl 仅支持 http / https')
  let path = trimSlash(url.pathname)
  // 用户误填了完整端点时去掉后缀，避免 SDK 再拼一次
  path = path.replace(/\/chat\/completions$/, '')
  if (url.hostname === 'api.openai.com' && !path.startsWith('/v1')) path = '/v1' + path
  url.pathname = path
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
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

/** SDK 的超时既可能是 APIUserAbortError，也可能是 APIConnectionError("Request timed out.") */
function isTimeoutLike(e) {
  if (e instanceof APIUserAbortError) return true
  const name = e?.cause?.name || e?.name
  if (name === 'AbortError' || name === 'TimeoutError') return true
  return /timed?\s*out/i.test(String(e?.message || ''))
}

function toAiError(e, timeoutMs) {
  if (e instanceof AiError) return e
  if (isTimeoutLike(e)) return new AiError(`AI 请求超时（${timeoutMs}ms）`, { code: 'timeout', retryable: true, cause: e })
  if (e instanceof APIConnectionError) return new AiError(`无法连接 AI 服务：${e.message}`, { code: 'connection', retryable: true, cause: e })
  if (e instanceof AuthenticationError) return new AiError('AI 鉴权失败：API Key 无效或无权限', { status: e.status, code: 'auth', cause: e })
  if (e instanceof PermissionDeniedError) return new AiError(`AI 拒绝访问：${e.message}`, { status: e.status, code: 'permission', cause: e })
  if (e instanceof NotFoundError) return new AiError(`AI 端点或模型不存在：${e.message}`, { status: e.status, code: 'not_found', cause: e })
  if (e instanceof RateLimitError) return new AiError('AI 服务限流，请稍后重试', { status: e.status, code: 'rate_limit', retryable: true, cause: e })
  if (e instanceof BadRequestError) return new AiError(`AI 请求被拒绝：${e.message}`, { status: e.status, code: 'bad_request', cause: e })
  if (e instanceof APIError) {
    const retryable = typeof e.status === 'number' && (e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500)
    return new AiError(`AI 服务返回 ${e.status ?? '错误'}：${e.message}`, { status: e.status ?? null, code: 'api', retryable, cause: e })
  }
  return new AiError(`AI 调用失败：${e?.message || e}`, { cause: e })
}

/**
 * @param {object} config { baseUrl, apiKey, model, temperature, maxTokens }
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} options { client, timeoutMs }
 * @returns {Promise<{content:string, usage:object|null, model:string, finishReason:string|null}>}
 */
export async function chatCompletion(config, messages, options = {}) {
  if (!config || !config.model) throw new AiError('未配置 AI 模型')
  if (!Array.isArray(messages) || !messages.length) throw new AiError('messages 不能为空')
  for (const m of messages) {
    if (!['system', 'user', 'assistant'].includes(m?.role)) throw new AiError(`不支持的 message role：${m?.role}`)
    if (typeof m.content !== 'string' || !m.content.trim()) throw new AiError('message content 不能为空')
  }

  const baseURL = normalizeBaseUrl(config.baseUrl)
  const temperature = Number.isFinite(config.temperature) ? Number(config.temperature) : 0.3
  const maxTokens = Number.isFinite(config.maxTokens) ? Math.trunc(Number(config.maxTokens)) : 2048
  if (temperature < 0 || temperature > 2) throw new AiError('temperature 应在 0–2')
  if (maxTokens < 1 || maxTokens > 32768) throw new AiError('maxTokens 应在 1–32768')

  const timeoutMs = options.timeoutMs ?? 60_000
  let client = options.client
  if (!client) {
    try {
      client = new OpenAI({
        // 本地 Ollama / vLLM 等允许空 Key；SDK 不接受 undefined，用占位符
        apiKey: config.apiKey || 'not-needed',
        baseURL,
        timeout: timeoutMs,
        maxRetries: 0, // 重试由本层控制，避免放大等待时间
      })
    } catch (e) {
      throw toAiError(e, timeoutMs)
    }
  }

  let res
  try {
    res = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      },
      { timeout: timeoutMs },
    )
  } catch (e) {
    throw toAiError(e, timeoutMs)
  }

  const choice = Array.isArray(res?.choices) ? res.choices[0] : null
  const content = contentOf(choice?.message) || (typeof choice?.text === 'string' ? choice.text.trim() : '')
  if (!content) throw new AiError('AI 返回内容为空（可能被 max_tokens 截断）', { code: 'empty', retryable: false })
  return {
    content,
    usage: res?.usage ?? null,
    model: res?.model || config.model,
    finishReason: choice?.finish_reason ?? null,
  }
}

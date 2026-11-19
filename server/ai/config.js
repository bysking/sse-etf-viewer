// AI 模型配置：存服务端 SQLite；API 只返回脱敏信息。
// apiKey 落库前用 APP_SECRET_KEY 加密；未配置密钥时降级明文（启动时有告警）。
import { getSetting, setSetting } from '../store/repositories.js'
import { encrypt, decrypt } from '../store/crypto.js'

const KEY = 'ai_config'

const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function normalizeConfig(input = {}, existing = null) {
  const base = existing || {}
  const baseUrl = String(input.baseUrl ?? base.baseUrl ?? '').trim()
  const model = String(input.model ?? base.model ?? '').trim()
  let apiKey = base.apiKey ?? ''
  if (input.apiKey !== undefined) apiKey = String(input.apiKey ?? '')

  let parsed = null
  if (baseUrl) {
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new Error('baseUrl 不是合法 URL')
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('baseUrl 仅支持 http / https')
  }
  if (baseUrl && !model) throw new Error('model 不能为空')
  if (model.length > 200) throw new Error('model 过长')
  if (apiKey.length > 500) throw new Error('apiKey 过长')

  const temperature = num(input.temperature ?? base.temperature, 0.3)
  const maxTokens = Math.trunc(num(input.maxTokens ?? base.maxTokens, 2048))
  if (temperature < 0 || temperature > 2) throw new Error('temperature 应在 0–2')
  if (maxTokens < 1 || maxTokens > 32768) throw new Error('maxTokens 应在 1–32768')

  return { baseUrl, model, apiKey, temperature, maxTokens }
}

function envConfig() {
  const baseUrl = String(process.env.AI_BASE_URL || '').trim()
  const model = String(process.env.AI_MODEL || '').trim()
  if (!baseUrl || !model) return null
  return {
    baseUrl,
    model,
    apiKey: String(process.env.AI_API_KEY || process.env.OPENAI_API_KEY || ''),
    temperature: num(process.env.AI_TEMPERATURE, 0.3),
    maxTokens: Math.trunc(num(process.env.AI_MAX_TOKENS, 2048)),
  }
}

function keyTail(key) {
  if (!key) return ''
  return key.length <= 4 ? '****' : '…' + key.slice(-4)
}

/** 有效配置：优先数据库，其次环境变量 */
export function getEffectiveAiConfig() {
  const saved = getSetting(KEY, null)
  const db =
    saved && saved.baseUrl && saved.model
      ? { ...saved, apiKey: decrypt(saved.apiKey), source: 'db' }
      : null
  if (db) return db
  const env = envConfig()
  return env ? { ...env, source: 'env' } : null
}

/** 给前端的脱敏视图 */
export function publicAiConfig() {
  const cfg = getEffectiveAiConfig()
  if (!cfg) {
    return {
      configured: false,
      source: 'none',
      baseUrl: '',
      model: '',
      temperature: 0.3,
      maxTokens: 2048,
      apiKeySet: false,
      apiKeyTail: '',
    }
  }
  return {
    configured: true,
    source: cfg.source,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    apiKeySet: Boolean(cfg.apiKey),
    apiKeyTail: keyTail(cfg.apiKey),
  }
}

/** 保存配置；apiKey 未提供时保留旧值，空字符串表示清除 */
export function saveAiConfig(input = {}) {
  // 如果还没有数据库配置，但环境变量里有密钥，保存时一并带上，避免覆盖后丢失 key
  const raw = getSetting(KEY, null)
  const existing = raw ? { ...raw, apiKey: decrypt(raw.apiKey) } : getEffectiveAiConfig()
  const next = normalizeConfig(input, existing)
  // 落库前加密（未配置密钥时 encrypt 返回 null，退回明文并已在启动日志告警）
  const stored = { ...next, apiKey: encrypt(next.apiKey) ?? next.apiKey }
  setSetting(KEY, stored)
  return publicAiConfig()
}

/** 测试连接时可以用表单里的临时配置，不必先保存 */
export function resolveAiConfigForTest(input = {}) {
  const existing = getEffectiveAiConfig()
  const merged = normalizeConfig(input, existing)
  // 表单里的 apiKey 留空时沿用已有密钥
  if (input.apiKey === undefined || input.apiKey === '') merged.apiKey = existing?.apiKey || merged.apiKey
  return merged
}

export function assertConfigured(cfg) {
  if (!cfg || !cfg.baseUrl || !cfg.model) throw new Error('请先在 AI 助手中配置模型 API（baseUrl / model）')
  return cfg
}

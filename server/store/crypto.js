// 敏感字段加密：用 APP_SECRET_KEY 派生的 AES-256-GCM 密钥加密后再落库。
// 未配置 APP_SECRET_KEY 时降级为明文并在启动时告警——不静默假装安全。
import crypto from 'node:crypto'

const PREFIX = 'enc:v1:'
const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

let warned = false

/** 是否配置了加密密钥 */
export function hasEncryptionKey() {
  return Boolean(process.env.APP_SECRET_KEY && process.env.APP_SECRET_KEY.length >= 8)
}

function derivedKey() {
  // 用固定盐做 scrypt，避免同一口令在不同机器上派生出相同 key 的风险可控
  const secret = process.env.APP_SECRET_KEY
  return crypto.scryptSync(secret, 'sse-etf-viewer/settings', 32)
}

/** 加密；未配置密钥时返回 null，由调用方决定是否明文存储 */
export function encrypt(plain) {
  if (plain == null || plain === '') return null
  if (!hasEncryptionKey()) return null
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, derivedKey(), iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64')
}

/** 解密；兼容历史明文（原样返回）与无密钥场景 */
export function decrypt(stored) {
  if (stored == null || stored === '') return ''
  const s = String(stored)
  if (!s.startsWith(PREFIX)) return s // 历史明文
  if (!hasEncryptionKey()) {
    if (!warned) {
      warned = true
      console.warn('[security] 数据库中存在加密字段，但未配置 APP_SECRET_KEY，无法解密')
    }
    return ''
  }
  try {
    const buf = Buffer.from(s.slice(PREFIX.length), 'base64')
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const data = buf.subarray(IV_LEN + TAG_LEN)
    const decipher = crypto.createDecipheriv(ALGO, derivedKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch (e) {
    console.warn(`[security] 解密失败（密钥可能已更换）：${e.message}`)
    return ''
  }
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** 启动时调用一次，把安全状态打到日志 */
export function reportSecurityStatus(logger = console) {
  if (hasEncryptionKey()) {
    logger.log('[security] APP_SECRET_KEY 已配置，敏感字段将加密存储')
  } else {
    logger.warn(
      '[security] 未配置 APP_SECRET_KEY：AI API Key 等敏感字段将以明文存储在 data/app.db。' +
        '生产环境请设置 APP_SECRET_KEY（≥8 字符）。',
    )
  }
  if (!process.env.APP_AUTH_TOKEN) {
    logger.warn('[security] 未配置 APP_AUTH_TOKEN：接口无鉴权，仅应绑定 127.0.0.1 运行')
  }
}

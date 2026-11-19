// 可选 token 鉴权：配置 APP_AUTH_TOKEN 后，除白名单外的接口都需要凭据。
// 未配置时不做任何校验——此时只应绑定 127.0.0.1（启动日志会告警）。
import crypto from 'node:crypto'

// 不需要鉴权的路径：健康检查与静态资源（静态资源由 prod.js 处理，不会进这里）
const WHITELIST = new Set(['/api/health'])

export function authToken() {
  const t = process.env.APP_AUTH_TOKEN
  return t && t.length >= 8 ? t : null
}

export function isAuthEnabled() {
  return authToken() !== null
}

/** 常量时间比较，避免时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8')
  const bb = Buffer.from(String(b ?? ''), 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function extractToken(req) {
  const auth = req.headers.authorization
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    if (m) return m[1].trim()
  }
  const header = req.headers['x-auth-token']
  if (typeof header === 'string' && header) return header.trim()
  // 支持 ?token= 便于浏览器直接打开链接（注意：会出现在访问日志里）
  try {
    const u = new URL(req.url, 'http://localhost')
    const q = u.searchParams.get('token')
    if (q) return q
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 返回鉴权中间件；未配置 token 时返回 null，调用方跳过挂载。
 */
export function createAuthMiddleware() {
  const expected = authToken()
  if (!expected) return null
  return (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (WHITELIST.has(url.pathname)) return true
    const provided = extractToken(req)
    if (provided && safeEqual(provided, expected)) return true
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('WWW-Authenticate', 'Bearer realm="sse-etf-viewer"')
    res.end(JSON.stringify({ error: '需要访问令牌：请在 Authorization 头中提供 Bearer token' }))
    return false
  }
}
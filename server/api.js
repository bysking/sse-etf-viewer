// connect 风格中间件：Vite dev / preview 与生产服务器共用
import { getIndex, getShares, search } from './sse.js'

class BadRequest extends Error {}

const need = (v, msg) => {
  if (!v) throw new BadRequest(msg)
  return v
}
const isoDate = (s, name) => {
  need(/^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s)), `参数 ${name} 应为 YYYY-MM-DD`)
  return s
}

export function apiMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next()

    const q = Object.fromEntries(url.searchParams)
    const send = (status, obj) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(obj))
    }

    try {
      switch (url.pathname) {
        case '/api/health':
          return send(200, { ok: true })
        case '/api/search':
          return send(200, await search(q.q || ''))
        case '/api/shares': {
          const code = need(/^\d{6}$/.test((q.code || '').trim()) && q.code.trim(), 'ETF 代码应为 6 位数字')
          return send(200, await getShares(code, isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        }
        case '/api/index':
          return send(200, await getIndex(q.code || '000001', isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        default:
          return send(404, { error: 'not found' })
      }
    } catch (e) {
      send(e instanceof BadRequest ? 400 : 502, { error: e.message })
    }
  }
}

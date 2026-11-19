// 生产服务器：托管 dist/ 静态文件 + /api/*（先 npm run build，再 npm start）
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiMiddleware } from './api.js'

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const PORT = Number(process.env.PORT) || 8765
const HOST = process.env.HOST || '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

const api = apiMiddleware()

const server = http.createServer((req, res) =>
  api(req, res, async () => {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      return res.end('还没有构建前端，请先运行：npm run build')
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    let file = path.join(DIST, pathname === '/' ? 'index.html' : pathname)
    if (!file.startsWith(DIST)) {
      res.statusCode = 403
      return res.end('forbidden')
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
    if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    fs.createReadStream(file).pipe(res)
  }),
)

// 收盘后监控调度：默认在启动时开启，可用 ENABLE_MONITOR=0 关闭。
// 开发环境（vite dev）不加载本文件，因此不会误触发调度。
const ENABLE_MONITOR = process.env.ENABLE_MONITOR !== '0'

server.listen(PORT, HOST, async () => {
  console.log(`已启动：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  const { reportSecurityStatus } = await import('./store/crypto.js')
  reportSecurityStatus()
  // 绑定到非本机地址却没开鉴权，属于高危配置，单独强调
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !process.env.APP_AUTH_TOKEN) {
    console.warn('[security] 正在监听外部地址但未设置 APP_AUTH_TOKEN：任何能访问该端口的人都可以调用接口。')
  }
  if (ENABLE_MONITOR) {
    const { startScheduler } = await import('./monitor/scheduler.js')
    startScheduler()
  } else {
    console.log('监控调度已关闭（ENABLE_MONITOR=0），仅支持手动检查')
  }
})

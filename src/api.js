// 调用同源后端 /api/*（开发时由 Vite 中间件提供，生产时由 server/prod.js 提供）
export async function api(path, params = {}) {
  const u = new URL(path, location.origin)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  let r
  try {
    r = await fetch(u)
  } catch {
    throw new Error('无法连接后端服务，请确认已通过 npm run dev 或 npm start 启动')
  }
  const j = await r.json().catch(() => ({ error: '响应无法解析' }))
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status)
  return j
}

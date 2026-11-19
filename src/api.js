// 调用同源后端 /api/*（开发时由 Vite 中间件提供，生产时由 server/prod.js 提供）
// 支持可选的访问令牌：配置 APP_AUTH_TOKEN 后，前端用 localStorage 保存并随请求发送。
const TOKEN_KEY = 'sse-etf-auth-token'

export function getAuthToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 隐私模式等场景写入失败，忽略 */
  }
}

let authPromptShown = false

/** 401 时提示一次，避免每个请求都弹窗 */
function promptForToken() {
  if (authPromptShown) return
  authPromptShown = true
  const input = window.prompt('该服务已启用访问令牌，请输入 APP_AUTH_TOKEN：')
  if (input) {
    setAuthToken(input.trim())
    location.reload()
  }
}

async function request(u, init = {}) {
  const token = getAuthToken()
  const headers = { ...(init.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  let r
  try {
    r = await fetch(u, { ...init, headers })
  } catch {
    throw new Error('无法连接后端服务，请确认已通过 npm run dev 或 npm start 启动')
  }
  if (r.status === 401) {
    promptForToken()
    throw new Error('需要访问令牌（401）')
  }
  const j = await r.json().catch(() => ({ error: '响应无法解析' }))
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status)
  return j
}

export async function api(path, params = {}) {
  const u = new URL(path, location.origin)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return request(u)
}

export async function postApi(path, body = {}) {
  return request(new URL(path, location.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function putApi(path, body = {}) {
  return request(new URL(path, location.origin), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** DELETE 请求 */
export async function deleteApi(path) {
  return request(new URL(path, location.origin), { method: 'DELETE' })
}

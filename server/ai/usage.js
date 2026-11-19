// AI 调用用量记录：成功与失败都记，便于估算成本与排查。
import { recordAiUsage } from '../store/repositories.js'

/**
 * 包一层调用，自动记录用量。失败也记一条（ok=0, error）。
 * @param {object} p
 * @param {string} p.kind analyze | strategy | chat | test
 * @param {string} [p.symbol]
 * @param {string} [p.model]
 * @param {() => Promise<{usage:object|null, model:string}>} p.run
 */
export async function withUsage({ kind, symbol = null, model = null, run }) {
  try {
    const res = await run()
    try {
      recordAiUsage({ kind, model: res?.model || model, usage: res?.usage ?? null, symbol, ok: true })
    } catch {
      // 记录失败不应影响主流程
    }
    return res
  } catch (e) {
    try {
      recordAiUsage({ kind, model, usage: null, symbol, ok: false, error: String(e?.message || e).slice(0, 300) })
    } catch {
      // 同上
    }
    throw e
  }
}

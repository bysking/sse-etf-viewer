// 极简进程内异步任务队列：回测冷启动可能较慢，用 setImmediate 避免阻塞 API。
const running = new Set()

export function startJob(id, fn) {
  if (running.has(id)) return false
  running.add(id)
  setImmediate(async () => {
    try {
      await fn()
    } catch (e) {
      console.error(`[job ${id}]`, e)
    } finally {
      running.delete(id)
    }
  })
  return true
}

export function isRunning(id) {
  return running.has(id)
}

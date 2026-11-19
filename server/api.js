// connect 风格中间件：Vite dev / preview 与生产服务器共用
import { getIndex, getShares, search, todayCST, addDays } from './sse.js'
import { getKline } from './data/kline.js'
import { getSnap } from './data/snap.js'
import { getCalendar } from './data/calendar.js'
import { validateConfig } from '../shared/wyckoff/config.js'
import { validateStrategyConfig, PHASES } from '../shared/strategy/validate.js'
import { analyzeWyckoff, seriesToBars } from '../shared/wyckoff/analyzer.js'
import { eventStudy } from '../shared/wyckoff/eventStudy.js'
import * as repo from './store/repositories.js'
import { executeBacktest } from './backtest/service.js'
import { startJob } from './jobs/queue.js'
import { publicAiConfig, saveAiConfig, getEffectiveAiConfig, resolveAiConfigForTest } from './ai/config.js'
import { analyzeMarket, generateStrategy, chatWithContext, testAiConnection } from './ai/service.js'
import { AiError } from './ai/client.js'

class BadRequest extends Error {}
class NotFound extends Error {}

const need = (v, msg) => {
  if (!v) throw new BadRequest(msg)
  return v
}
const isoDate = (s, name) => {
  need(/^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s)), `参数 ${name} 应为 YYYY-MM-DD`)
  return s
}
const isCode = (v) => /^\d{6}$/.test(String(v || '').trim())
const bad = (msg) => new BadRequest(msg)

function readJson(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        tooLarge = true
        reject(new BadRequest('请求体过大'))
        req.resume()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new BadRequest('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function checkStrategyConfig(config) {
  need(config && typeof config === 'object' && !Array.isArray(config), 'config 必须是对象')
  need(isCode(config.symbol), '策略 config.symbol 应为 6 位代码')
  const errors = validateStrategyConfig(config)
  if (errors.length) throw new BadRequest(errors.join('；'))
  return config
}

function authoringSchema() {
  return {
    engine: 'wyckoff-v1',
    events: ['SC', 'BC', 'AR', 'ST', 'Spring', 'Test', 'UTAD', 'SOS', 'SOW', 'LPS', 'LPSY'],
    phases: PHASES,
    conditionTypes: [
      '{"event":"Spring","withinBars":5,"require":{"closeBackInRange":true}}',
      '{"phase":{"in":["accumulation_C","accumulation_D"],"minConfidence":0.5}}',
      '{"weekly":{"phaseIn":["accumulation","markup"],"closeAboveMa":true}}',
      '{"shareFlow":{"cumulativeDays":3,"gt":0,"requireFresh":true}}',
      '{"filter":{"fn":"closeAbove","value":true}}',
      '{"all":[...]} / {"any":[...]} / {"not":{...}}',
      '{"stopLoss":{"reference":"eventLow","event":"Spring","bufferAtr":0.5}}',
      '{"stopLoss":{"reference":"rangeLow","bufferAtr":0.5}}',
    ],
    execution: {
      fillAt: 'nextOpen',
      tPlus1: true,
      position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1 },
      feeRate: 0.0003,
      minFee: 5,
      slippageBps: 2,
      lotSize: 100,
      cancelIfInvalidated: true,
    },
    constraints: [
      '只做多，不允许做空',
      'riskBased 仓位必须包含 stopLoss',
      'fillAt 只能是 nextOpen',
      '不支持 takeProfit / trailingStop',
      '不要使用未列出的字段或指标',
      'AI 生成策略只能作为 draft，必须通过校验、回测和人工审核',
    ],
    example: {
      schemaVersion: 1,
      engine: 'wyckoff-v1',
      name: 'Spring 吸筹反转',
      symbol: '510300',
      entry: {
        all: [
          { event: 'Spring', withinBars: 5, require: { closeBackInRange: true } },
          { phase: { in: ['accumulation_C', 'accumulation_D'], minConfidence: 0.5 } },
        ],
      },
      exit: {
        any: [
          { event: 'SOS', withinBars: 4 },
          { stopLoss: { reference: 'eventLow', event: 'Spring', bufferAtr: 0.5 } },
        ],
      },
      execution: {
        fillAt: 'nextOpen',
        tPlus1: true,
        position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1 },
        feeRate: 0.0003,
        minFee: 5,
        slippageBps: 2,
        lotSize: 100,
        cancelIfInvalidated: true,
      },
    },
  }
}

function aiRequestBase(body) {
  const code = need(isCode(body.code) && String(body.code).trim(), '标的代码应为 6 位数字')
  const end = isoDate(body.end || todayCST(), 'end')
  const start = isoDate(body.start || addDays(end, -365), 'start')
  if (start > end) throw bad('开始日期不能晚于结束日期')
  return { code, start, end, includeShares: Boolean(body.includeShares) }
}

function summaryOf(analysis) {
  const counts = {}
  for (const e of analysis.events) counts[e.type] = (counts[e.type] || 0) + 1
  return { counts, eventCount: analysis.events.length, rangeCount: analysis.ranges.length }
}

export function apiMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next()

    const q = Object.fromEntries(url.searchParams)
    const method = (req.method || 'GET').toUpperCase()
    const send = (status, obj) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(obj))
    }

    try {
      // ---------------- 动态路由 ----------------
      if (url.pathname === '/api/strategies') {
        if (method === 'GET') return send(200, { items: repo.listStrategies() })
        if (method === 'POST') {
          const body = await readJson(req)
          need(String(body.name || '').trim(), '策略名称必填')
          const config = checkStrategyConfig(body.config)
          const created = repo.createStrategy({
            name: String(body.name).trim(),
            config,
            engineVersion: body.engineVersion || 'wyckoff-v1',
            enabled: body.enabled !== false,
          })
          return send(201, created)
        }
        throw bad('不支持的请求方法')
      }

      const backtestsMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/backtests$/)
      if (backtestsMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const strategy = repo.getStrategy(backtestsMatch[1])
        if (!strategy) throw new NotFound('策略不存在')
        const body = await readJson(req)
        const end = isoDate(body.end || todayCST(), 'end')
        const start = isoDate(body.start || addDays(end, -365), 'start')
        if (start > end) throw bad('开始日期不能晚于结束日期')
        const initialCash = body.initialCash == null ? strategy.config.initialCash ?? 100000 : Number(body.initialCash)
        if (!Number.isFinite(initialCash) || initialCash <= 0) throw bad('initialCash 必须是正数')
        const configSnapshot = { ...strategy.config, initialCash }
        const run = repo.createRun({
          strategyId: strategy.id,
          configSnapshot,
          engineVersion: strategy.engineVersion,
          symbol: strategy.config.symbol,
          start,
          end,
        })
        startJob(run.id, () => executeBacktest(run.id))
        return send(202, { id: run.id, status: run.status })
      }

      const strategyMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)$/)
      if (strategyMatch) {
        const id = strategyMatch[1]
        if (method === 'GET') {
          const s = repo.getStrategy(id)
          if (!s) throw new NotFound('策略不存在')
          return send(200, s)
        }
        if (method === 'PUT') {
          const body = await readJson(req)
          if (body.config != null) checkStrategyConfig(body.config)
          const updated = repo.updateStrategy(id, body)
          if (!updated) throw new NotFound('策略不存在')
          return send(200, updated)
        }
        if (method === 'DELETE') {
          if (!repo.deleteStrategy(id)) throw new NotFound('策略不存在')
          return send(200, { ok: true })
        }
        throw bad('不支持的请求方法')
      }

      const runsMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/runs$/)
      if (runsMatch) {
        if (method !== 'GET') throw bad('不支持的请求方法')
        return send(200, { items: repo.listRuns(runsMatch[1]) })
      }

      const signalsMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/signals$/)
      if (signalsMatch) {
        if (method !== 'GET') throw bad('不支持的请求方法')
        const limit = Math.max(1, Math.min(500, Number(q.limit) || 100))
        return send(200, { items: repo.listSignals(signalsMatch[1], limit) })
      }

      if (url.pathname === '/api/backtests/quick') {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const config = checkStrategyConfig(body.config)
        const end = isoDate(body.end || todayCST(), 'end')
        const start = isoDate(body.start || addDays(end, -365), 'start')
        if (start > end) throw bad('开始日期不能晚于结束日期')
        const initialCash = body.initialCash == null ? config.initialCash ?? 100000 : Number(body.initialCash)
        if (!Number.isFinite(initialCash) || initialCash <= 0) throw bad('initialCash 必须是正数')
        const run = repo.createRun({
          strategyId: 'quick',
          configSnapshot: { ...config, initialCash },
          engineVersion: 'wyckoff-v1',
          symbol: config.symbol,
          start,
          end,
        })
        startJob(run.id, () => executeBacktest(run.id))
        return send(202, { id: run.id, status: run.status })
      }

      const runMatch = url.pathname.match(/^\/api\/backtests\/([^/]+)$/)
      if (runMatch) {
        if (method !== 'GET') throw bad('不支持的请求方法')
        const run = repo.getRun(runMatch[1])
        if (!run) throw new NotFound('回测任务不存在')
        return send(200, run)
      }

      if (url.pathname === '/api/research/events') {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const code = need(isCode(body.code) && String(body.code).trim(), '标的代码应为 6 位数字')
        const end = isoDate(body.end || todayCST(), 'end')
        const start = isoDate(body.start || addDays(end, -365), 'start')
        if (start > end) throw bad('开始日期不能晚于结束日期')

        const cfg = body.config || {}
        const wyckoffCfg = cfg.wyckoff
          ? { ...cfg.wyckoff, context: cfg.context, shareFlow: cfg.shareFlow }
          : { ...(body.wyckoff || cfg), context: body.context ?? cfg.context, shareFlow: body.shareFlow ?? cfg.shareFlow }
        const errors = validateConfig(wyckoffCfg)
        if (errors.length) throw new BadRequest(errors.join('；'))

        const k = await getKline(code, start, end)
        const bars = seriesToBars(k.series)
        if (!bars.length) throw new NotFound('区间内没有日 K 数据')
        let shares = body.shares || null
        if (!shares && body.includeShares) {
          const s = await getShares(code, start, end)
          shares = s.series.filter(([, v]) => v != null)
        }
        const analysis = analyzeWyckoff(bars, wyckoffCfg, { shares })
        const study = eventStudy(bars, analysis.events)
        return send(200, {
          code,
          start,
          end,
          bars: k.series,
          summary: summaryOf(analysis),
          events: analysis.events,
          ranges: analysis.ranges,
          pivots: analysis.pivots,
          eventStudy: { horizons: study.horizons, summary: study.summary, rows: study.rows },
          states: analysis.states.map((s) => ({
            date: s.date,
            phase: s.phase,
            confidence: s.confidence,
            range: s.range,
            eventTypes: s.eventTypes,
            weekly: s.weekly,
            share: s.share,
          })),
          last: analysis.states[analysis.states.length - 1] || null,
        })
      }

      // ---------------- AI 助手 ----------------
      if (url.pathname === '/api/ai/config') {
        if (method === 'GET') return send(200, publicAiConfig())
        if (method === 'PUT') {
          const body = await readJson(req)
          try {
            return send(200, saveAiConfig(body))
          } catch (e) {
            throw new BadRequest(e.message)
          }
        }
        throw bad('不支持的请求方法')
      }

      if (url.pathname === '/api/ai/test') {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const useForm = body && (body.baseUrl || body.model)
        let aiConfig
        try {
          aiConfig = useForm ? resolveAiConfigForTest(body) : getEffectiveAiConfig()
        } catch (e) {
          throw new BadRequest(e.message)
        }
        if (!aiConfig) throw new BadRequest('请先配置 AI 模型')
        const r = await testAiConnection({ aiConfig })
        return send(200, { ok: true, content: r.content, model: r.model })
      }

      if (url.pathname === '/api/ai/analyze') {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const aiConfig = getEffectiveAiConfig()
        if (!aiConfig) throw new BadRequest('请先配置 AI 模型')
        const base = aiRequestBase(body)
        const question = String(body.question || '').slice(0, 2000)
        return send(200, await analyzeMarket({ aiConfig, ...base, question }))
      }

      if (url.pathname === '/api/ai/strategy') {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const aiConfig = getEffectiveAiConfig()
        if (!aiConfig) throw new BadRequest('请先配置 AI 模型')
        const base = aiRequestBase(body)
        const instructions = String(body.instructions || '').slice(0, 2000)
        return send(200, await generateStrategy({ aiConfig, ...base, instructions }))
      }

      if (url.pathname === '/api/ai/chat') {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const aiConfig = getEffectiveAiConfig()
        if (!aiConfig) throw new BadRequest('请先配置 AI 模型')
        const messages = body.messages
        if (!Array.isArray(messages) || messages.length < 1 || messages.length > 30) throw bad('messages 必须是 1–30 条')
        for (const m of messages) {
          if (!m || !['user', 'assistant'].includes(m.role)) throw bad('messages 仅支持 user / assistant')
          if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > 8000) throw bad('message content 必须是 1–8000 字符')
        }
        const contextText = typeof body.contextText === 'string' ? body.contextText.slice(0, 20000) : ''
        return send(200, await chatWithContext({ aiConfig, messages, contextText }))
      }

      // ---------------- 固定路由 ----------------
      switch (url.pathname) {
        case '/api/health':
          return send(200, { ok: true })
        case '/api/strategy-authoring/schema':
          return send(200, authoringSchema())
        case '/api/search':
          return send(200, await search(q.q || ''))
        case '/api/shares': {
          const code = need(isCode(q.code) && q.code.trim(), 'ETF 代码应为 6 位数字')
          return send(200, await getShares(code, isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        }
        case '/api/index':
          return send(200, await getIndex(q.code || '000001', isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        case '/api/kline': {
          const code = need(isCode(q.code) && q.code.trim(), '标的代码应为 6 位数字')
          return send(200, await getKline(code, isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        }
        case '/api/snap': {
          const code = need(isCode(q.code) && q.code.trim(), '标的代码应为 6 位数字')
          return send(200, await getSnap(code))
        }
        case '/api/calendar':
          return send(200, await getCalendar(isoDate(q.start, 'start'), isoDate(q.end, 'end')))
        default:
          return send(404, { error: 'not found' })
      }
    } catch (e) {
      if (e instanceof NotFound) return send(404, { error: e.message })
      send(e instanceof BadRequest ? 400 : 502, { error: e.message })
    }
  }
}

// connect 风格中间件：Vite dev / preview 与生产服务器共用
import { getIndex, getShares, search, todayCST, addDays } from './sse.js'
import { getKline, applyAdjust } from './data/kline.js'
import { detectDividends } from './data/adjust.js'
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
import * as paper from './paper/service.js'
import * as confirmPaper from './paper/confirm.js'
import { executeCheck } from './monitor/check.js'
import { runOnce, getSchedulerStatus } from './monitor/scheduler.js'
import * as notify from './notify/dispatch.js'
import { createAuthMiddleware } from './auth.js'

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
  const auth = createAuthMiddleware()
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next()
    // 配置了 APP_AUTH_TOKEN 时所有 API（除 health）都要求凭据
    if (auth && !auth(req, res)) return

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

      const versionsMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/versions$/)
      if (versionsMatch) {
        const strategyId = versionsMatch[1]
        const strategy = repo.getStrategy(strategyId)
        if (!strategy) throw new NotFound('策略不存在')
        if (method === 'GET') return send(200, { items: repo.listStrategyVersions(strategyId) })
        if (method === 'POST') {
          const body = await readJson(req)
          const config = checkStrategyConfig(body.config ?? strategy.config)
          const version = repo.createStrategyVersion({
            strategyId,
            kind: body.kind || 'dsl',
            config,
            code: body.code ?? null,
            manifest: body.manifest ?? null,
            engineVersion: body.engineVersion || strategy.engineVersion,
            provenance: body.provenance ?? null,
          })
          return send(201, version)
        }
        throw bad('不支持的请求方法')
      }

      const versionMatch = url.pathname.match(/^\/api\/strategy-versions\/([^/]+)$/)
      if (versionMatch) {
        const id = versionMatch[1]
        if (method === 'GET') {
          const v = repo.getStrategyVersion(id)
          if (!v) throw new NotFound('策略版本不存在')
          return send(200, v)
        }
        throw bad('不支持的请求方法')
      }

      const versionValidateMatch = url.pathname.match(/^\/api\/strategy-versions\/([^/]+)\/validate$/)
      if (versionValidateMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const v = repo.getStrategyVersion(versionValidateMatch[1])
        if (!v) throw new NotFound('策略版本不存在')
        const errors = validateStrategyConfig(v.config)
        const validation = { ok: errors.length === 0, errors, validatedAt: new Date().toISOString() }
        const updated = repo.setStrategyVersionStatus(v.id, errors.length ? 'draft' : 'validated', { validation })
        return send(200, updated)
      }

      const versionPromoteMatch = url.pathname.match(/^\/api\/strategy-versions\/([^/]+)\/promote$/)
      if (versionPromoteMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const v = repo.getStrategyVersion(versionPromoteMatch[1])
        if (!v) throw new NotFound('策略版本不存在')
        const errors = validateStrategyConfig(v.config)
        if (errors.length) throw new BadRequest(`策略校验未通过：${errors.join('；')}`)
        const body = await readJson(req)
        const target = body.status || 'active'
        if (!['validated', 'active', 'archived'].includes(target)) throw bad('status 仅支持 validated / active / archived')
        const updated = repo.setStrategyVersionStatus(v.id, target, { validation: { ok: true, errors: [] } })
        // active 版本同步到策略当前配置并启用，模拟盘/监控读取策略时才是最新逻辑
        if (target === 'active') repo.updateStrategy(v.strategyId, { config: v.config, enabled: true })
        if (target === 'archived') repo.updateStrategy(v.strategyId, { enabled: false })
        return send(200, updated)
      }

      const versionBacktestMatch = url.pathname.match(/^\/api\/strategy-versions\/([^/]+)\/backtests$/)
      if (versionBacktestMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const v = repo.getStrategyVersion(versionBacktestMatch[1])
        if (!v) throw new NotFound('策略版本不存在')
        const body = await readJson(req)
        const end = isoDate(body.end || todayCST(), 'end')
        const start = isoDate(body.start || addDays(end, -365), 'start')
        if (start > end) throw bad('开始日期不能晚于结束日期')
        const initialCash = body.initialCash == null ? v.config.initialCash ?? 100000 : Number(body.initialCash)
        if (!Number.isFinite(initialCash) || initialCash <= 0) throw bad('initialCash 必须是正数')
        const run = repo.createRun({
          strategyId: v.strategyId,
          configSnapshot: { ...v.config, initialCash },
          engineVersion: v.engineVersion,
          symbol: v.config.symbol,
          start,
          end,
        })
        startJob(run.id, () => executeBacktest(run.id))
        return send(202, { id: run.id, status: run.status, versionId: v.id, version: v.version })
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

      // ---------- 模拟盘 ----------
      const paperMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/paper$/)
      if (paperMatch) {
        if (method !== 'GET') throw bad('不支持的请求方法')
        const strategy = repo.getStrategy(paperMatch[1])
        if (!strategy) throw new NotFound('策略不存在')
        const ledgers = (q.ledger || 'rule,manual').split(',').filter((l) => paper.LEDGERS.includes(l))
        const end = isoDate(q.end || todayCST(), 'end')
        const start = isoDate(q.start || addDays(end, -120), 'start')
        const raw = await getKline(strategy.config.symbol, start, end)
        const k = applyAdjust(raw, repo.listDividends(strategy.config.symbol, { onlyConfirmed: true }))
        const bars = seriesToBars(k.series)
        return send(200, {
          strategyId: strategy.id,
          symbol: strategy.config.symbol,
          adjust: k.adjust,
          items: ledgers.map((ledger) => paper.getPaperSummary({ strategyId: strategy.id, ledger, bars })).filter(Boolean),
        })
      }

      const paperOrdersMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/paper\/orders$/)
      if (paperOrdersMatch) {
        if (method !== 'GET') throw bad('不支持的请求方法')
        return send(200, {
          items: paper.listOrders({
            strategyId: paperOrdersMatch[1],
            ledger: q.ledger || null,
            status: q.status || null,
            limit: Math.max(1, Math.min(500, Number(q.limit) || 100)),
          }),
        })
      }

      // 手动结算：用当前数据结算待成交订单（调度器每日也会自动做）
      const paperSettleMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/paper\/settle$/)
      if (paperSettleMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const strategy = repo.getStrategy(paperSettleMatch[1])
        if (!strategy) throw new NotFound('策略不存在')
        const body = await readJson(req)
        const end = isoDate(body.end || todayCST(), 'end')
        const start = isoDate(body.start || addDays(end, -420), 'start')
        const raw = await getKline(strategy.config.symbol, start, end)
        const k = applyAdjust(raw, repo.listDividends(strategy.config.symbol, { onlyConfirmed: true }))
        const bars = seriesToBars(k.series)
        const execution = { ...(strategy.config.execution || {}) }
        const out = {}
        for (const ledger of paper.LEDGERS) {
          if (!paper.getAccount(strategy.id, ledger)) continue
          out[ledger] = paper.settleOrders({ strategyId: strategy.id, symbol: strategy.config.symbol, ledger, bars, execution })
        }
        return send(200, { ok: true, result: out })
      }

      // ---------- 人工确认 ----------
      const confirmMatch = url.pathname.match(/^\/api\/signals\/([^/]+)\/confirm$/)
      if (confirmMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const r = confirmPaper.confirmSignal({ signalId: confirmMatch[1], strategyId: body.strategyId || null })
        return send(200, r)
      }

      const ignoreMatch = url.pathname.match(/^\/api\/signals\/([^/]+)\/ignore$/)
      if (ignoreMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const r = confirmPaper.ignoreSignal({ signalId: ignoreMatch[1], strategyId: body.strategyId || null })
        return send(200, r)
      }

      // ---------- 监控 ----------
      const checkMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)\/check$/)
      if (checkMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const strategy = repo.getStrategy(checkMatch[1])
        if (!strategy) throw new NotFound('策略不存在')
        const body = await readJson(req)
        const r = await executeCheck({
          strategy,
          date: isoDate(body.date || todayCST(), 'date'),
          force: true,
          notify: body.notify !== false,
        })
        return send(200, r)
      }

      if (url.pathname === '/api/monitor/status') {
        if (method !== 'GET') throw bad('不支持的请求方法')
        return send(200, getSchedulerStatus())
      }

      if (url.pathname === '/api/monitor/run') {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const body = await readJson(req)
        const summary = await runOnce({ force: Boolean(body.force) })
        return send(200, summary)
      }

      // ---------- 通知 ----------
      if (url.pathname === '/api/channels') {
        if (method === 'GET') return send(200, { items: notify.listChannels().map(notify.publicChannel) })
        if (method === 'POST') {
          const body = await readJson(req)
          const ch = notify.createChannel({ type: body.type, name: body.name, config: body.config, enabled: body.enabled !== false })
          return send(201, notify.publicChannel(ch))
        }
        throw bad('不支持的请求方法')
      }

      const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/)
      if (channelMatch) {
        const id = channelMatch[1]
        if (method === 'PUT') {
          const body = await readJson(req)
          const ch = notify.updateChannel(id, body)
          if (!ch) throw new NotFound('渠道不存在')
          return send(200, notify.publicChannel(ch))
        }
        if (method === 'DELETE') {
          if (!notify.deleteChannel(id)) throw new NotFound('渠道不存在')
          return send(200, { ok: true })
        }
        throw bad('不支持的请求方法')
      }

      const channelTestMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/test$/)
      if (channelTestMatch) {
        if (method !== 'POST') throw bad('不支持的请求方法')
        const ch = notify.getChannel(channelTestMatch[1])
        if (!ch) throw new NotFound('渠道不存在')
        const body = await readJson(req)
        const message = body.message || {
          level: 'candidate',
          title: '【测试】通知渠道连通性',
          markdown: `这是一条来自 ETF 策略系统的测试消息。\n时间：${new Date().toISOString()}`,
        }
        const r = await notify.sendToChannel(ch, message, { retries: 1 })
        if (!r.ok) throw new Error(r.error || '发送失败')
        return send(200, { ok: true, attempts: r.attempts })
      }

      if (url.pathname === '/api/notify-log') {
        if (method !== 'GET') throw bad('不支持的请求方法')
        return send(200, { items: notify.listNotifyLog(Math.max(1, Math.min(500, Number(q.limit) || 100))) })
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

        // 与研究页/回测保持同一口径：默认前复权
        const rawK = await getKline(code, start, end)
        const k = body.adjust === 'none' ? rawK : applyAdjust(rawK, repo.listDividends(code, { onlyConfirmed: true }))
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
          adjust: k.adjust,
          adjustmentCount: k.adjustmentCount ?? 0,
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

      if (url.pathname === '/api/ai/usage') {
        if (method !== 'GET') throw bad('不支持的请求方法')
        const days = Math.max(1, Math.min(365, Number(q.days) || 30))
        return send(200, repo.summarizeAiUsage({ days }))
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
        const result = await generateStrategy({ aiConfig, ...base, instructions })
        // 校验通过的 AI 策略立即落成 draft 版本，避免“页面刷新即丢失”，并保留模型来源
        let version = null
        if (result.strategyConfig && result.validation?.ok) {
          const name = String(result.strategyConfig.name || `${base.code} AI 策略`).slice(0, 80)
          const strategy = repo.createStrategy({ name, config: result.strategyConfig, engineVersion: 'wyckoff-v1', enabled: false })
          version = repo.createStrategyVersion({
            strategyId: strategy.id,
            kind: 'dsl',
            config: result.strategyConfig,
            manifest: {
              schemaVersion: result.strategyConfig.schemaVersion ?? 1,
              symbol: result.strategyConfig.symbol,
              data: {
                usesShares: Boolean(body.includeShares),
                usesWeekly: JSON.stringify(result.strategyConfig).includes('"weekly"'),
              },
            },
            provenance: {
              source: 'ai',
              model: result.model || aiConfig.model,
              prompt: instructions,
              code: String(base.code),
              range: { start: base.start, end: base.end },
              generatedAt: new Date().toISOString(),
            },
            validation: result.validation,
          })
        }
        return send(200, { ...result, draft: version ? { strategyId: version.strategyId, versionId: version.id, version: version.version } : null })
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
          const raw = await getKline(code, isoDate(q.start, 'start'), isoDate(q.end, 'end'))
          // 默认返回前复权口径（仅使用人工确认的除息事件）；adjust=none 取原始价格
          const wantQfq = q.adjust !== 'none'
          return send(200, wantQfq ? applyAdjust(raw, repo.listDividends(code, { onlyConfirmed: true })) : raw)
        }
        case '/api/dividends': {
          const code = need(isCode(q.code) && q.code.trim(), '标的代码应为 6 位数字')
          return send(200, { code, items: repo.listDividends(code) })
        }
        case '/api/dividends/confirm': {
          if (method !== 'POST') return send(405, { error: '不支持的请求方法' })
          const body = await readJson(req)
          need(body.id, 'id 必填')
          if (!repo.setDividendConfirmed(body.id, body.confirmed !== false)) throw new NotFound('除息记录不存在')
          return send(200, { ok: true })
        }
        case '/api/dividends/detect': {
          if (method !== 'POST') return send(405, { error: '不支持的请求方法' })
          const body = await readJson(req)
          const code = need(isCode(body.code) && String(body.code).trim(), '标的代码应为 6 位数字')
          const end = isoDate(body.end || todayCST(), 'end')
          const start = isoDate(body.start || addDays(end, -3650), 'start')
          const [etf, idx] = await Promise.all([getKline(code, start, end), getKline('000001', start, end)])
          const found = detectDividends(etf.series, idx.series, {
            minExtraGap: Number(body.minExtraGap) || 0.02,
            minGap: Number(body.minGap) || 0.02,
            maxPerYear: Number(body.maxPerYear) || 2,
          })
          const added = repo.upsertDividends(code, found, { source: 'auto' })
          return send(200, { code, detected: found, added, items: repo.listDividends(code) })
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
      // 服务层用 err.status 标记语义错误（如 404 信号不存在、400 跨策略操作），直接透传
      if (e?.status === 404) return send(404, { error: e.message })
      if (e?.status === 400) return send(400, { error: e.message })
      if (e instanceof BadRequest) return send(400, { error: e.message })
      // AI 上游错误带 status 时按上游语义返回，便于前端区分鉴权/限流
      if (e instanceof AiError && e.status) return send(502, { error: e.message, code: e.code })
      send(502, { error: e.message })
    }
  }
}

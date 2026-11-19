// AI 业务编排：取数 → 事件分析 → 上下文 → 调用模型 → 解析/校验策略。
import { getKline, applyAdjust, dataVersionOf } from '../data/kline.js'
import { getShares } from '../sse.js'
import { listDividends } from '../store/repositories.js'
import { seriesToBars, analyzeWyckoff } from '../../shared/wyckoff/analyzer.js'
import { eventStudy } from '../../shared/wyckoff/eventStudy.js'
import { validateStrategyConfig } from '../../shared/strategy/validate.js'
import { assertConfigured } from './config.js'
import { buildAnalysisMessages, buildStrategyMessages, buildChatMessages } from './prompts.js'
import { buildMarketContext } from './context.js'
import { chatCompletion } from './client.js'
import { withUsage } from './usage.js'

/** 取数并构建上下文（默认使用校准后的 Wyckoff 参数） */
export async function loadMarketContext({ code, start, end, includeShares = false }) {
  // 与回测/研究页同一口径：只使用人工确认的除息事件做前复权
  const raw = await getKline(code, start, end)
  const k = applyAdjust(raw, listDividends(code, { onlyConfirmed: true }))
  const bars = seriesToBars(k.series)
  if (!bars.length) throw new Error(`区间内没有 ${code} 的日 K 数据`)
  let shares = null
  if (includeShares) {
    const s = await getShares(code, start, end)
    shares = s.series.filter(([, v]) => v != null)
  }
  const analysis = analyzeWyckoff(bars, {}, { shares })
  const study = eventStudy(bars, analysis.events, { horizons: [10, 20] })
  const context = buildMarketContext({
    code,
    start,
    end,
    bars,
    analysis,
    study,
    adjust: k.adjust,
    dataVersion: dataVersionOf(k),
  })
  return { bars, analysis, study, context }
}

export async function analyzeMarket({ aiConfig, code, start, end, includeShares, question }) {
  assertConfigured(aiConfig)
  const { context } = await loadMarketContext({ code, start, end, includeShares })
  const messages = buildAnalysisMessages({ contextText: context.text, question })
  const res = await withUsage({
    kind: 'analyze',
    symbol: code,
    model: aiConfig.model,
    run: () => chatCompletion(aiConfig, messages),
  })
  return {
    content: res.content,
    contextSummary: context.summary,
    contextText: context.text,
    usage: res.usage,
    model: res.model,
  }
}

export async function generateStrategy({ aiConfig, code, start, end, includeShares, instructions }) {
  assertConfigured(aiConfig)
  const { context } = await loadMarketContext({ code, start, end, includeShares })
  const messages = buildStrategyMessages({ contextText: context.text, instructions })
  const res = await withUsage({
    kind: 'strategy',
    symbol: code,
    model: aiConfig.model,
    run: () => chatCompletion(aiConfig, messages),
  })
  const strategyConfig = extractStrategyJson(res.content)
  const errors = strategyConfig ? validateStrategyConfig(strategyConfig) : ['AI 未返回可解析的 JSON 策略配置']
  return {
    content: res.content,
    strategyConfig,
    validation: { ok: errors.length === 0, errors },
    contextSummary: context.summary,
    contextText: context.text,
    usage: res.usage,
    model: res.model,
  }
}

export async function chatWithContext({ aiConfig, messages, contextText }) {
  assertConfigured(aiConfig)
  const built = buildChatMessages({ messages, contextText })
  if (built.length <= 1) throw new Error('对话历史为空')
  const res = await withUsage({ kind: 'chat', model: aiConfig.model, run: () => chatCompletion(aiConfig, built) })
  return { content: res.content, usage: res.usage, model: res.model }
}

export async function testAiConnection({ aiConfig }) {
  assertConfigured(aiConfig)
  const res = await withUsage({
    kind: 'test',
    model: aiConfig.model,
    run: () =>
      chatCompletion({ ...aiConfig, maxTokens: 32 }, [{ role: 'user', content: '请只回复 OK' }], {
        timeoutMs: 30_000,
      }),
  })
  return { content: res.content, model: res.model }
}

/** 从 AI 输出中提取第一个可解析的 JSON 对象（优先 fenced json 代码块） */
export function extractStrategyJson(text) {
  if (!text || typeof text !== 'string') return null
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1])
  for (const candidate of [text, ...blocks]) {
    try {
      const j = JSON.parse(candidate.trim())
      if (j && typeof j === 'object' && !Array.isArray(j)) return j
    } catch {
      /* try next */
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(text.slice(start, end + 1))
      if (j && typeof j === 'object' && !Array.isArray(j)) return j
    } catch {
      return null
    }
  }
  return null
}

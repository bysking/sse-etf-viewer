import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractStrategyJson } from './service.js'
import { STRATEGY_SYSTEM, buildStrategyMessages } from './prompts.js'

const config = {
  symbol: '510300',
  entry: { all: [{ event: 'Spring', withinBars: 5 }] },
  exit: { any: [{ stopLoss: { reference: 'rangeLow', bufferAtr: 0.5 } }] },
}

test('extractStrategyJson 支持 fenced json 代码块', () => {
  const text = `说明文字\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`\n后记`
  assert.deepEqual(extractStrategyJson(text), config)
})

test('extractStrategyJson 支持裸 JSON 和前后夹带说明', () => {
  assert.deepEqual(extractStrategyJson(JSON.stringify(config)), config)
  assert.deepEqual(extractStrategyJson(`策略如下：${JSON.stringify(config)} 以上。`), config)
})

test('extractStrategyJson 对无效内容返回 null', () => {
  assert.equal(extractStrategyJson('这里没有 JSON'), null)
  assert.equal(extractStrategyJson('```json\n{broken}\n```'), null)
})

test('策略提示词包含 DSL 约束和事件名', () => {
  assert.match(STRATEGY_SYSTEM, /stopLoss/)
  assert.match(STRATEGY_SYSTEM, /nextOpen/)
  assert.match(STRATEGY_SYSTEM, /Spring/)
  assert.match(STRATEGY_SYSTEM, /不要输出 JS/)
  const msgs = buildStrategyMessages({ contextText: 'CTX', instructions: '做一个 Spring 策略' })
  assert.equal(msgs[0].role, 'system')
  assert.match(msgs[1].content, /CTX/)
  assert.match(msgs[1].content, /Spring/)
})

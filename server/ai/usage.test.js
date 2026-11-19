import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb } from '../store/db.js'
import * as repo from '../store/repositories.js'
import { withUsage } from './usage.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-usage-'))
process.env.DATA_DIR = dir

after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('成功调用记录 token 用量', async () => {
  const r = await withUsage({
    kind: 'analyze',
    symbol: '510300',
    model: 'mock-model',
    run: async () => ({ content: 'ok', usage: { prompt_tokens: 100, completion_tokens: 20 }, model: 'mock-model' }),
  })
  assert.equal(r.content, 'ok')

  const s = repo.summarizeAiUsage()
  assert.equal(s.totals.calls, 1)
  assert.equal(s.totals.failed, 0)
  assert.equal(s.totals.promptTokens, 100)
  assert.equal(s.totals.completionTokens, 20)
  assert.equal(s.totals.tokens, 120)
  assert.equal(s.byKind[0].kind, 'analyze')
})

test('失败调用也记录，并保留错误信息', async () => {
  await assert.rejects(
    withUsage({
      kind: 'chat',
      model: 'mock-model',
      run: async () => {
        throw new Error('upstream 500')
      },
    }),
    /upstream 500/,
  )
  const s = repo.summarizeAiUsage()
  const failed = s.recent.find((x) => x.ok === false)
  assert.ok(failed)
  assert.equal(failed.kind, 'chat')
  assert.match(failed.error, /upstream 500/)
})

test('汇总按类型与模型分组，且只统计时间窗内', async () => {
  const s = repo.summarizeAiUsage({ days: 1 })
  assert.equal(s.totals.calls, 2)
  assert.ok(s.byKind.some((k) => k.kind === 'analyze'))
  assert.ok(s.byKind.some((k) => k.kind === 'chat'))
  assert.ok(s.byModel.some((m) => m.model === 'mock-model'))
  assert.equal(s.recent.length, 2)
})

test('没有 usage 字段时仍记录调用（token 为空）', async () => {
  await withUsage({ kind: 'test', run: async () => ({ content: 'OK', usage: null, model: 'm' }) })
  const s = repo.summarizeAiUsage()
  const testRow = s.recent.find((x) => x.kind === 'test')
  assert.ok(testRow)
  assert.equal(testRow.totalTokens, null)
})

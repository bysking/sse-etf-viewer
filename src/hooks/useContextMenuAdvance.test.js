import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isContextMenuKey, matchesBinding, loadBinding, saveBinding, BINDING_KEY, DEFAULT_ADVANCE_KEYS } from './useContextMenuAdvance.js'

// 极简 localStorage 桩，用于验证键位持久化
function withLocalStorage(fn) {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  try {
    fn(store)
  } finally {
    delete globalThis.localStorage
  }
}

test('isContextMenuKey：识别标准菜单键', () => {
  assert.equal(isContextMenuKey({ key: 'ContextMenu' }), true)
  assert.equal(isContextMenuKey({ code: 'ContextMenu' }), true)
  assert.equal(isContextMenuKey({ keyCode: 93 }), true)
  assert.equal(isContextMenuKey({ key: 'Apps' }), true)
  assert.equal(isContextMenuKey(null), false)
})

test('isContextMenuKey：方向键 → 是默认推进键（用户实测的按键）', () => {
  // 用户日志原样：key="ArrowRight" code="ArrowRight" keyCode=39
  assert.equal(isContextMenuKey({ key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }), true)
  assert.equal(isContextMenuKey({ code: 'ArrowRight' }), true)
  assert.deepEqual(DEFAULT_ADVANCE_KEYS, ['ArrowRight'])
})

test('isContextMenuKey：方向键 ← ↑ ↓ 不应触发推进', () => {
  for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowDown']) {
    assert.equal(isContextMenuKey({ key: k, code: k, keyCode: 0 }), false, `${k} 不该推进`)
  }
})

test('isContextMenuKey：keyCode=0 但 key 正确时仍能识别（实测 Windows 键盘）', () => {
  // 实测：key='ContextMenu'、code='ContextMenu'、keyCode=0
  assert.equal(isContextMenuKey({ key: 'ContextMenu', code: 'ContextMenu', keyCode: 0 }), true)
})

test('isContextMenuKey：普通键不误判', () => {
  // 注意 ArrowRight 是默认推进键，不在这个列表里
  for (const k of ['a', 'Enter', ' ', 'Shift', 'ArrowLeft', 'Escape', 'Process', 'Tab']) {
    assert.equal(isContextMenuKey({ key: k, code: `Key${k.toUpperCase()}`, keyCode: 65 }), false, `${k} 不该被识别`)
  }
})

test('matchesBinding：key / code / keyCode 任一相同即命中', () => {
  const binding = { key: 'F2', code: 'F2', keyCode: 113 }
  assert.equal(matchesBinding({ key: 'F2', code: 'Other', keyCode: 0 }, binding), true)
  assert.equal(matchesBinding({ key: 'x', code: 'F2', keyCode: 0 }, binding), true)
  assert.equal(matchesBinding({ key: 'x', code: 'y', keyCode: 113 }, binding), true)
  assert.equal(matchesBinding({ key: 'x', code: 'y', keyCode: 1 }, binding), false)
  assert.equal(matchesBinding(null, binding), false)
  assert.equal(matchesBinding({ key: 'x' }, null), false)
})

test('matchesBinding：空字段不参与匹配，避免误命中', () => {
  assert.equal(matchesBinding({ key: '', code: '', keyCode: 0 }, { key: '', code: '', keyCode: 0 }), false)
})

test('自定义键位可持久化并读回', () => {
  withLocalStorage((store) => {
    assert.equal(loadBinding(), null)
    saveBinding({ key: 'F2', code: 'F2', keyCode: 113 })
    assert.ok(store.has(BINDING_KEY))
    assert.deepEqual(loadBinding(), { key: 'F2', code: 'F2', keyCode: 113 })
    saveBinding(null)
    assert.equal(loadBinding(), null)
  })
})

test('损坏的键位数据不会抛错', () => {
  withLocalStorage((store) => {
    store.set(BINDING_KEY, '{坏掉的 json')
    assert.equal(loadBinding(), null)
    store.set(BINDING_KEY, 'null')
    assert.equal(loadBinding(), null)
  })
})

// 「右键推进」：按下立即前进一根，按住超过 LONG_PRESS_MS 转为连发，松开即停。
//
// 为什么不依赖 keyup 才前进（实测踩坑）：
//   之前的设计是「keyup 时前进一根」，但部分 Windows 键盘/驱动在菜单键上不发送 keyup，
//   于是单击完全没反应。改成「keydown 立即前进一根」后，单击只依赖 keydown，稳得多。
//
// 触发源：
//   - 鼠标右键在训练图表区域按下（mousedown button===2）
//   - 键盘菜单键：key/code 为 ContextMenu / Apps，或 keyCode 93
//   - 自定义键位：用户在页面上录制一次，存 localStorage，之后按那个键也能推进
//
// 自定义键位是最后一道保险：不同键盘上报字段差异极大（实测有 key='ContextMenu' 但 keyCode=0，
// 也有只给 keyCode=93 的），白名单总有覆盖不到的情况，所以允许用户自己指定。
import { useCallback, useEffect, useRef } from 'react'

export const LONG_PRESS_MS = 400
export const REPEAT_INTERVAL_MS = 150
export const BINDING_KEY = 'sse-etf-training-advance-key'
/**
 * 连发安全上限：按住最多推进这么多根就自动停。
 * 防止某些键不发送 keyup 时一路冲到 K 线末尾，训练直接失去意义。
 * 到上限后必须松开再按才能继续。
 */
export const MAX_REPEAT_STEPS = 60

/**
 * 默认推进键：键盘方向键 →
 * （需求里的「按住键盘右键」指的就是这个，不是 ContextMenu 键）
 */
export const DEFAULT_ADVANCE_KEYS = ['ArrowRight']

/** 读取用户自定义键位（{key, code, keyCode} 或 null） */
export function loadBinding() {
  try {
    const j = JSON.parse(localStorage.getItem(BINDING_KEY) || 'null')
    if (j && (j.key || j.code || j.keyCode)) return j
  } catch {
    /* 忽略解析失败 */
  }
  return null
}

export function saveBinding(binding) {
  try {
    if (binding) localStorage.setItem(BINDING_KEY, JSON.stringify(binding))
    else localStorage.removeItem(BINDING_KEY)
  } catch {
    /* 忽略写入失败 */
  }
}

/** 默认的「右键」判断：方向键 →（同时兼容菜单键，多认一个不会冲突） */
export function isContextMenuKey(e) {
  if (!e) return false
  // 方向键 →：需求里的「键盘右键」就是它
  if (e.key === 'ArrowRight' || e.code === 'ArrowRight') return true
  // 顺带兼容菜单键，习惯用菜单键的人也能推进
  if (e.key === 'ContextMenu' || e.code === 'ContextMenu') return true
  if (e.key === 'Apps' || e.code === 'Apps') return true
  if (e.keyCode === 93) return true
  return false
}

/** 自定义键位匹配：key 或 code 相同即命中，避免不同浏览器 keyCode 不一致 */
export function matchesBinding(e, binding) {
  if (!e || !binding) return false
  if (binding.key && e.key && e.key === binding.key) return true
  if (binding.code && e.code && e.code === binding.code) return true
  if (binding.keyCode && e.keyCode && e.keyCode === binding.keyCode) return true
  return false
}

/**
 * @param {object} p
 * @param {() => void} p.onStep 前进一根
 * @param {boolean} p.enabled 是否启用
 * @param {(holding:boolean)=>void} [p.onHoldingChange] 长按状态变化，用于 UI 提示
 * @param {React.RefObject<HTMLElement>} [p.targetRef] 限定鼠标右键生效区域
 * @param {object|null} [p.binding] 自定义键位
 */
export function useContextMenuAdvance({ onStep, enabled, onHoldingChange, targetRef, binding }) {
  const stepRef = useRef(onStep)
  const holdRef = useRef(onHoldingChange)
  const timerRef = useRef(null)
  const repeatRef = useRef(null)
  const holdingRef = useRef(false)
  const sourceRef = useRef(null)
  const bindingRef = useRef(binding)
  // 本次按住已经推进了几根，用于安全上限
  const stepsRef = useRef(0)

  stepRef.current = onStep
  holdRef.current = onHoldingChange
  bindingRef.current = binding

  const stopTimers = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (repeatRef.current) {
      clearInterval(repeatRef.current)
      repeatRef.current = null
    }
  }, [])

  const release = useCallback(() => {
    if (!holdingRef.current) return
    holdingRef.current = false
    sourceRef.current = null
    stopTimers()
    holdRef.current?.(false)
  }, [stopTimers])

  // 按下：立即前进一根（不依赖 keyup），同时启动长按连发计时
  const pressStart = useCallback((source) => {
    if (holdingRef.current) return
    holdingRef.current = true
    sourceRef.current = source
    stepsRef.current = 0
    holdRef.current?.(true)
    stepRef.current?.()
    stepsRef.current = 1
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!holdingRef.current) return
      repeatRef.current = setInterval(() => {
        if (!holdingRef.current) return
        // 安全上限：防止不发 keyup 的键盘一路冲到末尾
        if (stepsRef.current >= MAX_REPEAT_STEPS) {
          release()
          return
        }
        stepsRef.current += 1
        stepRef.current?.()
      }, REPEAT_INTERVAL_MS)
    }, LONG_PRESS_MS)
  }, [release])

  // 抬起：只负责停止，不再补发一次（按下时已经前进过了）
  const pressEnd = useCallback(() => {
    release()
  }, [release])

  useEffect(() => {
    if (!enabled) {
      release()
      return
    }

    const inTarget = (node) => {
      const el = targetRef?.current
      if (!el) return true
      return Boolean(node && (el === node || el.contains(node)))
    }
    const hit = (e) => isContextMenuKey(e) || matchesBinding(e, bindingRef.current)

    /* ---------------- 键盘 ---------------- */
    const onKeyDown = (e) => {
      if (!hit(e)) return
      // 输入框里打字时不抢键（自定义键位可能是普通字母）。
      // 但方向键 → 是默认推进键，在输入框里也要让位给光标移动，所以这种情况直接忽略。
      const t = e.target
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (typing) return
      // 方向键默认会滚动页面，必须拦掉，否则每推进一根页面就跳一下
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return // 系统按键重复忽略，连发由定时器负责
      pressStart('key')
    }
    const onKeyUp = (e) => {
      if (!hit(e)) return
      if (sourceRef.current !== 'key') return
      e.preventDefault()
      e.stopPropagation()
      pressEnd()
    }

    /* ---------------- 鼠标 ---------------- */
    const onMouseDown = (e) => {
      if (e.button !== 2) return
      if (!inTarget(e.target)) return
      e.preventDefault()
      pressStart('mouse')
    }
    const onMouseUp = (e) => {
      if (e.button !== 2) return
      if (sourceRef.current !== 'mouse') return
      e.preventDefault()
      pressEnd()
    }
    // 训练中拦掉系统右键菜单，避免打断节奏
    const onContextMenu = (e) => {
      e.preventDefault()
    }
    // 兜底释放：失焦 / 鼠标离开窗口 / 松开任一处
    const onBlur = () => release()
    const onMouseLeave = () => {
      if (sourceRef.current === 'mouse') release()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('mouseup', onMouseUp, { capture: true })
    window.addEventListener('contextmenu', onContextMenu, { capture: true })
    window.addEventListener('blur', onBlur)
    document.addEventListener('mouseleave', onMouseLeave)

    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
      window.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('mouseup', onMouseUp, { capture: true })
      window.removeEventListener('contextmenu', onContextMenu, { capture: true })
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('mouseleave', onMouseLeave)
      release()
    }
  }, [enabled, pressStart, pressEnd, release, targetRef])

  useEffect(() => stopTimers, [stopTimers])
}

import React, { useEffect, useRef, useState } from 'react'
import { Button, Space, Tag, Typography, message } from 'antd'
import { CopyOutlined, DeleteOutlined, BugOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { isContextMenuKey, matchesBinding } from '../hooks/useContextMenuAdvance.js'

const { Text } = Typography

const MAX_ROWS = 30

/**
 * 键盘诊断：把每次按键的原始字段摊开，用来确认「右键 / 菜单键」在本机上报的是什么。
 *
 * 两个关键诊断点：
 *   1. 识别：keydown 是否被默认规则命中（false 说明键位不在白名单，需要自定义绑定）；
 *   2. 有 keydown 却没有对应 keyup：这类键盘单击会失效，也是当初改成「按下即前进」的原因。
 *
 * 只读 window 事件，不改变训练状态。
 */
export function KeyDiagnostics({ open, binding, onBindingChange }) {
  const [rows, setRows] = useState([])
  const [recording, setRecording] = useState(false)
  const [msgApi, msgCtx] = message.useMessage()
  const idRef = useRef(0)
  const recordingRef = useRef(false)
  recordingRef.current = recording

  useEffect(() => {
    if (!open) return
    const push = (row) => setRows((prev) => [row, ...prev].slice(0, MAX_ROWS))

    const record = (type, e) => {
      const base = {
        id: ++idRef.current,
        type,
        key: e.key ?? '',
        code: e.code ?? '',
        keyCode: e.keyCode ?? 0,
        repeat: Boolean(e.repeat),
        matched: type === 'keydown' ? isContextMenuKey(e) || matchesBinding(e, binding) : null,
      }
      push(base)
      // 录制模式下，记录第一个非修饰键
      if (recordingRef.current && type === 'keydown' && !e.repeat) {
        const isModifier = e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta'
        if (!isModifier) {
          recordingRef.current = false
          setRecording(false)
          onBindingChange?.({ key: e.key, code: e.code, keyCode: e.keyCode })
          msgApi.success(`已记录键位：key=${e.key || '(空)'} code=${e.code || '(空)'} keyCode=${e.keyCode}`)
        }
      }
    }

    const onDown = (e) => record('keydown', e)
    const onUp = (e) => record('keyup', e)
    const onCtx = (e) =>
      push({
        id: ++idRef.current,
        type: 'contextmenu',
        key: '(mouse)',
        code: `button=${e.button}`,
        keyCode: 0,
        repeat: false,
        matched: null,
      })

    window.addEventListener('keydown', onDown, { capture: true })
    window.addEventListener('keyup', onUp, { capture: true })
    window.addEventListener('contextmenu', onCtx, { capture: true })
    return () => {
      window.removeEventListener('keydown', onDown, { capture: true })
      window.removeEventListener('keyup', onUp, { capture: true })
      window.removeEventListener('contextmenu', onCtx, { capture: true })
    }
  }, [open, binding, onBindingChange, msgApi])

  const copy = async () => {
    const text = rows
      .slice()
      .reverse()
      .map(
        (r) =>
          `${r.type}\tkey=${JSON.stringify(r.key)}\tcode=${JSON.stringify(r.code)}\tkeyCode=${r.keyCode}\trepeat=${r.repeat}\tmatched=${r.matched}`,
      )
      .join('\n')
    try {
      await navigator.clipboard.writeText(text)
      msgApi.success('已复制，粘贴给我即可')
    } catch {
      msgApi.warning('浏览器不允许写剪贴板，请手动选中表格复制')
    }
  }

  if (!open) return null

  // 统计：有 keydown 但从未出现 keyup 的键，说明该键盘不发 keyup
  const downKeys = new Set(rows.filter((r) => r.type === 'keydown').map((r) => r.key))
  const upKeys = new Set(rows.filter((r) => r.type === 'keyup').map((r) => r.key))
  const noKeyUp = [...downKeys].filter((k) => !upKeys.has(k))

  return (
    <div className="keydiag">
      {msgCtx}
      <Space style={{ marginBottom: 6 }} wrap size={[8, 4]}>
        <Tag icon={<BugOutlined />} color="orange">
          键盘诊断
        </Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          默认推进键是键盘方向键 <Tag color="blue">→</Tag>（也支持鼠标右键）。
          按一下要用的键，看下表「识别」列
        </Text>
        <Button
          size="small"
          type={recording ? 'primary' : 'default'}
          icon={<ThunderboltOutlined />}
          onClick={() => setRecording((v) => !v)}
        >
          {recording ? '请按一下要绑定的键…' : '自定义推进键'}
        </Button>
        {binding && (
          <Button size="small" onClick={() => onBindingChange?.(null)}>
            清除自定义键（当前 {binding.key || binding.code || binding.keyCode}）
          </Button>
        )}
        <Button size="small" icon={<CopyOutlined />} onClick={copy} disabled={!rows.length}>
          复制
        </Button>
        <Button size="small" icon={<DeleteOutlined />} onClick={() => setRows([])} disabled={!rows.length}>
          清空
        </Button>
      </Space>

      {noKeyUp.length > 0 && (
        <div className="keydiag-warn">
          检测到这些键只发 keydown、没有 keyup：{noKeyUp.map((k) => `「${k || '空'}」`).join('、')}。
          系统已改为「按下立即前进一根」，不依赖 keyup。
        </div>
      )}

      <div className="keydiag-tablewrap">
        <table className="keydiag-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>key</th>
              <th>code</th>
              <th>keyCode</th>
              <th>repeat</th>
              <th>识别</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)' }}>
                  等待按键…
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={r.matched ? 'hit' : ''}>
                <td>{r.type}</td>
                <td>
                  <code>{r.key || '(空)'}</code>
                </td>
                <td>
                  <code>{r.code || '(空)'}</code>
                </td>
                <td>{r.keyCode}</td>
                <td>{r.repeat ? '是' : ''}</td>
                <td>{r.matched == null ? '' : r.matched ? <Tag color="green">已识别</Tag> : <Tag>未识别</Tag>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

import React from 'react'
import { Button, Dropdown, InputNumber, Modal, Space, Tooltip } from 'antd'
import { DownOutlined } from '@ant-design/icons'
import { RATIO_PRESETS } from '../../shared/training/engine.js'

/** 比例显示成 1/3 这种分数，1 显示为「全部」 */
export function ratioLabel(ratio) {
  if (ratio == null) return '默认'
  const r = Number(ratio)
  if (!Number.isFinite(r) || r <= 0) return '默认'
  if (Math.abs(r - 1) < 1e-9) return '全部'
  for (const p of RATIO_PRESETS) {
    if (Math.abs(r - p.num / p.den) < 1e-9) return p.label
  }
  return `${(r * 100).toFixed(1).replace(/\.0$/, '')}%`
}

/**
 * 买卖比例按钮组：每个比例一个按钮，点一下直接按该比例成交。
 *
 * 为什么要做成按钮而不是下拉：训练时手要快，多一步选择就会打断节奏。
 * 预设 1/10、1/5、1/4、1/3、1/2、全部，另有「自定义」弹窗输入任意百分比。
 *
 * @param {object} p
 * @param {'buy'|'sell'} p.side
 * @param {(ratio:number)=>void} p.onExec 点击某个比例时执行
 * @param {number|null} p.positionPct 会话默认仓位（买入用，作为额外按钮）
 * @param {boolean} p.disabled 无持仓/无现金时禁用
 * @param {string} [p.disableReason] 禁用原因，用于 Tooltip
 */
export function RatioButtons({ side, onExec, positionPct, disabled, disableReason }) {
  const [customOpen, setCustomOpen] = React.useState(false)
  const [custom, setCustom] = React.useState(20)

  const isBuy = side === 'buy'
  const exec = (r) => {
    if (disabled) return
    onExec?.(r)
  }

  const presets = RATIO_PRESETS.slice().sort((a, b) => a.den - b.den) // 1/10 在前，按比例从快到慢
  // 买入额外给一个「默认仓位」按钮，方便按会话设定操作
  const showDefault = isBuy && Number.isFinite(Number(positionPct)) && Number(positionPct) > 0

  return (
    <Space size={4} wrap>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{isBuy ? '买入' : '卖出'}</span>
      {presets.map((p) => {
        const ratio = p.num / p.den
        return (
          <Tooltip key={p.label} title={isBuy ? `用当前现金的 ${p.label} 买入` : `卖出持仓的 ${p.label}`}>
            <Button size="small" danger={!isBuy} disabled={disabled} onClick={() => exec(ratio)}>
              {p.label}
            </Button>
          </Tooltip>
        )
      })}
      <Tooltip title={isBuy ? '用当前现金的 100% 买入' : '清空全部持仓'}>
        <Button size="small" danger={!isBuy} disabled={disabled} onClick={() => exec(1)}>
          全部
        </Button>
      </Tooltip>
      {showDefault && (
        <Tooltip title={`按会话默认仓位 ${(Number(positionPct) * 100).toFixed(0)}% 买入`}>
          <Button size="small" disabled={disabled} onClick={() => exec(Number(positionPct))}>
            默认 {(Number(positionPct) * 100).toFixed(0)}%
          </Button>
        </Tooltip>
      )}
      <Button size="small" icon={<DownOutlined />} disabled={disabled} onClick={() => setCustomOpen(true)}>
        自定义
      </Button>

      <Modal
        open={customOpen}
        title={isBuy ? '自定义买入比例' : '自定义卖出比例'}
        onCancel={() => setCustomOpen(false)}
        onOk={() => {
          setCustomOpen(false)
          exec(Math.min(1, Math.max(0.01, custom / 100)))
        }}
        okText={`${isBuy ? '买入' : '卖出'} ${custom}%`}
        width={360}
      >
        <div style={{ padding: '8px 0' }}>
          <InputNumber
            min={1}
            max={100}
            step={5}
            value={custom}
            onChange={(v) => setCustom(v || 1)}
            addonAfter="%"
            style={{ width: '100%' }}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
            {isBuy
              ? `按当前可用现金的 ${custom}% 买入，数量向下取整到 100 份`
              : `卖出当前持仓的 ${custom}%，数量向下取整到 100 份（不足一手按一手）`}
          </div>
        </div>
      </Modal>
    </Space>
  )
}

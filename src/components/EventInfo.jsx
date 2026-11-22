import React from 'react'
import { Popover, Tag, Typography } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { EVENT_COLORS } from '../researchChart.js'
import { eventDoc, SIDE_TEXT } from '../wyckoffGlossary.js'

const { Text } = Typography

/** 事件解释浮层内容 */
export function EventDocContent({ type }) {
  const doc = eventDoc(type)
  if (!doc) return <Text type="secondary">暂无该事件的说明</Text>
  return (
    <div className="eventdoc" style={{ maxWidth: 300 }}>
      <div className="eventdoc-head">
        <Tag color={EVENT_COLORS[type] || 'default'}>{type}</Tag>
        <Text strong>{doc.label}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {doc.en} · {SIDE_TEXT[doc.side] || ''}
        </Text>
      </div>
      <p>{doc.summary}</p>
      <p>
        <Text strong>识别条件：</Text>
        {doc.detect}
      </p>
      <p>
        <Text strong>怎么用：</Text>
        {doc.usage}
      </p>
    </div>
  )
}

/**
 * 事件标签 + 可点击的解释 icon。
 * @param {object} p { type, color, closable, onClose }
 */
export function EventInfo({ type, color, children, ...rest }) {
  const doc = eventDoc(type)
  return (
    <Tag color={color ?? EVENT_COLORS[type] ?? 'default'} {...rest}>
      {children ?? type}
      {doc && (
        <Popover
          content={<EventDocContent type={type} />}
          title={null}
          trigger="click"
          placement="top"
          arrow={false}
        >
          <InfoCircleOutlined
            className="eventdoc-icon"
            role="button"
            tabIndex={0}
            aria-label={`${type} 说明`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </Popover>
      )}
    </Tag>
  )
}

/** 纯文本 + 解释 icon（表格里用，避免 Tag 太抢眼） */
export function EventInfoText({ type }) {
  const doc = eventDoc(type)
  return (
    <span className="eventdoc-text">
      {type}
      {doc && (
        <Popover content={<EventDocContent type={type} />} trigger="click" placement="top" arrow={false}>
          <InfoCircleOutlined
            className="eventdoc-icon"
            role="button"
            tabIndex={0}
            aria-label={`${type} 说明`}
            onClick={(e) => e.stopPropagation()}
          />
        </Popover>
      )}
    </span>
  )
}

import React, { useEffect, useState } from 'react'
import { Alert, Button, Popconfirm, Space, Table, Tag, Typography, message } from 'antd'
import { CheckOutlined, CloseOutlined, SyncOutlined } from '@ant-design/icons'
import { api, postApi } from '../api.js'

const { Text } = Typography

const n2 = (v) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(2))

/**
 * 除息事件管理：自动识别 → 人工确认 → 参与前复权。
 * 自动识别是启发式结果，必须确认，避免把真实利空误当成除息。
 */
export function DividendPanel({ code, onChanged }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState('')
  const [msgApi, msgCtx] = message.useMessage()

  const load = async () => {
    if (!code) return
    setLoading(true)
    setError('')
    try {
      const r = await api('/api/dividends', { code })
      setItems(r.items || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [code])

  const detect = async () => {
    setDetecting(true)
    setError('')
    try {
      const r = await postApi('/api/dividends/detect', { code })
      setItems(r.items || [])
      msgApi.success(`识别到 ${r.detected.length} 个候选，新增 ${r.added} 个；确认后才会参与复权`)
      onChanged?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setDetecting(false)
    }
  }

  const setConfirmed = async (id, confirmed) => {
    try {
      await postApi('/api/dividends/confirm', { id, confirmed })
      await load()
      onChanged?.()
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const confirmedCount = items.filter((i) => i.confirmed).length

  const columns = [
    { title: '除息日', dataIndex: 'exDate', width: 110 },
    {
      title: '相对跌幅',
      dataIndex: 'dropPct',
      width: 96,
      render: (v) => `${n2(v)}%`,
    },
    {
      title: '每股估算(元)',
      dataIndex: 'amount',
      width: 110,
      render: (v) => (Number.isFinite(+v) ? (+v).toFixed(4) : '-'),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 80,
      render: (s) => <Tag color={s === 'manual' ? 'blue' : 'default'}>{s === 'manual' ? '人工' : '自动'}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'confirmed',
      width: 90,
      render: (c) => (c ? <Tag color="green">已确认</Tag> : <Tag color="orange">待确认</Tag>),
    },
    {
      title: '操作',
      width: 120,
      render: (_, r) =>
        r.confirmed ? (
          <Popconfirm title="取消确认后将不再参与复权" onConfirm={() => setConfirmed(r.id, false)}>
            <Button size="small" icon={<CloseOutlined />}>
              取消
            </Button>
          </Popconfirm>
        ) : (
          <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => setConfirmed(r.id, true)}>
            确认
          </Button>
        ),
    },
  ]

  return (
    <section className="panel" style={{ marginTop: 12 }}>
      {msgCtx}
      <div className="ai-chat-head">
        <Space size={8} wrap>
          <Text strong>除息事件 / 复权</Text>
          <Tag color={confirmedCount ? 'green' : 'default'}>{confirmedCount} 条已确认</Tag>
        </Space>
        <Space>
          <Button size="small" icon={<SyncOutlined />} loading={detecting} onClick={detect}>
            自动识别
          </Button>
          <Button size="small" onClick={load} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        message="价格数据未复权，除息日会出现向下跳空。"
        description="自动识别基于「ETF 相对上证指数的额外低开」，属于启发式结果；确认后才会用于前复权，否则可能把真实利空误当成除息。"
      />
      {error && <div className="status err">{error}</div>}

      <Table
        size="small"
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={items.length > 8 ? { pageSize: 8, size: 'small' } : false}
        scroll={{ x: 640 }}
        locale={{ emptyText: '暂无除息记录；点「自动识别」从历史价格中提取候选' }}
      />
    </section>
  )
}

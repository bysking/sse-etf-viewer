import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import { api, deleteApi, postApi, putApi } from './api.js'
import { EventInfoText } from './components/EventInfo.jsx'

const { Title, Text } = Typography

const n2 = (v) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(2))
const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : ((+v) * 100).toFixed(2) + '%')
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')

const CHANNEL_TYPES = [
  { value: 'feishu', label: '飞书群机器人' },
  { value: 'telegram', label: 'Telegram' },
]

function ChannelForm({ open, initial, onClose, onSaved }) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const type = Form.useWatch('type', form) || initial?.type || 'feishu'
  const [msgApi, msgCtx] = message.useMessage()

  useEffect(() => {
    if (!open) return
    form.setFieldsValue(
      initial
        ? { name: initial.name, type: initial.type, enabled: initial.enabled, ...flatten(initial.config) }
        : { name: '', type: 'feishu', enabled: true, useCard: true },
    )
  }, [open, initial])

  const save = async () => {
    try {
      const v = await form.validateFields()
      setSaving(true)
      const config = type === 'feishu'
        ? { webhookUrl: v.webhookUrl, secret: v.secret || undefined, useCard: v.useCard !== false }
        : { botToken: v.botToken, chatId: v.chatId, apiBase: v.apiBase || undefined }
      const payload = { name: v.name, type, config, enabled: v.enabled !== false }
      if (initial?.id) await putApi(`/api/channels/${initial.id}`, payload)
      else await postApi('/api/channels', payload)
      msgApi.success('已保存')
      onSaved?.()
      onClose()
    } catch (e) {
      if (e?.errorFields) return
      msgApi.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} title={initial ? '编辑通知渠道' : '新增通知渠道'} footer={null} width={560}>
      {msgCtx}
      <Form form={form} layout="vertical">
        <Form.Item name="type" label="类型" rules={[{ required: true }]}>
          <Select options={CHANNEL_TYPES} disabled={Boolean(initial)} />
        </Form.Item>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填写名称' }]}>
          <Input placeholder="例如：主群" />
        </Form.Item>
        {type === 'feishu' ? (
          <>
            <Form.Item name="webhookUrl" label="Webhook URL" rules={[{ required: true, message: '请填写 webhook' }]}>
              <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
            </Form.Item>
            <Form.Item name="secret" label="签名密钥（可选）">
              <Input.Password placeholder="开启签名校验时填写" />
            </Form.Item>
            <Form.Item name="useCard" label="使用卡片消息" valuePropName="checked">
              <Switch />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item name="botToken" label="Bot Token" rules={[{ required: true, message: '请填写 botToken' }]}>
              <Input.Password placeholder="123456:ABC-DEF..." />
            </Form.Item>
            <Form.Item name="chatId" label="Chat ID" rules={[{ required: true, message: '请填写 chatId' }]}>
              <Input placeholder="-1001234567890" />
            </Form.Item>
            <Form.Item name="apiBase" label="API Base（可选，代理/自建用）">
              <Input placeholder="https://api.telegram.org" />
            </Form.Item>
          </>
        )}
        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Space>
          <Button type="primary" loading={saving} onClick={save}>
            保存
          </Button>
          <Button onClick={onClose}>取消</Button>
        </Space>
      </Form>
    </Modal>
  )
}

function flatten(config = {}) {
  return {
    webhookUrl: config.webhookUrl,
    secret: '',
    useCard: config.useCard,
    botToken: '',
    chatId: config.chatId,
    apiBase: config.apiBase,
  }
}

export function MonitorPage() {
  const [strategies, setStrategies] = useState([])
  const [status, setStatus] = useState(null)
  const [signals, setSignals] = useState([])
  const [paper, setPaper] = useState(null)
  const [channels, setChannels] = useState([])
  const [logs, setLogs] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [channelForm, setChannelForm] = useState({ open: false, initial: null })
  const [msgApi, msgCtx] = message.useMessage()

  const load = async () => {
    setLoading(true)
    try {
      const [s, st, ch, lg] = await Promise.all([
        api('/api/strategies'),
        api('/api/monitor/status'),
        api('/api/channels'),
        api('/api/notify-log', { limit: 50 }),
      ])
      setStrategies(s.items || [])
      setStatus(st)
      setChannels(ch.items || [])
      setLogs(lg.items || [])
      if (!selected && s.items?.length) setSelected(s.items[0].id)
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    if (!selected) return
    Promise.all([
      api(`/api/strategies/${selected}/signals`, { limit: 100 }),
      api(`/api/strategies/${selected}/paper`),
    ])
      .then(([sg, pp]) => {
        setSignals(sg.items || [])
        setPaper(pp)
      })
      .catch((e) => msgApi.error(e.message))
  }, [selected])

  const runCheck = async () => {
    if (!selected) return
    setBusy('check')
    try {
      const r = await postApi(`/api/strategies/${selected}/check`, { force: true })
      msgApi.success(`检查完成：${r.signals.length} 条新信号，${r.orders.length} 项账本变动`)
      await load()
      const sg = await api(`/api/strategies/${selected}/signals`, { limit: 100 })
      setSignals(sg.items || [])
      const pp = await api(`/api/strategies/${selected}/paper`)
      setPaper(pp)
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const settle = async () => {
    if (!selected) return
    setBusy('settle')
    try {
      const r = await postApi(`/api/strategies/${selected}/paper/settle`, {})
      const n = Object.values(r.result || {}).reduce((a, x) => a + (x.settled?.length || 0), 0)
      msgApi.success(n ? `已结算 ${n} 笔` : '没有可结算的订单（需要信号日之后的交易日数据）')
      const pp = await api(`/api/strategies/${selected}/paper`)
      setPaper(pp)
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const refreshSignalsAndPaper = async () => {
    if (!selected) return
    const [sg, pp] = await Promise.all([
      api(`/api/strategies/${selected}/signals`, { limit: 100 }),
      api(`/api/strategies/${selected}/paper`),
    ])
    setSignals(sg.items || [])
    setPaper(pp)
  }

  const confirmSig = async (id) => {
    setBusy(`c-${id}`)
    try {
      const r = await postApi(`/api/signals/${id}/confirm`, { strategyId: selected })
      if (r.order) msgApi.success(`已确认，人工账本挂单 ${r.order.side === 'buy' ? '买入' : '卖出'} ${r.order.qty} 份`)
      else if (r.reason === 'notExecutable') msgApi.warning('已标记确认，但当前无法下单（可能已持仓或缺少失效位）')
      else msgApi.info('该信号已处理过')
      await refreshSignalsAndPaper()
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const ignoreSig = async (id) => {
    setBusy(`i-${id}`)
    try {
      await postApi(`/api/signals/${id}/ignore`, { strategyId: selected })
      msgApi.success('已忽略')
      await refreshSignalsAndPaper()
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const testChannel = async (id) => {
    setBusy(`test-${id}`)
    try {
      await postApi(`/api/channels/${id}/test`, {})
      msgApi.success('测试消息已发送')
      const lg = await api('/api/notify-log', { limit: 50 })
      setLogs(lg.items || [])
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const removeChannel = async (id) => {
    try {
      await deleteApi(`/api/channels/${id}`)
      msgApi.success('已删除')
      await load()
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const signalColumns = [
    { title: '确认日', dataIndex: 'detectedAt', width: 108 },
    { title: '事件', dataIndex: 'eventType', width: 104, render: (t) => <EventInfoText type={t} /> },
    {
      title: '动作',
      dataIndex: 'action',
      width: 110,
      render: (a) => (a === 'entry_candidate' ? <Tag color="red">买入观察</Tag> : <Tag color="green">离场观察</Tag>),
    },
    { title: '参考价', dataIndex: 'price', width: 84, render: (v) => n2(v) },
    { title: '区间', dataIndex: 'rangeId', width: 120, render: (v) => v || '-' },
    {
      title: '失效位',
      width: 90,
      render: (_, r) => n2(r.evidence?.stopLevel),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s) => (
        <Tag color={s === 'confirmed' ? 'green' : s === 'ignored' ? 'default' : 'orange'}>
          {s === 'candidate' ? '候选' : s === 'confirmed' ? '已确认' : s === 'ignored' ? '已忽略' : s}
        </Tag>
      ),
    },
    {
      title: '人工确认',
      width: 150,
      render: (_, r) =>
        r.status === 'candidate' ? (
          <Space size={4}>
            <Button size="small" type="primary" loading={busy === `c-${r.id}`} onClick={() => confirmSig(r.id)}>
              确认
            </Button>
            <Button size="small" loading={busy === `i-${r.id}`} onClick={() => ignoreSig(r.id)}>
              忽略
            </Button>
          </Space>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {r.status === 'confirmed' ? '已进人工账本' : '已跳过'}
          </span>
        ),
    },
  ]

  const orderColumns = [
    { title: '账本', dataIndex: 'ledger', width: 74, render: (l) => (l === 'rule' ? '规则' : '人工') },
    { title: '方向', dataIndex: 'side', width: 74, render: (s) => (s === 'buy' ? '买入' : '卖出') },
    { title: '数量', dataIndex: 'qty', width: 80 },
    { title: '信号日', dataIndex: 'signalDate', width: 108 },
    { title: '成交日', dataIndex: 'fillDate', width: 108, render: (v) => v || '-' },
    { title: '成交价', dataIndex: 'fillPrice', width: 84, render: (v) => n2(v) },
    { title: '失效位', dataIndex: 'stopLevel', width: 84, render: (v) => n2(v) },
    { title: '状态', dataIndex: 'status', width: 90, render: (s) => <Tag color={s === 'filled' ? 'green' : s === 'pending' ? 'orange' : 'default'}>{s}</Tag> },
  ]

  const logColumns = [
    { title: '时间', dataIndex: 'createdAt', width: 170, render: (v) => String(v).replace('T', ' ').slice(0, 19) },
    { title: '渠道', dataIndex: 'channelId', width: 100, render: (id) => channels.find((c) => c.id === id)?.name || id.slice(0, 8) },
    { title: '状态', dataIndex: 'status', width: 80, render: (s) => <Tag color={s === 'ok' ? 'green' : 'red'}>{s}</Tag> },
    { title: 'HTTP', dataIndex: 'httpStatus', width: 70 },
    { title: '内容', dataIndex: 'payloadPreview', render: (v) => <span style={{ fontSize: 12, color: 'var(--muted)' }}>{v}</span> },
  ]

  const channelColumns = [
    { title: '名称', dataIndex: 'name', width: 140 },
    { title: '类型', dataIndex: 'type', width: 100 },
    { title: '启用', dataIndex: 'enabled', width: 70, render: (e) => (e ? <Tag color="green">是</Tag> : <Tag>否</Tag>) },
    {
      title: '配置',
      render: (_, c) => (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {c.type === 'feishu' ? c.config.webhookUrl : `${c.config.chatId} · token ${c.config.botToken}`}
        </span>
      ),
    },
    {
      title: '操作',
      width: 190,
      render: (_, c) => (
        <Space size={4}>
          <Button size="small" icon={<SendOutlined />} loading={busy === `test-${c.id}`} onClick={() => testChannel(c.id)}>
            测试
          </Button>
          <Button size="small" onClick={() => setChannelForm({ open: true, initial: c })}>
            编辑
          </Button>
          <Button size="small" danger onClick={() => removeChannel(c.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ]

  const paperCards = useMemo(() => {
    if (!paper?.items) return []
    return paper.items.map((a) => ({
      key: a.ledger,
      label: a.ledger === 'rule' ? '规则账本（自动）' : '人工确认账本',
      children: (
        <>
          <section className="cards">
            <div className="card">
              <div className="l">现金</div>
              <div className="v">{n2(a.cash)}</div>
              <div className="s">持仓 {a.units} 份</div>
            </div>
            <div className="card">
              <div className="l">总净值</div>
              <div className="v">{n2(a.equity)}</div>
              <div className="s">
                最新 {n2(a.lastClose)}（{a.lastDate || '-'}）
              </div>
            </div>
            <div className="card">
              <div className="l">已实现盈亏</div>
              <div className={`v ${cls(a.realizedPnl)}`}>{n2(a.realizedPnl)}</div>
              <div className="s">{a.tradeCount} 笔已平仓</div>
            </div>
            <div className="card">
              <div className="l">胜率</div>
              <div className="v">{a.winRate == null ? '-' : pct(a.winRate)}</div>
              <div className="s">平均成本 {n2(a.avgCost)}</div>
            </div>
          </section>
          <Table
            size="small"
            rowKey="id"
            columns={orderColumns}
            dataSource={a.orders || []}
            pagination={false}
            scroll={{ x: 760 }}
            locale={{ emptyText: '暂无订单' }}
          />
        </>
      ),
    }))
  }, [paper])

  const current = strategies.find((s) => s.id === selected)

  return (
    <>
      {msgCtx}
      <main>
        <div className="ai-head">
          <div>
            <Title level={2} style={{ margin: '4px 0 2px' }}>
              监控与模拟盘
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              收盘后检查候选信号、驱动双账本、发送通知。调度在生产进程内运行。
            </Text>
          </div>
          <Space wrap>
            {status && (
              <Tag color={status.enabled ? 'green' : 'default'}>
                {status.enabled ? '调度运行中' : '调度未启动（开发环境）'}
              </Tag>
            )}
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
          </Space>
        </div>

        {status && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message={`检查时点：价格类 ${status.priceCheckAt}；含份额 ${status.shareCheckAt}（重试至 ${status.shareRetryUntil}）`}
            description="开发环境不自动调度，可用「立即检查」；生产用 npm start 启动后自动运行（ENABLE_MONITOR=0 可关闭）。"
          />
        )}

        <section className="panel" style={{ marginTop: 12 }}>
          <Space wrap size={[8, 8]}>
            <Text strong>策略</Text>
            <Select
              style={{ minWidth: 260 }}
              value={selected}
              onChange={setSelected}
              placeholder="选择策略"
              options={strategies.map((s) => ({
                value: s.id,
                label: `${s.name}${s.enabled ? '' : '（未启用）'} · ${s.config?.symbol || ''}`,
              }))}
            />
            <Button type="primary" icon={<PlayCircleOutlined />} loading={busy === 'check'} disabled={!selected} onClick={runCheck}>
              立即检查
            </Button>
            <Button icon={<SyncOutlined />} loading={busy === 'settle'} disabled={!selected} onClick={settle}>
              结算待成交
            </Button>
          </Space>
          {current && (
            <div className="status" style={{ marginBottom: 0 }}>
              {current.config?.symbol} · {current.enabled ? '已启用' : '未启用'} · 当前阶段{' '}
              {signals[0]?.evidence?.phase || '-'}
            </div>
          )}
        </section>

        <Tabs
          style={{ marginTop: 12 }}
          items={[
            {
              key: 'signals',
              label: `候选信号 (${signals.length})`,
              children: (
                <Table
                  size="small"
                  rowKey="id"
                  columns={signalColumns}
                  dataSource={signals}
                  pagination={{ pageSize: 10, size: 'small' }}
                  scroll={{ x: 760 }}
                  locale={{ emptyText: '暂无信号；点「立即检查」生成' }}
                />
              ),
            },
            {
              key: 'paper',
              label: '模拟盘',
              children: paperCards.length ? (
                <Tabs type="card" items={paperCards} />
              ) : (
                <Alert type="info" showIcon message="该策略还没有模拟盘账户；执行一次检查后会创建" />
              ),
            },
            {
              key: 'channels',
              label: `通知渠道 (${channels.length})`,
              children: (
                <>
                  <Space style={{ marginBottom: 8 }}>
                    <Button size="small" icon={<PlusOutlined />} onClick={() => setChannelForm({ open: true, initial: null })}>
                      新增渠道
                    </Button>
                  </Space>
                  <Table
                    size="small"
                    rowKey="id"
                    columns={channelColumns}
                    dataSource={channels}
                    pagination={false}
                    scroll={{ x: 760 }}
                    locale={{ emptyText: '还没有通知渠道' }}
                  />
                </>
              ),
            },
            {
              key: 'logs',
              label: '发送记录',
              children: (
                <Table
                  size="small"
                  rowKey="id"
                  columns={logColumns}
                  dataSource={logs}
                  pagination={{ pageSize: 10, size: 'small' }}
                  scroll={{ x: 760 }}
                  locale={{ emptyText: '暂无发送记录' }}
                />
              ),
            },
          ]}
        />

        <footer>
          通知只描述候选信号，不构成指令。规则账本自动成交用于评估策略本身；人工确认账本需要你确认后才记账。
          结算口径与回测一致：信号日次日开盘成交，含滑点、佣金、T+1 和结构失效取消。
        </footer>
      </main>

      <ChannelForm
        open={channelForm.open}
        initial={channelForm.initial}
        onClose={() => setChannelForm({ open: false, initial: null })}
        onSaved={load}
      />
    </>
  )
}

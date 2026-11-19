import React, { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  CopyOutlined,
  ExperimentOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SendOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { api, postApi, putApi } from './api.js'
import { EChart } from './components/EChart.jsx'
import { buildEquityOption } from './researchChart.js'

const { RangePicker } = DatePicker
const { TextArea } = Input
const { Title, Text } = Typography

const MAX_DAYS = 1826
const PRESETS = [
  { key: '1y', label: '近1年', days: 365 },
  { key: '3y', label: '近3年', days: 1095 },
  { key: '5y', label: '近5年', days: 1826 },
]
const PRESET_CODES = [
  ['510300', '沪深300ETF'],
  ['510050', '上证50ETF'],
  ['510500', '中证500ETF'],
  ['588000', '科创50ETF'],
]
const fmt = (d) => d.format('YYYY-MM-DD')
const presetRange = (key) => {
  const p = PRESETS.find((x) => x.key === key) || PRESETS[0]
  const end = dayjs()
  return [end.subtract(p.days, 'day'), end]
}
const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : ((+v) * 100).toFixed(2) + '%')
const n2 = (v) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(2))
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')

const emptyForm = () => ({ baseUrl: '', model: '', apiKey: '', temperature: 0.3, maxTokens: 2048 })

export function AiPage() {
  const [config, setConfig] = useState(null)
  const [configLoading, setConfigLoading] = useState(true)
  const [configOpen, setConfigOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const [code, setCode] = useState('510300')
  const [range, setRange] = useState(() => presetRange('1y'))
  const [includeShares, setIncludeShares] = useState(false)

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [contextText, setContextText] = useState('')
  const [contextSummary, setContextSummary] = useState(null)
  const [strategyResult, setStrategyResult] = useState(null)

  const [initialCash, setInitialCash] = useState(100000)
  const [btLoading, setBtLoading] = useState(false)
  const [bt, setBt] = useState(null)
  const [btError, setBtError] = useState('')
  const [trades, setTrades] = useState([])

  const chatRef = useRef(null)
  const pollRef = useRef(null)
  const btToken = useRef(0)
  const [msgApi, msgCtx] = message.useMessage()

  useEffect(() => {
    let alive = true
    api('/api/ai/config')
      .then((c) => {
        if (!alive) return
        setConfig(c)
        setForm({ ...emptyForm(), ...c, apiKey: '' })
      })
      .catch((e) => setError(e.message))
      .finally(() => alive && setConfigLoading(false))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    chatRef.current?.scrollTo?.({ top: chatRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    return () => {
      clearTimeout(pollRef.current)
      btToken.current++
    }
  }, [])

  const openConfig = () => {
    setForm(config ? { ...emptyForm(), ...config, apiKey: '' } : emptyForm())
    setConfigOpen(true)
  }

  const saveConfig = async () => {
    if (!form.baseUrl.trim() || !form.model.trim()) {
      msgApi.warning('请填写 baseUrl 和 model')
      return
    }
    setSaving(true)
    try {
      const payload = {
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        temperature: form.temperature,
        maxTokens: form.maxTokens,
      }
      if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim()
      const c = await putApi('/api/ai/config', payload)
      setConfig(c)
      setForm({ ...emptyForm(), ...c, apiKey: '' })
      setConfigOpen(false)
      msgApi.success('AI 模型配置已保存')
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async () => {
    if (!form.baseUrl.trim() || !form.model.trim()) {
      msgApi.warning('请填写 baseUrl 和 model')
      return
    }
    setTesting(true)
    try {
      const payload = {
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        temperature: form.temperature,
        maxTokens: form.maxTokens,
      }
      if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim()
      const r = await postApi('/api/ai/test', payload)
      msgApi.success(`连接成功，模型返回：${r.content || 'OK'}`)
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setTesting(false)
    }
  }

  const clearKey = async () => {
    try {
      const c = await putApi('/api/ai/config', { apiKey: '' })
      setConfig(c)
      msgApi.success('已清除保存的 API Key')
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const ensureConfigured = () => {
    if (!config?.configured) {
      setConfigOpen(true)
      msgApi.warning('请先配置 AI 模型')
      return false
    }
    return true
  }

  const pushMessage = (m) => setMessages((prev) => [...prev, m].slice(-30))

  const runAnalyze = async () => {
    if (!ensureConfigured()) return
    const q = input.trim() || '请分析当前数据，说明结构、事件、风险和候选观察点。'
    setInput('')
    setLoading(true)
    setError('')
    pushMessage({ role: 'user', content: q })
    try {
      const r = await postApi('/api/ai/analyze', {
        code,
        start: fmt(range[0]),
        end: fmt(range[1]),
        includeShares,
        question: q,
      })
      pushMessage({ role: 'assistant', content: r.content })
      setContextText(r.contextText || '')
      setContextSummary(r.contextSummary || null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const runGenerate = async () => {
    if (!ensureConfigured()) return
    const q = input.trim() || '请基于当前数据生成一个稳健的多头 Wyckoff 策略，并保留结构止损。'
    setInput('')
    setLoading(true)
    setError('')
    pushMessage({ role: 'user', content: q })
    try {
      const r = await postApi('/api/ai/strategy', {
        code,
        start: fmt(range[0]),
        end: fmt(range[1]),
        includeShares,
        instructions: q,
      })
      pushMessage({ role: 'assistant', content: r.content })
      setContextText(r.contextText || '')
      setContextSummary(r.contextSummary || null)
      setStrategyResult(r)
      setBt(null)
      setBtError('')
      setTrades([])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const runChat = async () => {
    if (!ensureConfigured()) return
    const q = input.trim()
    if (!q) return
    const next = [...messages, { role: 'user', content: q }].slice(-30)
    setMessages(next)
    setInput('')
    setLoading(true)
    setError('')
    try {
      const history = next
        .slice(-10)
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }))
      const r = await postApi('/api/ai/chat', { messages: history, contextText: contextText.slice(0, 20000) })
      pushMessage({ role: 'assistant', content: r.content })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const runBacktest = async () => {
    const cfg = strategyResult?.strategyConfig
    if (!cfg || !strategyResult?.validation?.ok) return
    setBtLoading(true)
    setBtError('')
    setBt(null)
    setTrades([])
    try {
      const res = await postApi('/api/backtests/quick', {
        config: cfg,
        start: fmt(range[0]),
        end: fmt(range[1]),
        initialCash: Number(initialCash) || 100000,
      })
      const my = ++btToken.current
      const started = Date.now()
      const poll = async () => {
        if (my !== btToken.current) return
        try {
          const run = await api(`/api/backtests/${res.id}`)
          if (my !== btToken.current) return
          setBt(run)
          if (run.status === 'done') {
            setTrades(run.trades || [])
            setBtLoading(false)
            return
          }
          if (run.status === 'failed') {
            setBtError(run.error || '回测失败')
            setBtLoading(false)
            return
          }
          if (Date.now() - started > 120000) {
            setBtError('回测超时')
            setBtLoading(false)
            return
          }
          pollRef.current = setTimeout(poll, 500)
        } catch (e) {
          if (my === btToken.current) {
            setBtError(e.message)
            setBtLoading(false)
          }
        }
      }
      poll()
    } catch (e) {
      setBtError(e.message)
      setBtLoading(false)
    }
  }

  const copyStrategy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(strategyResult.strategyConfig, null, 2))
      msgApi.success('已复制策略 JSON')
    } catch {
      msgApi.error('复制失败，请手动选择 JSON')
    }
  }

  const onRange = (vals) => {
    if (!vals?.[0] || !vals?.[1]) return
    let [a, b] = vals
    if (b.diff(a, 'day') > MAX_DAYS) {
      a = b.subtract(MAX_DAYS, 'day')
      msgApi.warning(`最多支持近 5 年，已截断为 ${fmt(a)} ~ ${fmt(b)}`)
    }
    setRange([a, b])
  }

  const equityOption = useMemo(() => buildEquityOption(bt?.equity || []), [bt])
  const metrics = bt?.metrics
  const metricCards = metrics
    ? [
        ['总收益', pct(metrics.totalReturn), `基准 ${pct(metrics.benchmarkReturn)}`, cls(metrics.totalReturn)],
        ['年化', pct(metrics.annualized), '', cls(metrics.annualized)],
        ['最大回撤', pct(metrics.maxDrawdown), '', 'down'],
        ['夏普', n2(metrics.sharpe), '', ''],
        ['胜率', metrics.winRate == null ? '-' : pct(metrics.winRate), `${metrics.tradeCount} 笔已平仓`, ''],
        ['最终净值', n2(metrics.finalEquity), `初始 ${n2(initialCash)}`, ''],
      ]
    : []

  const tradeColumns = [
    {
      title: '方向',
      dataIndex: 'side',
      width: 72,
      render: (s) => (s === 'buy' ? <Tag color="red">买入</Tag> : <Tag color="green">卖出</Tag>),
    },
    { title: '成交日', dataIndex: 'date', width: 108 },
    { title: '价格', dataIndex: 'price', width: 80, render: (v) => n2(v) },
    { title: '数量', dataIndex: 'qty', width: 84 },
    { title: '盈亏', dataIndex: 'pnl', width: 92, render: (v) => (v == null ? '-' : <span className={cls(v)}>{n2(v)}</span>) },
    { title: '原因', dataIndex: 'reason', width: 100 },
  ]

  return (
    <>
      {msgCtx}
      <main>
        <div className="ai-head">
          <div>
            <Title level={2} style={{ margin: '4px 0 2px' }}>
              AI 助手
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              用当前行情上下文做分析、生成可校验的 Wyckoff 策略，并直接回测。密钥只保存在服务端。
            </Text>
          </div>
          <Space wrap>
            {configLoading ? (
              <Tag>读取配置中…</Tag>
            ) : config?.configured ? (
              <Tag color="green">已配置 · {config.model}</Tag>
            ) : (
              <Tag color="orange">未配置</Tag>
            )}
            <Button icon={<SettingOutlined />} onClick={openConfig}>
              模型设置
            </Button>
          </Space>
        </div>

        {!configLoading && !config?.configured && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
            message="还没有配置 AI 模型"
            description="支持任意 OpenAI-compatible chat/completions 端点；配置 baseUrl、model 和可选的 API Key 后即可使用。"
            action={
              <Button size="small" type="primary" onClick={openConfig}>
                去配置
              </Button>
            }
          />
        )}

        <section className="panel ai-context">
          <Space size={[8, 8]} wrap>
            <Text strong>标的</Text>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              maxLength={6}
              style={{ width: 110 }}
              placeholder="6 位代码"
            />
            {PRESET_CODES.map(([c, name]) => (
              <Tag key={c} onClick={() => setCode(c)} style={{ cursor: 'pointer' }}>
                {c} {name}
              </Tag>
            ))}
            <span className="sp" />
            {PRESETS.map((p) => (
              <Button key={p.key} size="small" onClick={() => setRange(presetRange(p.key))}>
                {p.label}
              </Button>
            ))}
            <RangePicker
              value={range}
              onChange={onRange}
              allowClear={false}
              maxDate={dayjs()}
              disabledDate={(cur) => Boolean(cur && cur.isAfter(dayjs(), 'day'))}
            />
            <Checkbox checked={includeShares} onChange={(e) => setIncludeShares(e.target.checked)}>
              纳入份额流（较慢）
            </Checkbox>
          </Space>
          {contextSummary && (
            <div className="status" style={{ marginBottom: 0 }}>
              上下文：{contextSummary.code} · {contextSummary.phase} · {contextSummary.bars} 根日K · 事件 {contextSummary.latestEvents?.length || 0} 条
              · {contextSummary.lastDate}
            </div>
          )}
          {error && <div className="status err">{error}</div>}
        </section>

        <div className="research-grid" style={{ marginTop: 12 }}>
          <section className="panel ai-chat-panel">
            <div className="ai-chat-head">
              <Title level={4} style={{ margin: 0 }}>
                对话
              </Title>
              <Tag>{contextText ? '已加载上下文' : '尚未加载上下文'}</Tag>
            </div>
            <div className="ai-chat" ref={chatRef}>
              {messages.length === 0 && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先“分析数据”，或让 AI 生成策略" />
              )}
              {messages.map((m, i) => (
                <div key={i} className={`ai-msg ${m.role}`}>
                  <div className="ai-role">{m.role === 'user' ? '你' : 'AI'}</div>
                  <div className="ai-content">{m.content}</div>
                </div>
              ))}
              {loading && (
                <div className="ai-msg assistant">
                  <Spin size="small" /> <Text type="secondary">正在调用模型…</Text>
                </div>
              )}
            </div>
            <TextArea
              className="ai-input"
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：分析当前区间的结构和事件；或：生成一个 Spring 吸筹反转策略，保留结构止损"
            />
            <Space wrap style={{ marginTop: 8 }}>
              <Button
                type="primary"
                icon={<ExperimentOutlined />}
                loading={loading}
                disabled={!config?.configured}
                onClick={runAnalyze}
              >
                分析数据
              </Button>
              <Button icon={<RobotOutlined />} loading={loading} disabled={!config?.configured} onClick={runGenerate}>
                生成策略
              </Button>
              <Button icon={<SendOutlined />} disabled={!config?.configured || !input.trim() || loading} onClick={runChat}>
                发送追问
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                当前上下文：{code} · {fmt(range[0])} ~ {fmt(range[1])}{includeShares ? ' · 含份额流' : ''}
              </Text>
            </Space>
          </section>

          <section className="panel ai-strategy-panel">
            <div className="ai-chat-head">
              <Title level={4} style={{ margin: 0 }}>
                策略
              </Title>
              {strategyResult && (
                <Tag color={strategyResult.validation?.ok ? 'green' : 'red'}>
                  {strategyResult.validation?.ok ? '校验通过' : '校验失败'}
                </Tag>
              )}
            </div>
            {!strategyResult ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="生成策略后显示 DSL JSON 和回测入口" />
            ) : strategyResult.strategyConfig ? (
              <>
                {strategyResult.validation?.errors?.length > 0 && (
                  <Alert
                    type="error"
                    showIcon
                    message="策略校验未通过"
                    description={
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {strategyResult.validation.errors.slice(0, 8).map((er, i) => (
                          <li key={i}>{er}</li>
                        ))}
                      </ul>
                    }
                  />
                )}
                {strategyResult.strategyConfig.symbol !== code && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message={`策略标的 ${strategyResult.strategyConfig.symbol} 与当前上下文 ${code} 不一致`}
                  />
                )}
                <pre className="ai-json">{JSON.stringify(strategyResult.strategyConfig, null, 2)}</pre>
                <Space wrap>
                  <Text type="secondary">初始资金</Text>
                  <InputNumber
                    value={initialCash}
                    onChange={(v) => setInitialCash(v || 100000)}
                    min={10000}
                    step={10000}
                    style={{ width: 140 }}
                  />
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    disabled={!strategyResult.validation?.ok}
                    loading={btLoading}
                    onClick={runBacktest}
                  >
                    用此策略回测
                  </Button>
                  <Button icon={<CopyOutlined />} onClick={copyStrategy}>
                    复制 JSON
                  </Button>
                </Space>
                {btLoading && (
                  <div className="prog">
                    <i style={{ width: `${Math.max(2, (bt?.progress || 0) * 100)}%` }} />
                  </div>
                )}
                {btError && <Alert type="error" showIcon message={btError} style={{ marginTop: 8 }} />}
                {bt?.status === 'failed' && !btError && (
                  <Alert type="error" showIcon message={bt.error || '回测失败'} style={{ marginTop: 8 }} />
                )}
              </>
            ) : (
              <Alert
                type="warning"
                showIcon
                message="AI 没有返回可解析的策略 JSON"
                description="可以继续追问，要求只输出 JSON 代码块，并遵循系统支持的 DSL。"
              />
            )}
          </section>
        </div>

        {bt?.status === 'done' && metrics && (
          <section className="panel" style={{ marginTop: 12 }}>
            <Title level={4} style={{ margin: '0 0 8px' }}>
              回测结果
            </Title>
            <section className="cards">
              {metricCards.map((c) => (
                <div className="card" key={c[0]}>
                  <div className="l">{c[0]}</div>
                  <div className={`v ${c[3]}`}>{c[1]}</div>
                  <div className="s">{c[2]}</div>
                </div>
              ))}
            </section>
            <div className="chartwrap">
              <EChart option={equityOption} height={340} />
            </div>
            <div style={{ marginTop: 10 }}>
              <Title level={4} style={{ margin: '0 0 8px' }}>
                交易明细
              </Title>
              <Table
                size="small"
                rowKey={(r) => `${r.side}-${r.date}-${r.signalIndex}`}
                columns={tradeColumns}
                dataSource={trades}
                pagination={{ pageSize: 6, showSizeChanger: false, size: 'small' }}
                scroll={{ x: 700 }}
                locale={{ emptyText: '该区间没有成交' }}
              />
            </div>
          </section>
        )}

        <footer>
          AI 只基于系统提供的行情与事件统计作答；模型输出可能有误，策略必须通过校验和回测后再使用。
          AI 生成策略默认进入“待验证”状态，不会自动启用监控。不构成投资建议。
        </footer>
      </main>

      <Modal
        open={configOpen}
        onCancel={() => setConfigOpen(false)}
        title="AI 模型配置"
        width={620}
        footer={null}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text strong>Base URL</Text>
            <Input
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="https://api.deepseek.com 或 https://api.openai.com/v1"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              支持任意 OpenAI-compatible chat/completions 端点。一般填到 /v1 为止，也可直接填完整 /chat/completions 地址。
            </Text>
          </div>
          <div>
            <Text strong>Model</Text>
            <Input
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="deepseek-chat / gpt-4o-mini / qwen-plus ..."
            />
          </div>
          <div>
            <Text strong>API Key</Text>
            <Input.Password
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={config?.apiKeySet ? `已配置 ${config.apiKeyTail}，留空保持不变` : '可选；本地 Ollama 等可留空'}
            />
            {config?.apiKeySet && (
              <Button size="small" danger style={{ marginTop: 4 }} onClick={clearKey}>
                清除已保存的 API Key
              </Button>
            )}
          </div>
          <Space>
            <div>
              <Text strong>Temperature</Text>
              <InputNumber
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                onChange={(v) => setForm((f) => ({ ...f, temperature: v ?? 0.3 }))}
                style={{ display: 'block', width: 120 }}
              />
            </div>
            <div>
              <Text strong>Max Tokens</Text>
              <InputNumber
                min={1}
                max={32768}
                step={256}
                value={form.maxTokens}
                onChange={(v) => setForm((f) => ({ ...f, maxTokens: v ?? 2048 }))}
                style={{ display: 'block', width: 140 }}
              />
            </div>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            常用示例：OpenAI https://api.openai.com/v1；DeepSeek https://api.deepseek.com；Moonshot
            https://api.moonshot.cn/v1；Ollama http://127.0.0.1:11434/v1。密钥只保存在服务端，接口返回时会脱敏。
          </Text>
          {config?.source === 'env' && (
            <Alert type="info" showIcon message="当前配置来自环境变量；在这里保存后会写入本地数据库。" />
          )}
          <Space>
            <Button onClick={testConnection} loading={testing}>
              测试连接
            </Button>
            <Button type="primary" onClick={saveConfig} loading={saving}>
              保存
            </Button>
          </Space>
        </Space>
      </Modal>
    </>
  )
}

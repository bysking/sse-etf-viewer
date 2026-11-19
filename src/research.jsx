import React, { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Collapse,
  DatePicker,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { ExperimentOutlined, PlayCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { api, postApi } from './api.js'
import { buildResearchOption, buildEquityOption, EVENT_TYPES, EVENT_COLORS } from './researchChart.js'
import { PARAM_GROUPS, defaultParams, buildWyckoffConfig } from './wyckoffParams.js'
import { EChart } from './components/EChart.jsx'

const { RangePicker } = DatePicker
const { Title, Text } = Typography

const MAX_DAYS = 1826
const PARAM_KEY = 'sse-etf-wyckoff-params-v2'
const PRESETS = [
  { key: '1y', label: '近1年', days: 365 },
  { key: '3y', label: '近3年', days: 1095 },
  { key: '5y', label: '近5年', days: 1826 },
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
const pctCell = (v) => <span className={cls(v)}>{pct(v)}</span>

const PRESET_STRATEGIES = [
  { value: 'spring', label: 'Spring 吸筹反转（SOS 止盈）' },
  { value: 'sos', label: 'SOS 突破后持有（结构止损）' },
]

const evidenceText = (e) => {
  const ev = e.evidence || {}
  const keys = ['volZ', 'spreadAtr', 'closePos', 'breakDepthAtr', 'breakAtr', 'reboundAtr', 'pullbackAtr', 'rallyAtr']
  return keys
    .filter((k) => ev[k] != null && Number.isFinite(+ev[k]))
    .map((k) => `${k}=${(+ev[k]).toFixed(2)}`)
    .join(' ')
}

function buildStrategy({ code, preset, includeShares, wyckoff }) {
  const execution = {
    position: { type: 'riskBased', riskPct: 0.01, maxPositionPct: 1.0 },
    feeRate: 0.0003,
    minFee: 5,
    slippageBps: 2,
    lotSize: 100,
    cancelIfInvalidated: true,
  }
  const shareCond = includeShares
    ? [{ shareFlow: { cumulativeDays: 3, gt: 0, requireFresh: true } }]
    : []

  if (preset === 'sos') {
    return {
      symbol: code,
      wyckoff,
      context: { weekly: { enabled: true } },
      shareFlow: { enabled: includeShares },
      entry: {
        all: [
          { event: 'SOS', withinBars: 3 },
          { phase: { in: ['accumulation_D'], minConfidence: 0.55 } },
          ...shareCond,
        ],
      },
      exit: { any: [{ stopLoss: { reference: 'rangeLow', bufferAtr: 0.5 } }] },
      execution,
      initialCash: 100000,
    }
  }

  return {
    symbol: code,
    wyckoff: {},
    context: { weekly: { enabled: true } },
    shareFlow: { enabled: includeShares },
    entry: {
      all: [
        { event: 'Spring', withinBars: 5, require: { closeBackInRange: true } },
        { phase: { in: ['accumulation_C', 'accumulation_D'], minConfidence: 0.5 } },
        ...shareCond,
      ],
    },
    exit: {
      any: [
        { event: 'SOS', withinBars: 4 },
        { event: 'UTAD', withinBars: 3 },
        { stopLoss: { reference: 'eventLow', event: 'Spring', bufferAtr: 0.5 } },
      ],
    },
    execution,
    initialCash: 100000,
  }
}

export function ResearchPage() {
  const [searchVal, setSearchVal] = useState('510300 沪深300ETF')
  const [options, setOptions] = useState([])
  const [code, setCode] = useState('510300')
  const [name, setName] = useState('沪深300ETF')
  const [range, setRange] = useState(() => presetRange('1y'))
  const [includeShares, setIncludeShares] = useState(false)
  const [preset, setPreset] = useState('spring')
  const [initialCash, setInitialCash] = useState(100000)
  const [horizon, setHorizon] = useState(10)
  const [params, setParams] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PARAM_KEY) || 'null')
      return saved && typeof saved === 'object' ? { ...defaultParams(), ...saved } : defaultParams()
    } catch {
      return defaultParams()
    }
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [research, setResearch] = useState(null)
  const [lastQuery, setLastQuery] = useState(null)

  const [btLoading, setBtLoading] = useState(false)
  const [bt, setBt] = useState(null)
  const [btError, setBtError] = useState('')
  const [trades, setTrades] = useState([])

  const sugTimer = useRef(null)
  const pollRef = useRef(null)
  const btToken = useRef(0)
  const didAuto = useRef(false)
  const [msgApi, msgCtx] = message.useMessage()

  const wyckoff = useMemo(() => buildWyckoffConfig(params), [params])
  const paramKey = useMemo(() => JSON.stringify(wyckoff), [wyckoff])
  const currentKey = useMemo(
    () => `${code}|${fmt(range[0])}|${fmt(range[1])}|${includeShares}|${paramKey}`,
    [code, range, includeShares, paramKey],
  )
  const researchMatches = lastQuery?.key === currentKey

  useEffect(() => {
    try {
      localStorage.setItem(PARAM_KEY, JSON.stringify(params))
    } catch {
      /* 忽略写入失败 */
    }
  }, [params])

  async function fetchResearch(from = range[0], to = range[1]) {
    const body = {
      code,
      start: fmt(from),
      end: fmt(to),
      includeShares,
      config: {
        symbol: code,
        wyckoff,
        context: { weekly: { enabled: true } },
        shareFlow: { enabled: includeShares },
      },
    }
    const r = await postApi('/api/research/events', body)
    setResearch(r)
    setLastQuery({
      code,
      start: fmt(from),
      end: fmt(to),
      includeShares,
      key: `${code}|${fmt(from)}|${fmt(to)}|${includeShares}|${paramKey}`,
    })
    return r
  }

  async function runResearch() {
    if (!code) {
      msgApi.warning('请先选择一只 ETF')
      return
    }
    let from = range[0]
    let to = range[1]
    if (to.diff(from, 'day') > MAX_DAYS) {
      from = to.subtract(MAX_DAYS, 'day')
      setRange([from, to])
    }
    setLoading(true)
    setError('')
    setBt(null)
    setBtError('')
    setTrades([])
    try {
      await fetchResearch(from, to)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function runBacktest() {
    if (!code) {
      msgApi.warning('请先选择一只 ETF')
      return
    }
    if (!researchMatches) {
      setLoading(true)
      setError('')
      try {
        await fetchResearch()
      } catch (e) {
        setError(e.message)
        setLoading(false)
        return
      }
      setLoading(false)
    }

    setBtLoading(true)
    setBtError('')
    setBt(null)
    setTrades([])
    try {
      const cfg = buildStrategy({ code, preset, includeShares, wyckoff })
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
            setBtError('回测超时，请缩小回测区间或稍后重试')
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

  useEffect(() => {
    if (didAuto.current) return
    didAuto.current = true
    runResearch()
  }, [])

  useEffect(() => {
    return () => {
      clearTimeout(sugTimer.current)
      clearTimeout(pollRef.current)
      btToken.current++
    }
  }, [])

  const selectCode = (c, n) => {
    setCode(c)
    setName(n || '')
    setSearchVal(n ? `${c} ${n}` : c)
    setOptions([])
    setError('')
    setResearch(null)
    setLastQuery(null)
    setBt(null)
    setTrades([])
  }

  const onSearch = (v) => {
    setSearchVal(v)
    clearTimeout(sugTimer.current)
    const q = String(v).trim()
    if (!q || /^\d{6}$/.test(q)) {
      setOptions([])
      return
    }
    sugTimer.current = setTimeout(async () => {
      try {
        const r = await api('/api/search', { q })
        setOptions(r.items.map((it) => ({ value: it.code, label: `${it.code}  ${it.name}` })))
      } catch {
        /* 搜索失败静默 */
      }
    }, 250)
  }

  const pickSearch = (val) => {
    const opt = options.find((o) => o.value === val)
    if (opt) return selectCode(val, opt.label.replace(/^\d{6}\s+/, ''))
    const m = String(val).trim().match(/^(\d{6})/)
    if (m) return selectCode(m[1], null)
    msgApi.warning('请输入 6 位 ETF 代码，或从下拉列表中选择')
  }

  const onGo = async () => {
    const v = searchVal.trim()
    if (!v) return
    if (/^\d{6}$/.test(v)) {
      selectCode(v, null)
      return
    }
    try {
      const r = await api('/api/search', { q: v })
      if (!r.items.length) {
        msgApi.warning('没有找到匹配的沪市 ETF')
        return
      }
      if (r.items.length === 1) {
        selectCode(r.items[0].code, r.items[0].name)
        return
      }
      setOptions(r.items.map((it) => ({ value: it.code, label: `${it.code}  ${it.name}` })))
      msgApi.info(`找到 ${r.items.length} 只，请在列表中点选`)
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const onPreset = (key) => setRange(presetRange(key))

  const onRange = (vals) => {
    if (!vals?.[0] || !vals?.[1]) return
    let [a, b] = vals
    if (b.diff(a, 'day') > MAX_DAYS) {
      a = b.subtract(MAX_DAYS, 'day')
      msgApi.warning(`最多支持近 5 年，已自动截断为 ${fmt(a)} ~ ${fmt(b)}`)
    }
    setRange([a, b])
  }

  const chartOption = useMemo(
    () =>
      buildResearchOption({
        bars: research?.bars || [],
        events: research?.events || [],
        ranges: research?.ranges || [],
        trades: researchMatches && bt?.status === 'done' ? trades : [],
      }),
    [research, researchMatches, bt?.status, trades],
  )

  const equityOption = useMemo(() => buildEquityOption(bt?.equity || []), [bt])
  const counts = research?.summary?.counts || {}
  const eventRows = useMemo(
    () => (research?.events || []).filter((e) => EVENT_TYPES.includes(e.type)),
    [research],
  )
  const studyRows = useMemo(
    () => (research?.eventStudy?.summary || []).filter((r) => r.horizon === horizon),
    [research, horizon],
  )

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

  const eventColumns = [
    {
      title: '事件',
      dataIndex: 'type',
      width: 84,
      render: (t) => <Tag color={EVENT_COLORS[t] || 'default'}>{t}</Tag>,
    },
    { title: '方向', dataIndex: 'side', width: 82, render: (s) => (s === 'distribution' ? '派发' : s === 'accumulation' ? '吸筹' : '-') },
    { title: '发生日', dataIndex: 'occurredDate', width: 108 },
    { title: '确认日', dataIndex: 'detectedDate', width: 108 },
    { title: '价格', dataIndex: 'price', width: 72, render: (v) => n2(v) },
    { title: '区间', dataIndex: 'rangeId', width: 118, render: (v) => v || '-' },
    { title: '证据', render: (_, r) => <span style={{ color: 'var(--muted)', fontSize: 12 }}>{evidenceText(r) || '-'}</span> },
  ]

  const studyColumns = [
    { title: '事件', dataIndex: 'type', width: 84, render: (t) => <Tag color={EVENT_COLORS[t] || 'default'}>{t}</Tag> },
    { title: '窗口', dataIndex: 'horizon', width: 64 },
    { title: '样本', dataIndex: 'count', width: 64 },
    { title: '平均收益', dataIndex: 'avgReturn', width: 100, render: pctCell },
    { title: '中位数', dataIndex: 'medianReturn', width: 96, render: pctCell },
    { title: '胜率', dataIndex: 'winRate', width: 84, render: pctCell },
    { title: 'MFE', dataIndex: 'avgMfe', width: 84, render: pctCell },
    { title: 'MAE', dataIndex: 'avgMae', width: 84, render: pctCell },
  ]

  const tradeColumns = [
    {
      title: '方向',
      dataIndex: 'side',
      width: 72,
      render: (s) => (s === 'buy' ? <Tag color="red">买入</Tag> : <Tag color="green">卖出</Tag>),
    },
    { title: '成交日', dataIndex: 'date', width: 108 },
    { title: '信号日', dataIndex: 'signalDate', width: 108 },
    { title: '价格', dataIndex: 'price', width: 80, render: (v) => n2(v) },
    { title: '数量', dataIndex: 'qty', width: 84 },
    { title: '手续费', dataIndex: 'fee', width: 84, render: (v) => n2(v) },
    {
      title: '盈亏',
      dataIndex: 'pnl',
      width: 92,
      render: (v) => (v == null ? '-' : <span className={cls(v)}>{n2(v)}</span>),
    },
    { title: '原因', dataIndex: 'reason', width: 100 },
  ]

  return (
    <>
      {msgCtx}
      <main>
        <Title level={2} style={{ margin: '4px 0 2px' }}>
          策略研究 · Wyckoff
        </Title>
        <Text type="secondary" style={{ fontSize: 13 }}>
          事件识别 → 事件研究 → 规则回测。信号按确认日计算，回测按次日开盘成交。
        </Text>

        <section className="search">
          <div className="box">
            <AutoComplete
              value={searchVal}
              options={options}
              onSearch={onSearch}
              onSelect={pickSearch}
              popupMatchSelectWidth
              style={{ flex: 1 }}
              placeholder="输入 ETF 代码或关键词，如 510300 / 沪深300"
            >
              <Input size="large" onPressEnter={onGo} onBlur={() => setTimeout(() => setOptions([]), 150)} />
            </AutoComplete>
            <Button type="primary" size="large" icon={<SearchOutlined />} onClick={onGo}>
              选择
            </Button>
          </div>
          <div className="chips">
            {[
              ['510300', '510300 沪深300ETF'],
              ['510050', '510050 上证50ETF'],
              ['510500', '510500 中证500ETF'],
              ['588000', '588000 科创50ETF'],
            ].map(([c, label]) => (
              <Tag key={c} onClick={() => selectCode(c, label.replace(/^\d{6}\s+/, ''))}>
                {label}
              </Tag>
            ))}
          </div>
        </section>

        <section className="bar">
          <Space size={[6, 6]} wrap>
            {PRESETS.map((p) => (
              <Button key={p.key} size="small" onClick={() => onPreset(p.key)}>
                {p.label}
              </Button>
            ))}
          </Space>
          <RangePicker
            value={range}
            onChange={onRange}
            allowClear={false}
            maxDate={dayjs()}
            disabledDate={(cur) => Boolean(cur && cur.isAfter(dayjs(), 'day'))}
            placeholder={['开始日期', '结束日期']}
          />
          <Checkbox checked={includeShares} onChange={(e) => setIncludeShares(e.target.checked)}>
            纳入份额流（较慢）
          </Checkbox>
          <span className="sp" />
          <Button type="primary" icon={<ExperimentOutlined />} loading={loading} onClick={runResearch}>
            识别事件
          </Button>
        </section>

        {loading && <div className="prog"><i style={{ width: '100%' }} /></div>}
        <div className="status err">{error}</div>

        <section className="panel params-panel">
          <div className="param-head">
            <Space size={8} wrap>
              <Text strong>Wyckoff 参数</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>修改后点「识别事件」重新计算</Text>
            </Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => setParams(defaultParams())}>
              恢复默认
            </Button>
          </div>
          <Collapse
            ghost
            size="small"
            items={PARAM_GROUPS.map((g) => ({
              key: g.title,
              label: (
                <Space size={8}>
                  <Text strong>{g.title}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{g.items.length} 项</Text>
                </Space>
              ),
              children: (
                <div className="params-grid">
                  {g.items.map((it) => (
                    <div className="param" key={it.path}>
                      <span>{it.label}</span>
                      <InputNumber
                        size="small"
                        value={params[it.path]}
                        min={it.min}
                        max={it.max}
                        step={it.step}
                        style={{ width: 96 }}
                        onChange={(v) => {
                          if (v != null) setParams((p) => ({ ...p, [it.path]: v }))
                        }}
                      />
                    </div>
                  ))}
                </div>
              ),
            }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            回测使用同一份参数。阈值建议结合事件研究统计反复校准。
          </Text>
        </section>

        {research?.bars?.length > 0 && (
          <>
            <section className="cards">
              <div className="card">
                <div className="l">标的</div>
                <div className="v">{code}</div>
                <div className="s">{name || research.code}</div>
              </div>
              <div className="card">
                <div className="l">K 线</div>
                <div className="v">{research.bars.length}</div>
                <div className="s">根日 K</div>
              </div>
              <div className="card">
                <div className="l">事件 / 区间</div>
                <div className="v">{research.events.length} / {research.ranges.length}</div>
                <div className="s">确认 / 交易区间</div>
              </div>
              <div className="card">
                <div className="l">当前阶段</div>
                <div className="v">{research.last?.phase || '-'}</div>
                <div className="s">
                  置信度 {n2(research.last?.confidence)}
                  {research.last?.range ? ` · 区间 ${n2(research.last.range.low)}–${n2(research.last.range.high)}` : ''}
                </div>
              </div>
            </section>

            <div className="eventtags">
              {EVENT_TYPES.map((t) => (
                <Tag key={t} color={EVENT_COLORS[t]}>
                  {t} {counts[t] || 0}
                </Tag>
              ))}
            </div>

            <section className="chartwrap" style={{ marginBottom: 12 }}>
              <EChart option={chartOption} height={640} />
            </section>

            <div className="research-grid">
              <section className="panel">
                <Space style={{ marginBottom: 8 }} wrap>
                  <Title level={4} style={{ margin: 0 }}>事件研究</Title>
                  <Select
                    size="small"
                    value={horizon}
                    onChange={setHorizon}
                    options={[5, 10, 20, 60].map((h) => ({ value: h, label: `${h} 日` }))}
                    style={{ width: 96 }}
                  />
                </Space>
                <Table
                  size="small"
                  rowKey={(r) => `${r.type}-${r.horizon}`}
                  columns={studyColumns}
                  dataSource={studyRows}
                  pagination={false}
                  scroll={{ x: 720 }}
                  locale={{ emptyText: '暂无事件研究数据' }}
                />
              </section>

              <section className="panel">
                <Title level={4} style={{ margin: '0 0 8px' }}>事件明细</Title>
                <Table
                  size="small"
                  rowKey={(r) => `${r.type}-${r.detectedIndex}-${r.occurredIndex}`}
                  columns={eventColumns}
                  dataSource={eventRows}
                  pagination={{ pageSize: 8, showSizeChanger: false, size: 'small' }}
                  scroll={{ x: 760 }}
                  locale={{ emptyText: '暂无事件' }}
                />
              </section>
            </div>
          </>
        )}

        <section className="panel" style={{ marginTop: 12 }}>
          <Space style={{ marginBottom: 8 }} wrap>
            <Title level={4} style={{ margin: 0 }}>规则回测</Title>
            <Select
              value={preset}
              onChange={setPreset}
              options={PRESET_STRATEGIES}
              style={{ minWidth: 230 }}
            />
            <Space size={4}>
              <Text type="secondary" style={{ fontSize: 13 }}>初始资金</Text>
              <InputNumber
                value={initialCash}
                onChange={(v) => setInitialCash(v || 100000)}
                min={10000}
                step={10000}
                style={{ width: 150 }}
              />
            </Space>
            <Button type="primary" icon={<PlayCircleOutlined />} loading={btLoading} onClick={runBacktest}>
              运行回测
            </Button>
          </Space>

          {btLoading && (
            <div className="prog">
              <i style={{ width: `${Math.max(2, (bt?.progress || 0) * 100)}%` }} />
            </div>
          )}
          {btError && <Alert type="error" showIcon message={btError} style={{ marginTop: 10 }} />}

          {bt?.status === 'done' && metrics && (
            <>
              <section className="cards" style={{ marginTop: 10 }}>
                {metricCards.map((c) => (
                  <div className="card" key={c[0]}>
                    <div className="l">{c[0]}</div>
                    <div className={`v ${c[3]}`}>{c[1]}</div>
                    <div className="s">{c[2]}</div>
                  </div>
                ))}
              </section>

              <section className="chartwrap" style={{ marginTop: 8 }}>
                <EChart option={equityOption} height={360} />
              </section>

              <div style={{ marginTop: 10 }}>
                <Title level={4} style={{ margin: '0 0 8px' }}>交易明细</Title>
                <Table
                  size="small"
                  rowKey={(r) => `${r.side}-${r.date}-${r.signalIndex}`}
                  columns={tradeColumns}
                  dataSource={trades}
                  pagination={{ pageSize: 8, showSizeChanger: false, size: 'small' }}
                  scroll={{ x: 800 }}
                  locale={{ emptyText: '该区间没有成交' }}
                />
              </div>
            </>
          )}
        </section>

        <footer>
          事件 marker 使用「确认日」，不是价格发生日；回测在确认日收盘出信号、次日开盘成交，含滑点/佣金/T+1。
          复权口径当前为未复权；长周期回测需注意分红缺口。事件阈值仍建议结合事件研究反复校准。
        </footer>
      </main>
    </>
  )
}

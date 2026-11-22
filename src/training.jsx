import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  DeleteOutlined,
  EyeOutlined,
  HistoryOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RiseOutlined,
  BugOutlined,
  UserOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { api, deleteApi, postApi, putApi } from './api.js'
import { EChart } from './components/EChart.jsx'
import { buildTrainingOption } from './trainingChart.js'
import {
  useContextMenuAdvance,
  LONG_PRESS_MS,
  loadBinding,
  saveBinding,
} from './hooks/useContextMenuAdvance.js'
import { KeyDiagnostics } from './components/KeyDiagnostics.jsx'
import { RatioButtons, ratioLabel } from './components/RatioButtons.jsx'

const { Title, Text } = Typography

const USER_KEY = 'sse-etf-training-user'
const SESSION_KEY = 'sse-etf-training-session'
const fmt = (d) => d.format('YYYY-MM-DD')
const n2 = (v) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(2))
const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : (v * 100).toFixed(2) + '%')
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')

const DEFAULT_TIMEFRAMES = [
  { key: '1w', label: '周线' },
  { key: '1d', label: '日线' },
  { key: '60m', label: '60分钟' },
  { key: '30m', label: '30分钟' },
  { key: '15m', label: '15分钟' },
  { key: '5m', label: '5分钟' },
]

const readUser = () => {
  try {
    return localStorage.getItem(USER_KEY) || ''
  } catch {
    return ''
  }
}
const storeUser = (v) => {
  try {
    localStorage.setItem(USER_KEY, v)
  } catch {
    /* 忽略写入失败 */
  }
}

/** 用户名输入：首次进入或想切换身份时用 */
function UserGate({ value, onConfirm, onCancel, open }) {
  const [name, setName] = useState(value || '')
  return (
    <Modal
      open={open}
      title="先给自己起个用户名"
      onCancel={onCancel}
      footer={null}
      maskClosable={false}
      width={440}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="用户名只用来隔离训练记录，没有密码，不涉及权限。"
        description="换一个名字就等于换一套训练记录；同一个名字在任何浏览器都能看到自己的记录。"
      />
      <Space.Compact style={{ width: '100%' }}>
        <Input
          size="large"
          prefix={<UserOutlined />}
          placeholder="例如：老王"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => name.trim() && onConfirm(name.trim())}
        />
        <Button size="large" type="primary" disabled={!name.trim()} onClick={() => onConfirm(name.trim())}>
          开始
        </Button>
      </Space.Compact>
    </Modal>
  )
}

export function TrainingPage() {
  const [user, setUser] = useState(readUser)
  const [userModal, setUserModal] = useState(() => !readUser())
  const [timeframes, setTimeframes] = useState(DEFAULT_TIMEFRAMES)

  // 建会话表单
  const [searchVal, setSearchVal] = useState('')
  const [options, setOptions] = useState([])
  const [symbol, setSymbol] = useState(null) // {code,name}
  const [timeframe, setTimeframe] = useState('1d')
  const [startDate, setStartDate] = useState(() => dayjs().subtract(3, 'year'))
  const [initialCash, setInitialCash] = useState(100000)
  const [positionPct, setPositionPct] = useState(0.3)
  const [creating, setCreating] = useState(false)

  // 训练会话
  const [session, setSession] = useState(null)
  const [bars, setBars] = useState([])
  const [trades, setTrades] = useState([])
  const [snapshot, setSnapshot] = useState(null)
  const [totalBars, setTotalBars] = useState(0)
  const [finished, setFinished] = useState(false)
  const [meta, setMeta] = useState(null) // dataStart / dataEnd / coverage
  const [holding, setHolding] = useState(false)
  const [advancing, setAdvancing] = useState(false)
  // 自定义推进键（部分键盘的菜单键上报字段不在白名单里），存在 localStorage
  const [binding, setBinding] = useState(loadBinding)
  const [showDiag, setShowDiag] = useState(false)

  // 记录管理
  const [sessions, setSessions] = useState([])
  const [listLoading, setListLoading] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [error, setError] = useState('')
  const [msgApi, msgCtx] = message.useMessage()

  const chartRef = useRef(null)
  // 鼠标右键推进只在图表区域内生效，避免误触到表单/按钮
  const chartWrapRef = useRef(null)
  const chartOptionRef = useRef(null)
  // 待推进根数（连发时累加）与「是否有请求在飞」，由 pump 串行排空
  const pendingRef = useRef(0)
  const pumpRef = useRef(false)
  // 把 session / finished 放 ref，避免 pump 里的闭包读到旧值
  const sessionRef = useRef(null)
  const finishedRef = useRef(false)
  const stepTimer = useRef(null)
  const searchTimer = useRef(null)

  /* ---------------- 数据加载 ---------------- */

  useEffect(() => {
    api('/api/training/timeframes')
      .then((r) => setTimeframes(r.items?.length ? r.items : DEFAULT_TIMEFRAMES))
      .catch(() => {})
  }, [])

  const loadSessions = useCallback(async () => {
    if (!user) return
    setListLoading(true)
    try {
      const r = await api('/api/training/sessions', { user })
      setSessions(r.items || [])
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setListLoading(false)
    }
  }, [user, msgApi])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // 刷新/重进页面时恢复上次的训练现场，避免游标与持仓看起来「丢了」
  const didRestore = useRef(false)
  useEffect(() => {
    if (didRestore.current || !user) return
    didRestore.current = true
    let id = ''
    try {
      id = localStorage.getItem(SESSION_KEY) || ''
    } catch {
      id = ''
    }
    if (id) openSession(id)
  }, [user])

  // 同步到 ref：pump / onStep 是稳定引用，不能依赖 state 闭包
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  useEffect(() => {
    finishedRef.current = finished
  }, [finished])

  const confirmUser = (name) => {
    setUser(name)
    storeUser(name)
    setUserModal(false)
  }

  /* ---------------- 证券搜索 ---------------- */

  const onSearch = (v) => {
    setSearchVal(v)
    clearTimeout(searchTimer.current)
    const key = String(v || '').trim()
    if (!key) {
      setOptions([])
      return
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await api('/api/training/universe', { q: key })
        setOptions(
          (r.items || []).map((it) => ({
            value: it.code,
            label: `${it.code}  ${it.name}${it.type === 'etf' ? ' · ETF' : ` · ${it.board || '股票'}`}`,
          })),
        )
      } catch (e) {
        msgApi.error(e.message)
      }
    }, 300)
  }

  const onPickSymbol = (val) => {
    const opt = options.find((o) => o.value === val)
    const code = String(val).trim().match(/^(\d{6})/)?.[1]
    if (!code) {
      msgApi.warning('请输入 6 位沪市代码，或从下拉列表里选')
      return
    }
    const name = opt ? opt.label.replace(/^\d{6}\s+/, '').replace(/\s*·.*$/, '') : ''
    setSymbol({ code, name })
    setSearchVal(opt ? opt.label : `${code} ${name}`.trim())
    setOptions([])
  }

  /* ---------------- 开始训练 ---------------- */

  const startTraining = async () => {
    if (!user) {
      setUserModal(true)
      return
    }
    if (!symbol?.code) {
      msgApi.warning('请先搜索并选择标的')
      return
    }
    setCreating(true)
    setError('')
    try {
      const r = await postApi('/api/training/sessions', {
        user,
        symbol: symbol.code,
        symbolName: symbol.name || null,
        timeframe,
        startDate: fmt(startDate),
        initialCash: Number(initialCash) || 100000,
        positionPct: Number(positionPct) || 0.3,
      })
      // 建会话后立刻拉取初始可见窗口
      await openSession(r.session.id, r)
      loadSessions()
      msgApi.success(`已开始：${r.totalBars} 根 K 线，实际起点 ${r.actualStart}`)
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  const openSession = async (id, created = null) => {
    setError('')
    try {
      const state = await api(`/api/training/sessions/${id}`, { user })
      const win = await api(`/api/training/sessions/${id}/bars`, { user })
      const tr = await api(`/api/training/sessions/${id}/trades`, { user })
      setSession(state.session)
      setBars(win.bars || [])
      setTrades(tr.items || [])
      setSnapshot(win.snapshot || state.snapshot)
      setTotalBars(win.totalBars ?? state.totalBars ?? 0)
      setFinished(Boolean(win.cursor >= (win.totalBars ?? 0)))
      try {
        localStorage.setItem(SESSION_KEY, id)
      } catch {
        /* 忽略写入失败 */
      }
      setMeta({
        dataStart: state.dataStart ?? created?.dataStart,
        dataEnd: state.dataEnd ?? created?.dataEnd,
        coverage: state.coverage ?? created?.coverage,
        requestedStart: created?.requestedStart ?? state.session.startDate,
        actualStart: created?.actualStart ?? state.session.actualStart,
      })
    } catch (e) {
      setError(e.message)
    }
  }

  /* ---------------- 推进 ---------------- */

  // 推进请求的「单飞 + 排空」循环：
  // 连发时每 150ms 会攒一次待推进根数，但如果同时发多个请求，会让服务端游标与前端 bars 错序，
  // 所以同一时刻只允许一个请求在飞，其余累加到 pendingRef，等当前请求回来再一次性发走。
  const pump = useCallback(async () => {
    if (pumpRef.current) return
    pumpRef.current = true
    setAdvancing(true)
    try {
      while (pendingRef.current > 0 && sessionRef.current?.id && !finishedRef.current) {
        const steps = Math.min(50, pendingRef.current)
        pendingRef.current -= steps
        const sid = sessionRef.current.id
        try {
          const r = await postApi(`/api/training/sessions/${sid}/advance`, { user, steps })
          if (sessionRef.current?.id !== sid) return
          if (r.added?.length) setBars((prev) => prev.concat(r.added))
          setSnapshot(r.snapshot)
          setTotalBars(r.totalBars)
          setFinished(Boolean(r.finished))
          finishedRef.current = Boolean(r.finished)
          setSession((s) => (s ? { ...s, cursor: r.cursor, status: r.session?.status ?? s.status } : s))
          if (r.finished) {
            pendingRef.current = 0
            msgApi.info('已到最后一根 K 线，本次训练结束')
          }
        } catch (e) {
          msgApi.error(e.message)
          pendingRef.current = 0
        }
      }
    } finally {
      pumpRef.current = false
      setAdvancing(false)
    }
  }, [user, msgApi])

  const doAdvance = useCallback(
    (steps = 1) => {
      if (!sessionRef.current?.id || finishedRef.current) return
      pendingRef.current += Math.max(1, steps)
      pump()
    },
    [pump],
  )

  // 右键推进：单击一根，长按 400ms 后每 150ms 一根。
  // 连发期间把「一根」累加进 pendingRef，由 pump 合并成批量请求，避免高频打爆后端。
  const onStep = useCallback(() => {
    if (!sessionRef.current?.id || finishedRef.current) return
    pendingRef.current += 1
    // 攒 40ms 再发，连发时能把多根合并成一次请求
    if (stepTimer.current) return
    stepTimer.current = setTimeout(() => {
      stepTimer.current = null
      pump()
    }, 40)
  }, [pump])

  useContextMenuAdvance({
    onStep,
    enabled: Boolean(session?.id) && !finished,
    onHoldingChange: setHolding,
    targetRef: chartWrapRef,
    binding,
  })

  const changeBinding = useCallback((b) => {
    setBinding(b)
    saveBinding(b)
  }, [])

  /* ---------------- 下单 ---------------- */

  /**
   * 下单。ratio 语义：
   *   买入 = 本次使用的现金比例（null 则用会话默认仓位）
   *   卖出 = 本次卖出的持仓比例（null 则清空全部持仓）
   */
  const trade = async (side, ratio = null) => {
    if (!session?.id) return
    try {
      const r = await postApi(`/api/training/sessions/${session.id}/trades`, {
        user,
        side,
        ratio: ratio == null ? null : Number(ratio),
      })
      setTrades((prev) => prev.concat([r.trade]))
      setSnapshot(r.snapshot)
      setSession((s) => (s ? { ...s, ...r.session, cursor: r.cursor } : s))
      setTotalBars(r.totalBars)
      setFinished(Boolean(r.finished))
      const label = ratio == null ? '' : `（${ratioLabel(ratio)}）`
      if (side === 'buy') msgApi.success(`买入 ${r.trade.qty} 份 @ ${n2(r.trade.price)}${label}`)
      else msgApi.success(`卖出 ${r.trade.qty} 份 @ ${n2(r.trade.price)}${label}${r.pnl != null ? `，盈亏 ${n2(r.pnl)}` : ''}`)
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const endSession = async () => {
    if (!session?.id) return
    try {
      await putApi(`/api/training/sessions/${session.id}`, { user, title: session.title })
      setSession((s) => (s ? { ...s, status: 'finished' } : s))
      msgApi.success('已结束本次训练，成绩已保存')
      loadSessions()
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const removeSession = async (id) => {
    try {
      await deleteApi(`/api/training/sessions/${id}?user=${encodeURIComponent(user)}`)
      msgApi.success('已删除')
      if (session?.id === id) resetTraining()
      loadSessions()
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const resetTraining = () => {
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch {
      /* 忽略 */
    }
    setSession(null)
    setBars([])
    setTrades([])
    setSnapshot(null)
    setTotalBars(0)
    setFinished(false)
    setMeta(null)
  }

  const openDetail = async (id) => {
    setDetailLoading(true)
    setDetail({ id })
    try {
      const r = await api(`/api/training/sessions/${id}`, { user, detail: 1 })
      setDetail({ ...r, id })
    } catch (e) {
      msgApi.error(e.message)
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  /* ---------------- 图表 ---------------- */

  const chartOption = useMemo(
    () => buildTrainingOption({ bars, trades, avgCost: snapshot?.avgCost || 0 }),
    [bars, trades, snapshot?.avgCost],
  )

  useEffect(() => {
    const inst = chartRef.current
    if (!inst) return
    // bars 追加时保留用户的缩放状态，避免每次推进都跳回尾部
    const prev = chartOptionRef.current
    const sameTimes = prev && prev.series?.[0]?.data?.length <= (chartOption.series?.[0]?.data?.length || 0)
    if (sameTimes && prev) {
      const dz = inst.getOption?.()?.dataZoom?.[0]
      inst.setOption(chartOption, { replaceMerge: ['series'] })
      if (dz) inst.dispatchAction({ type: 'dataZoom', start: dz.start, end: dz.end })
    } else {
      inst.setOption(chartOption, true)
    }
    chartOptionRef.current = chartOption
  }, [chartOption])

  /* ---------------- 派生展示值 ---------------- */

  const lastBar = bars[bars.length - 1]
  const progress = totalBars > 0 ? Math.min(1, bars.length / totalBars) : 0
  const activeSession = session && !finished
  const tfLabel = timeframes.find((t) => t.key === (session?.timeframe || timeframe))?.label || ''

  const tradeColumns = [
    { title: '#', dataIndex: 'seq', width: 50 },
    {
      title: '方向',
      dataIndex: 'side',
      width: 70,
      render: (s) => (s === 'buy' ? <Tag color="red">买入</Tag> : <Tag color="green">卖出</Tag>),
    },
    {
      title: '比例',
      dataIndex: 'ratio',
      width: 76,
      render: (v, r) =>
        v == null ? (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>-</span>
        ) : (
          <Tag color={r.side === 'buy' ? 'red' : 'green'}>{ratioLabel(v)}</Tag>
        ),
    },
    { title: '时间', dataIndex: 'barTs', width: 150 },
    { title: '价格', dataIndex: 'price', width: 90, render: (v) => n2(v) },
    { title: '数量', dataIndex: 'qty', width: 80 },
    {
      title: '盈亏',
      dataIndex: 'pnl',
      width: 96,
      render: (v) => (v == null ? '-' : <span className={cls(v)}>{n2(v)}</span>),
    },
    { title: '成交后现金', dataIndex: 'cashAfter', width: 116, render: (v) => n2(v) },
    { title: '成交后持仓', dataIndex: 'unitsAfter', width: 106 },
  ]

  const sessionColumns = [
    {
      title: '标的',
      render: (_, s) => (
        <div>
          <div style={{ fontWeight: 500 }}>
            {s.symbolName || s.symbol} <span style={{ color: 'var(--muted)', fontSize: 12 }}>{s.symbol}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {timeframes.find((t) => t.key === s.timeframe)?.label || s.timeframe} · 起始 {s.actualStart}
          </div>
        </div>
      ),
    },
    { title: '初始资金', dataIndex: 'initialCash', width: 110, render: (v) => n2(v) },
    { title: '仓位', dataIndex: 'positionPct', width: 76, render: (v) => pct(v) },
    {
      title: '进度',
      width: 100,
      render: (_, s) => <span style={{ fontSize: 12 }}>{s.cursor} 根</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s) => (s === 'finished' ? <Tag>已完成</Tag> : <Tag color="green">进行中</Tag>),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (v) => String(v).replace('T', ' ').slice(0, 19),
    },
    {
      title: '操作',
      width: 170,
      render: (_, s) => (
        <Space size={4}>
          <Button size="small" icon={<PlayCircleOutlined />} onClick={() => openSession(s.id)}>
            继续
          </Button>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(s.id)}>
            回看
          </Button>
          <Popconfirm title="删除后不可恢复，确认？" onConfirm={() => removeSession(s.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      {msgCtx}
      <UserGate open={userModal} value={user} onConfirm={confirmUser} onCancel={() => setUserModal(false)} />

      <main>
        <div className="ai-head">
          <div>
            <Title level={2} style={{ margin: '4px 0 2px' }}>
              人工模拟训练
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              选标的与周期 → 指定开始日期 → 按方向键 → 逐根揭示 K 线 → 买卖决策 → 保存复盘。
            </Text>
          </div>
          <Space wrap>
            <Tag icon={<UserOutlined />} color="blue">
              {user || '未命名'}
            </Tag>
            <Button size="small" onClick={() => setUserModal(true)}>
              切换用户
            </Button>
          </Space>
        </div>

        {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}

        {/* 建会话 */}
        <section className="panel" style={{ marginTop: 12 }}>
          <Space size={[10, 8]} wrap align="end">
            <span className="suggest-field">
              <Text type="secondary" style={{ fontSize: 12 }}>标的</Text>
              <AutoComplete
                value={searchVal}
                options={options}
                onSearch={onSearch}
                onSelect={onPickSymbol}
                style={{ width: 260 }}
                placeholder="沪市代码或名称，如 510300 / 茅台 / 600519"
              >
                <Input onPressEnter={() => onPickSymbol(searchVal)} />
              </AutoComplete>
            </span>
            <span className="suggest-field">
              <Text type="secondary" style={{ fontSize: 12 }}>周期</Text>
              <Select
                value={timeframe}
                onChange={setTimeframe}
                style={{ width: 118 }}
                options={timeframes.map((t) => ({ value: t.key, label: t.label }))}
              />
            </span>
            <span className="suggest-field">
              <Text type="secondary" style={{ fontSize: 12 }}>开始日期</Text>
              <DatePicker
                value={startDate}
                onChange={(v) => v && setStartDate(v)}
                allowClear={false}
                disabledDate={(cur) => Boolean(cur && cur.isAfter(dayjs(), 'day'))}
                style={{ width: 138 }}
              />
            </span>
            <span className="suggest-field">
              <Text type="secondary" style={{ fontSize: 12 }}>初始资金</Text>
              <InputNumber
                value={initialCash}
                onChange={(v) => setInitialCash(v || 100000)}
                min={10000}
                step={10000}
                style={{ width: 130 }}
              />
            </span>
            <span className="suggest-field">
              <Text type="secondary" style={{ fontSize: 12 }}>每次买入仓位</Text>
              <InputNumber
                value={Math.round(positionPct * 100)}
                onChange={(v) => setPositionPct(Math.min(100, Math.max(1, v || 10)) / 100)}
                min={1}
                max={100}
                step={5}
                addonAfter="%"
                style={{ width: 116 }}
              />
            </span>
            <Button type="primary" icon={<PlayCircleOutlined />} loading={creating} onClick={startTraining}>
              开始训练
            </Button>
          </Space>
          <div className="status" style={{ marginBottom: 0, marginTop: 8 }}>
            「每次买入仓位」是会话默认仓位；训练时还可以在买卖按钮上临时选 1/10、1/5、1/4、1/3、1/2 或自定义比例。
            买入基数是当前可用现金，卖出基数是当前持仓，数量都向下取整到 100 份；成交价用当前 K 线收盘价，不计费用。
          </div>
        </section>

        {/* 训练区 */}
        {session && (
          <>
            <section className="cards" style={{ marginTop: 12 }}>
              <div className="card">
                <div className="l">总资产</div>
                <div className={`v ${cls(snapshot?.totalReturn)}`}>{n2(snapshot?.equity)}</div>
                <div className="s">
                  收益 {pct(snapshot?.totalReturn)} · 初始 {n2(session.initialCash)}
                </div>
              </div>
              <div className="card">
                <div className="l">现金 / 持仓</div>
                <div className="v">{n2(snapshot?.cash)}</div>
                <div className="s">
                  {snapshot?.units || 0} 份 · 成本 {n2(snapshot?.avgCost)}
                </div>
              </div>
              <div className="card">
                <div className="l">浮动盈亏</div>
                <div className={`v ${cls(snapshot?.unrealized)}`}>{n2(snapshot?.unrealized)}</div>
                <div className="s">仓位 {pct(snapshot?.positionPct)}</div>
              </div>
              <div className="card">
                <div className="l">当前 K 线</div>
                <div className="v" style={{ fontSize: 16 }}>
                  {lastBar ? lastBar.ts : '-'}
                </div>
                <div className="s">
                  收 {n2(lastBar?.close)} · {bars.length} / {totalBars} 根
                </div>
              </div>
            </section>

            <section className="panel" style={{ marginTop: 12 }}>
              <Space size={[10, 8]} wrap style={{ marginBottom: 10 }}>
                <Text strong>
                  {session.symbolName || session.symbol} · {tfLabel}
                </Text>
                {activeSession ? (
                  <Tag color={holding ? 'processing' : 'green'} icon={holding ? <RiseOutlined /> : <PauseCircleOutlined />}>
                    {holding ? '连发中…' : '按 → 推进'}
                  </Tag>
                ) : (
                  <Tag>训练已结束</Tag>
                )}
                <Button size="small" onClick={() => doAdvance(1)} disabled={!activeSession || advancing}>
                  前进一根
                </Button>
                <Button size="small" onClick={() => doAdvance(10)} disabled={!activeSession || advancing}>
                  快进 10 根
                </Button>
                <RatioButtons
                  side="buy"
                  positionPct={session.positionPct}
                  disabled={!session || (snapshot?.cash || 0) <= 0}
                  onExec={(ratio) => trade('buy', ratio)}
                />
                <RatioButtons
                  side="sell"
                  disabled={!session || !snapshot?.units}
                  onExec={(ratio) => trade('sell', ratio)}
                />
                <span className="sp" />
                <Button size="small" icon={<PauseCircleOutlined />} onClick={endSession} disabled={session.status === 'finished'}>
                  结束并保存
                </Button>
                <Button size="small" icon={<ReloadOutlined />} onClick={resetTraining}>
                  回到列表
                </Button>
                <Button size="small" icon={<BugOutlined />} onClick={() => setShowDiag((v) => !v)}>
                  键盘诊断
                </Button>
              </Space>

              <div className="prog">
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <div className="status" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span>
                  进度 {bars.length} / {totalBars} 根
                </span>
                <span>
                  数据范围 {meta?.dataStart} ~ {meta?.dataEnd}
                </span>
                {meta?.coverage?.text && <span>{tfLabel} 历史约 {meta.coverage.text}</span>}
                {meta?.requestedStart && meta?.actualStart && meta.requestedStart !== meta.actualStart && (
                  <span style={{ color: 'var(--idx)' }}>
                    你选的 {meta.requestedStart} 早于可用数据，已从 {String(meta.actualStart).slice(0, 10)} 开始
                  </span>
                )}
              </div>

              <div ref={chartWrapRef} className="training-chart">
                <EChart ref={chartRef} option={chartOption} height={520} />
              </div>

              <KeyDiagnostics open={showDiag} binding={binding} onBindingChange={changeBinding} />

              <Alert
                type="info"
                showIcon
                style={{ marginTop: 10 }}
                message={`推进：按键盘方向键 → 或点鼠标右键（在图表上）；按一下前进一根，按住超过 ${LONG_PRESS_MS}ms 自动连发，松开即停。`}
                description="为防止偷看未来，未推进的 K 线不会下发到浏览器；后端也不会返回游标之后的任何数据。若按键没反应，点「键盘诊断」录一个自定义推进键。"
              />
            </section>

            <section className="panel" style={{ marginTop: 12 }}>
              <Title level={5} style={{ marginTop: 0 }}>
                本次成交（{trades.length} 笔）
              </Title>
              <Table
                size="small"
                rowKey="id"
                columns={tradeColumns}
                dataSource={trades}
                pagination={{ pageSize: 8, size: 'small' }}
                scroll={{ x: 780 }}
                locale={{ emptyText: '还没有成交' }}
              />
            </section>
          </>
        )}

        {/* 记录列表 */}
        <section className="panel" style={{ marginTop: 12 }}>
          <Space style={{ marginBottom: 8 }} wrap>
            <HistoryOutlined />
            <Text strong>我的训练记录</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {user ? `用户 ${user}` : '先输入用户名'}
            </Text>
            <Button size="small" icon={<ReloadOutlined />} loading={listLoading} onClick={loadSessions}>
              刷新
            </Button>
          </Space>
          <Table
            size="small"
            rowKey="id"
            columns={sessionColumns}
            dataSource={sessions}
            loading={listLoading}
            pagination={{ pageSize: 8, size: 'small' }}
            scroll={{ x: 900 }}
            locale={{ emptyText: '还没有训练记录；上面选好标的点「开始训练」' }}
          />
        </section>

        <footer>
          训练只用当前标的已推进的 K 线，买卖按收盘价成交、不计费用，用于练形态与纪律，不代表任何投资建议。
          分钟周期受上游接口限制，历史只有约 1 年；深市代码（000/002/300/159 开头）不支持。
        </footer>
      </main>

      {/* 回看抽屉 */}
      <Drawer
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        width={1000}
        title={detail?.session ? `回看：${detail.session.symbolName || detail.session.symbol} · ${detail.session.timeframe}` : '回看'}
      >
        {detailLoading && <div className="page-loading">加载中…</div>}
        {detail?.session && !detailLoading && (
          <>
            <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="初始资金">{n2(detail.session.initialCash)}</Descriptions.Item>
              <Descriptions.Item label="仓位比例">{pct(detail.session.positionPct)}</Descriptions.Item>
              <Descriptions.Item label="起始">{detail.session.actualStart}</Descriptions.Item>
              <Descriptions.Item label="区间">{`${detail.dataStart} ~ ${detail.dataEnd}`}</Descriptions.Item>
              <Descriptions.Item label="最终资产">{n2(detail.summary?.equity)}</Descriptions.Item>
              <Descriptions.Item label="总收益">
                <span className={cls(detail.summary?.totalReturn)}>{pct(detail.summary?.totalReturn)}</span>
              </Descriptions.Item>
              <Descriptions.Item label="买入持有">
                <span className={cls(detail.summary?.buyHold)}>{pct(detail.summary?.buyHold)}</span>
              </Descriptions.Item>
              <Descriptions.Item label="胜率">
                {detail.summary?.winRate == null ? '-' : pct(detail.summary.winRate)}
              </Descriptions.Item>
            </Descriptions>
            <EChart
              option={buildTrainingOption({
                bars: detail.bars || [],
                trades: detail.trades || [],
                avgCost: detail.session.avgCost || 0,
              })}
              height={420}
            />
            <Title level={5}>成交记录</Title>
            <Table
              size="small"
              rowKey="id"
              columns={tradeColumns}
              dataSource={detail.trades || []}
              pagination={{ pageSize: 10, size: 'small' }}
              scroll={{ x: 780 }}
              locale={{ emptyText: '这次训练没有成交' }}
            />
          </>
        )}
      </Drawer>
    </>
  )
}

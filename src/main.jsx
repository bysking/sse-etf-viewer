import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import dayjs from 'dayjs'
import {
  ConfigProvider,
  DatePicker,
  AutoComplete,
  Button,
  Input,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
  theme as antdTheme,
} from 'antd'
import { StarFilled, StarOutlined, CloseOutlined } from '@ant-design/icons'
import { api } from './api.js'
import { echarts, prepare, computeStats, buildOption } from './chart.js'
import { INDICES, DEFAULT_INDEX, indexName } from './indices.js'
import { ResearchPage } from './research.jsx'
import './style.css'

const { RangePicker } = DatePicker
const { Text, Title } = Typography

/* ---------- 时间范围 ---------- */
// 后端 MAX_RANGE_DAYS = 1830，前端最多请求近 5 年（1826 天 ≈ 5 年）
const MAX_DAYS = 1826
const PRESETS = [
  { key: '1m', label: '近1月', days: 30 },
  { key: '3m', label: '近3月', days: 90 },
  { key: '6m', label: '近6月', days: 180 },
  { key: '1y', label: '近1年', days: 365 },
  { key: '2y', label: '近2年', days: 730 },
  { key: '3y', label: '近3年', days: 1095 },
  { key: '5y', label: '近5年', days: 1826 },
]
const DEFAULT_PRESET = '3m'

const fmt = (d) => d.format('YYYY-MM-DD')
const presetRange = (key) => {
  const p = PRESETS.find((x) => x.key === key) || PRESETS.find((x) => x.key === DEFAULT_PRESET)
  const end = dayjs()
  return [end.subtract(Math.min(p.days, MAX_DAYS), 'day'), end]
}

/* ---------- 本地存储：收藏 + 上次查询 ---------- */
const FAV_KEY = 'sse-etf-favs'
const LAST_KEY = 'sse-etf-last'
const FAV_MAX = 30

function loadFavs() {
  try {
    const a = JSON.parse(localStorage.getItem(FAV_KEY) || '[]')
    return Array.isArray(a)
      ? a.filter((x) => x && /^\d{6}$/.test(x.code)).map((x) => ({ code: x.code, name: String(x.name || '') }))
      : []
  } catch {
    return []
  }
}
const loadLast = () => {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) || 'null')
  } catch {
    return null
  }
}
const store = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* 隐私模式等场景写入失败，忽略即可 */
  }
}

/* ---------- 图表 ---------- */
function Chart({ series, norm, idxLabel }) {
  const ref = useRef(null)
  const inst = useRef(null)

  useEffect(() => {
    inst.current = echarts.init(ref.current)
    const onResize = () => inst.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      inst.current?.dispose()
      inst.current = null
    }
  }, [])

  const option = useMemo(() => buildOption(series, { norm }, idxLabel), [series, norm, idxLabel])
  useEffect(() => {
    inst.current?.setOption(option, true)
  }, [option])

  return <div className="chart" ref={ref} />
}

/* ---------- 主应用 ---------- */
function ViewerPage() {
  const seed = useRef(loadLast())
  const s = seed.current
  const hasLast = Boolean(s?.code && /^\d{6}$/.test(s.code))

  const [favs, setFavs] = useState(loadFavs)
  const [code, setCode] = useState(() => (hasLast ? s.code : null))
  const [name, setName] = useState(() => (hasLast ? s.name || '' : ''))
  const [preset, setPreset] = useState(() => (hasLast && s.preset ? s.preset : DEFAULT_PRESET))
  const [range, setRange] = useState(() =>
    hasLast && s.start && s.end ? [dayjs(s.start), dayjs(s.end)] : presetRange(hasLast && s.preset ? s.preset : DEFAULT_PRESET),
  )
  const [idxCode, setIdxCode] = useState(() => (hasLast && s.idxCode ? s.idxCode : DEFAULT_INDEX))
  const [norm, setNorm] = useState(false)

  const [searchVal, setSearchVal] = useState(() => (hasLast ? `${s.code} ${s.name || ''}`.trim() : ''))
  const [options, setOptions] = useState([])
  const [shares, setShares] = useState([])
  const [index, setIndex] = useState([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(null)
  const [failed, setFailed] = useState(0)
  const [lastErr, setLastErr] = useState(null)
  const [error, setError] = useState('') // 致命错误（整段加载失败）
  const [note, setNote] = useState('') // 提示性文案（收藏等）

  const token = useRef(0)
  const sugTimer = useRef(null)
  const [msgApi, msgCtx] = message.useMessage()

  // 收藏 & 上次查询持久化
  useEffect(() => {
    store(FAV_KEY, favs)
  }, [favs])
  useEffect(() => {
    if (code) store(LAST_KEY, { code, name, preset, start: fmt(range[0]), end: fmt(range[1]), idxCode })
  }, [code, name, preset, range, idxCode])

  const idxLabel = indexName(idxCode)
  const series = useMemo(() => prepare({ shares, index }), [shares, index])
  const cards = useMemo(() => computeStats(series, idxLabel), [series, idxLabel])
  const got = useMemo(() => shares.filter(([, v]) => v != null).length, [shares])
  const isFav = code ? favs.some((f) => f.code === code) : false

  /* ---------- 状态文案：由数据推导，避免多份状态不同步 ---------- */
  const status = useMemo(() => {
    if (error) return { text: error, kind: 'err' }
    if (note) return { text: note, kind: '' }
    if (!code) return { text: '输入代码或关键词开始查询；查询后可点 ☆ 收藏，下次一键查看。', kind: '' }
    if (loading) return { text: null, kind: '' }
    if (!got) return { text: `该区间没有 ${code} 的份额数据：请确认是沪市 ETF（5 开头）。`, kind: 'err' }
    const gaps = shares.length - got
    if (failed) {
      return { text: `已加载 ${got} 个交易日，但有 ${failed} 个交易日请求失败（${lastErr}），图中已按空值断开，稍后重试即可补齐。`, kind: 'err' }
    }
    if (gaps) return { text: `已加载 ${got} 个交易日；另有 ${gaps} 个自然日无数据（节假日或未上市），已按空值处理。`, kind: '' }
    return { text: `已加载 ${got} 个交易日的份额数据。`, kind: '' }
  }, [error, note, code, loading, got, shares.length, failed, lastErr])

  /* ---------- 搜索 ---------- */
  const runSearch = async (q) => {
    try {
      const r = await api('/api/search', { q })
      setOptions(r.items.map((it) => ({ value: it.code, label: `${it.code}  ${it.name}` })))
      return r.items
    } catch (e) {
      setError(e.message)
      return null
    }
  }

  const onSearch = (v) => {
    setSearchVal(v)
    setNote('')
    clearTimeout(sugTimer.current)
    const q = v.trim()
    if (!q || /^\d{6}$/.test(q)) {
      setOptions([])
      return
    }
    sugTimer.current = setTimeout(() => runSearch(q), 250)
  }

  const selectCode = useCallback((c, n) => {
    setCode(c)
    setName(n || '')
    setSearchVal(n ? `${c} ${n}` : c)
    setOptions([])
    setError('')
    setNote('')
  }, [])

  const pickSearch = (val) => {
    const opt = options.find((o) => o.value === val)
    if (opt) return selectCode(val, opt.label.replace(/^\d{6}\s+/, ''))
    const m = String(val).trim().match(/^(\d{6})/)
    if (m) return selectCode(m[1], null)
    setError('请输入 6 位 ETF 代码，或从下拉列表中选择。')
  }

  const onGo = async () => {
    const v = searchVal.trim()
    if (!v) return
    if (/^\d{6}$/.test(v)) return selectCode(v, null)
    setError('')
    const items = await runSearch(v)
    if (!items) return
    if (!items.length) {
      setError('没有找到匹配的沪市 ETF，换个关键词试试。')
      setOptions([])
    } else if (items.length === 1) selectCode(items[0].code, items[0].name)
    else setNote(`找到 ${items.length} 只，请在列表中点选。`)
  }

  /* ---------- 加载数据 ---------- */
  useEffect(() => {
    if (!code) return

    // 防御性截断：无论区间怎么设置（含手动输入），请求窗口都不超过 5 年，
    // 并同步回输入框，保证界面显示与请求范围一致。放在最前，避免先清空再重载造成闪烁。
    let from = range[0]
    const to = range[1]
    if (to.diff(from, 'day') > MAX_DAYS) {
      from = to.subtract(MAX_DAYS, 'day')
      setRange([from, to])
      // 用 toast 提示：下面的 setNote('') 会清掉状态栏文案，toast 不受影响
      msgApi.warning(`最多支持近 5 年，已自动截断为 ${fmt(from)} ~ ${fmt(to)}。`)
      return // range 变更后会重新进入本 effect 并正常加载
    }

    const my = ++token.current
    setShares([])
    setIndex([])
    setLoading(true)
    setError('')
    setNote('')
    setFailed(0)
    setLastErr(null)
    setProgress(0.02)

    const start = fmt(from)
    const end = fmt(to)
    // 份额接口一天一次请求：按月分块拉取，边拉边画，长区间也能持续看到进度
    const chunks = []
    for (let cur = from; !cur.isAfter(to); ) {
      let ce = cur.add(30, 'day')
      if (ce.isAfter(to)) ce = to
      chunks.push([fmt(cur), fmt(ce)])
      cur = ce.add(1, 'day')
    }

    ;(async () => {
      try {
        const idx = await api('/api/index', { code: idxCode, start, end })
        if (my !== token.current) return
        setIndex(idx.series)
        let nFailed = 0
        let nErr = null
        for (let i = 0; i < chunks.length; i++) {
          const r = await api('/api/shares', { code, start: chunks[i][0], end: chunks[i][1] })
          if (my !== token.current) return
          setShares((prev) => [...prev, ...r.series])
          if (r.name) setName((n) => n || r.name)
          nFailed += r.failed
          if (r.error) nErr = r.error
          setProgress((i + 1) / chunks.length)
        }
        if (my !== token.current) return
        setFailed(nFailed)
        setLastErr(nErr)
      } catch (e) {
        if (my !== token.current) return
        setError(e.message)
      } finally {
        if (my === token.current) {
          setLoading(false)
          setProgress(null)
        }
      }
    })()
  }, [code, range, idxCode])

  // 补上收藏项缺失的简称
  useEffect(() => {
    if (!name || !code) return
    setFavs((fs) => {
      const f = fs.find((x) => x.code === code)
      if (!f || f.name === name) return fs
      return fs.map((x) => (x.code === code ? { ...x, name } : x))
    })
  }, [name, code])

  /* ---------- 交互 ---------- */
  const unfav = (c) => {
    setFavs((fs) => fs.filter((f) => f.code !== c))
    setNote(`已取消收藏 ${c}。`)
  }
  const toggleFav = () => {
    if (!code) return
    if (isFav) return unfav(code)
    setFavs((fs) => [{ code, name }, ...fs.filter((f) => f.code !== code)].slice(0, FAV_MAX))
    setNote(`已收藏 ${code}${name ? ' ' + name : ''}，下次点击收藏区即可快速查看。`)
  }

  // 快捷键 F 收藏
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'f' && e.key !== 'F') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!code) return
      e.preventDefault()
      toggleFav()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onPreset = (key) => {
    setPreset(key)
    setRange(presetRange(key))
  }
  const onRange = (vals) => {
    if (!vals?.[0] || !vals?.[1]) return
    let [a, b] = vals
    let days = b.diff(a, 'day')
    if (days > MAX_DAYS) {
      msgApi.warning(`最多支持近 5 年，已自动截断为近 ${MAX_DAYS} 天。`)
      a = b.subtract(MAX_DAYS, 'day')
      days = MAX_DAYS
    }
    setRange([a, b])
    const hit = PRESETS.find((p) => Math.abs(p.days - days) <= 1)
    setPreset(hit ? hit.key : 'custom')
  }

  /* ---------- 导出 CSV ---------- */
  const exportCsv = () => {
    const sMap = new Map(shares)
    const iMap = new Map(index)
    const dates = [...new Set([...sMap.keys(), ...iMap.keys()])].sort()
    const rows = [`date,share_wan,index_${idxCode}`, ...dates.map((d) => `${d},${sMap.get(d) ?? ''},${iMap.get(d) ?? ''}`)]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' }))
    a.download = `${code}_share_vs_${idxCode}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches

  return (
    <ConfigProvider theme={{ algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>
      {msgCtx}
      <main>
        <Title level={2} style={{ margin: '4px 0 2px' }}>
          ETF 份额 × {idxLabel}
        </Title>
        <Text type="secondary" style={{ fontSize: 13 }}>
          数据来源：上海证券交易所（ETF 每日总份额、指数日K）
        </Text>

        {/* 搜索 + 收藏 */}
        <section className="search">
          <div className="box">
            <AutoComplete
              value={searchVal}
              options={options}
              onChange={onSearch}
              onSelect={pickSearch}
              popupMatchSelectWidth
              style={{ flex: 1 }}
              placeholder="输入 ETF 代码或关键词，如 510300 / 沪深300 / 科创"
            >
              <Input size="large" onPressEnter={onGo} onBlur={() => setTimeout(() => setOptions([]), 150)} />
            </AutoComplete>
            <Button type="primary" size="large" onClick={onGo}>
              查询
            </Button>
            <Tooltip title={!code ? '先查询一只 ETF' : isFav ? '取消收藏（F）' : '收藏当前 ETF（F）'}>
              <Button
                size="large"
                disabled={!code}
                onClick={toggleFav}
                aria-label="收藏"
                icon={isFav ? <StarFilled style={{ color: '#f59e0b' }} /> : <StarOutlined />}
              />
            </Tooltip>
          </div>

          <div className="favwrap" hidden={favs.length === 0}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              收藏
            </Text>
            <Space size={[8, 8]} wrap>
              {favs.map((f) => (
                <Tag
                  key={f.code}
                  closable
                  color="orange"
                  closeIcon={<CloseOutlined />}
                  onClose={(e) => {
                    e.preventDefault()
                    unfav(f.code)
                  }}
                  onClick={() => selectCode(f.code, f.name || null)}
                >
                  {f.code} {f.name}
                </Tag>
              ))}
            </Space>
          </div>

          <div className="chips">
            {[
              ['510300', '510300 沪深300'],
              ['510050', '510050 上证50'],
              ['510500', '510500 中证500'],
              ['588000', '588000 科创50'],
            ].map(([c, label]) => (
              <Tag key={c} onClick={() => selectCode(c, null)}>
                {label}
              </Tag>
            ))}
          </div>
        </section>

        {/* 时间范围（预设 + 自定义面板）+ 叠加指数 */}
        <section className="bar">
          <Space size={[6, 6]} wrap>
            {PRESETS.map((p) => (
              <Button key={p.key} size="small" type={preset === p.key ? 'primary' : 'default'} onClick={() => onPreset(p.key)}>
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
            presets={PRESETS.map((p) => ({ label: p.label, value: presetRange(p.key) }))}
            placeholder={['开始日期', '结束日期']}
          />
          <Select
            value={idxCode}
            onChange={setIdxCode}
            style={{ minWidth: 168 }}
            options={INDICES.map((i) => ({ value: i.code, label: `${i.name} ${i.code}` }))}
            showSearch
            filterOption={(input, opt) => opt.label.includes(input) || opt.value.includes(input)}
            popupRender={(menu) => (
              <>
                {menu}
                <CustomIndex onPick={setIdxCode} />
              </>
            )}
          />
          <Button size="small" type={norm ? 'primary' : 'default'} onClick={() => setNorm((v) => !v)}>
            归一化（起点=100）
          </Button>
          <span className="sp" />
          <Button size="small" disabled={!got} onClick={exportCsv}>
            导出 CSV
          </Button>
        </section>

        {progress != null && (
          <div className="prog">
            <i style={{ width: progress * 100 + '%' }} />
          </div>
        )}

        <div className={`status ${status.kind}`} data-testid="status">
          {status.text || (loading ? `正在获取 ${code} 数据…` : '')}
        </div>

        {code && (
          <div className="title">
            {name || code}
            <span>{code}</span>
            <span className="idx">
              × {idxLabel} {idxCode}
            </span>
          </div>
        )}

        {cards.length > 0 && (
          <section className="cards">
            {cards.map((c) => (
              <div className="card" key={c[0]}>
                <div className="l">{c[0]}</div>
                <div className={`v ${c[3]}`}>{c[1]}</div>
                <div className="s">{c[2]}</div>
              </div>
            ))}
          </section>
        )}

        {series.dates.length > 0 && (
          <section className="chartwrap">
            <Chart series={series} norm={norm} idxLabel={idxLabel} />
          </section>
        )}

        <footer>
          份额为沪市场内 ETF 总份额（接口字段 TOT_VOL，万份换算为亿份），一般在交易日收盘后更新；仅覆盖上交所 ETF（5 开头），不含深交所 159 开头及已退市产品。
          <br />
          红色柱 = 份额较上一交易日增加（净申购），绿色柱 = 减少（净赎回）。区间内没有数据的交易日按空值处理，曲线断开而不补 0。
          <br />
          时间范围最多支持近 5 年；首次查询长区间需按日拉取上交所数据（较慢），之后走本地缓存秒开。收藏保存在浏览器本地，不随账号同步。
        </footer>
      </main>
    </ConfigProvider>
  )
}

/** 指数下拉底部的“自定义代码”入口 */
function CustomIndex({ onPick }) {
  const [v, setV] = useState('')
  const ok = /^\d{6}$/.test(v)
  return (
    <div className="customidx" onMouseDown={(e) => e.preventDefault()}>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          size="small"
          value={v}
          placeholder="自定义指数代码（6 位）"
          onChange={(e) => setV(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onPressEnter={() => ok && onPick(v)}
        />
        <Button size="small" type="primary" disabled={!ok} onClick={() => onPick(v)}>
          叠加
        </Button>
      </Space.Compact>
    </div>
  )
}

/* ---------- 顶层：行情查看 / 策略研究 ---------- */
function RootApp() {
  const [page, setPage] = useState(() => {
    try {
      const qp = new URLSearchParams(location.search).get('page')
      if (qp === 'research' || qp === 'viewer') return qp
      return localStorage.getItem('sse-etf-page') || 'viewer'
    } catch {
      return 'viewer'
    }
  })
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches

  useEffect(() => {
    try {
      localStorage.setItem('sse-etf-page', page)
    } catch {
      /* 忽略写入失败 */
    }
  }, [page])

  return (
    <ConfigProvider theme={{ algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>
      <div className="pagetabs">
        <Segmented
          size="large"
          value={page}
          onChange={setPage}
          options={[
            { label: '行情查看', value: 'viewer' },
            { label: '策略研究', value: 'research' },
          ]}
        />
      </div>
      {page === 'research' ? <ResearchPage /> : <ViewerPage />}
    </ConfigProvider>
  )
}

createRoot(document.getElementById('root')).render(<RootApp />)

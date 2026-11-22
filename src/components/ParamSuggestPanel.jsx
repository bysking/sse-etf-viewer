import React, { useEffect, useState } from 'react'
import { Alert, Button, DatePicker, InputNumber, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { BulbOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { postApi } from '../api.js'
import { RECOMMEND_GROUPS } from '../../shared/wyckoff/recommend.js'
import { PARAM_ITEMS } from '../wyckoffParams.js'

const { Text } = Typography

const fmt = (d) => d.format('YYYY-MM-DD')
const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : ((+v) * 100).toFixed(2) + '%')
const n2 = (v) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(3))
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')
const pathLabel = (path) => PARAM_ITEMS.find((it) => it.path === path)?.label || path

/**
 * 参数推荐：用当前标的的历史事件样本打分，给出建议阈值。
 * 只给建议，套用要用户点按钮——避免自动改掉已经调好的参数。
 */
export function ParamSuggestPanel({ code, range, wyckoff, onApply, disabled }) {
  const [horizon, setHorizon] = useState(10)
  const [minSamples, setMinSamples] = useState(5)
  const [groups, setGroups] = useState([])
  const [trainEnd, setTrainEnd] = useState(() => {
    const days = range[1].diff(range[0], 'day')
    return range[0].add(Math.floor(days * 0.7), 'day')
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [msgApi, msgCtx] = message.useMessage()

  // 区间变了就按同样的 70% 重算训练截止，避免用旧日期的分界点
  useEffect(() => {
    const days = range[1].diff(range[0], 'day')
    setTrainEnd(range[0].add(Math.floor(days * 0.7), 'day'))
  }, [range[0]?.valueOf(), range[1]?.valueOf()])

  const run = async () => {
    if (!code) {
      msgApi.warning('请先选择一只 ETF')
      return
    }
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const r = await postApi('/api/research/param-suggest', {
        code,
        start: fmt(range[0]),
        end: fmt(range[1]),
        trainEnd: trainEnd ? fmt(trainEnd) : undefined,
        wyckoff,
        horizon,
        minSamples,
        groups: groups.length ? groups : undefined,
      })
      setResult(r)
      if (!r.changes.length) msgApi.info('当前参数已是最优组合之一，或样本不足以下结论')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const apply = () => {
    if (!result?.changes?.length) return
    onApply?.(result.recommended, result.changes)
    msgApi.success(`已套用 ${result.changes.length} 项建议值，点「识别事件」重算`)
  }

  const columns = [
    {
      title: '分组',
      dataIndex: 'label',
      width: 108,
      render: (label, r) => (
        <Space size={4}>
          <Text strong>{label}</Text>
          {r.direction === 'inverse' && <Tag>反向</Tag>}
        </Space>
      ),
    },
    {
      title: '建议值',
      width: 220,
      render: (_, r) => {
        if (r.best) {
          return (
            <Space size={4} wrap>
              {Object.entries(r.best.params).map(([p, v]) => (
                <Tag key={p} color={r.changes.some((c) => c.path === p) ? 'blue' : 'default'}>
                  {pathLabel(p)} {v}
                </Tag>
              ))}
            </Space>
          )
        }
        if (r.reason === 'gainTooSmall') {
          return (
            <Tooltip title={`最优候选只在训练段评分上高出 ${((r.gain ?? 0) * 100).toFixed(2)} 个百分点，低于最小增益门槛 ${((result?.minGain ?? 0) * 100).toFixed(2)}%，不值得改参数`}>
              <Tag color="green">当前值已足够</Tag>
            </Tooltip>
          )
        }
        return <Text type="secondary">样本不足</Text>
      },
    },
    {
      title: '样本 训练/验证',
      width: 122,
      render: (_, r) => {
        const m = r.best ?? r.baseline
        return m ? `${m.train?.count ?? 0} / ${m.validation?.count ?? 0}` : '-'
      },
    },
    {
      title: `训练 ${horizon} 日均值`,
      width: 124,
      render: (_, r) => {
        const m = r.best?.train ?? r.baseline?.train
        return <span className={cls(m?.avgReturn)}>{pct(m?.avgReturn)}</span>
      },
    },
    {
      title: `验证 ${horizon} 日均值`,
      width: 124,
      render: (_, r) => {
        const m = r.best?.validation ?? r.baseline?.validation
        return <span className={cls(m?.avgReturn)}>{pct(m?.avgReturn)}</span>
      },
    },
    {
      title: '当前值 · 训练均值',
      width: 132,
      render: (_, r) =>
        r.baseline?.score == null ? (
          <Text type="secondary">样本不足</Text>
        ) : (
          <span className={cls(r.baseline.train?.avgReturn)}>{pct(r.baseline.train?.avgReturn)}</span>
        ),
    },
    {
      title: '评分',
      width: 84,
      render: (_, r) => {
        const s = r.best?.score ?? r.baseline?.score
        return s == null ? '-' : n2(s)
      },
    },
  ]

  return (
    <section className="panel" style={{ marginTop: 12 }}>
      {msgCtx}
      <Space style={{ marginBottom: 8 }} wrap>
        <Text strong>参数推荐</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          用这只 ETF 的历史事件样本，给出每类事件的合适阈值
        </Text>
      </Space>

      <Space size={[10, 8]} wrap style={{ marginBottom: 8 }}>
        <span className="suggest-field">
          <Text type="secondary" style={{ fontSize: 12 }}>前瞻窗口</Text>
          <Select
            size="small"
            value={horizon}
            onChange={setHorizon}
            style={{ width: 92 }}
            options={[5, 10, 20].map((h) => ({ value: h, label: `${h} 日` }))}
          />
        </span>
        <span className="suggest-field">
          <Text type="secondary" style={{ fontSize: 12 }}>最少样本</Text>
          <InputNumber size="small" min={1} max={100} value={minSamples} onChange={(v) => setMinSamples(v || 1)} style={{ width: 76 }} />
        </span>
        <span className="suggest-field">
          <Text type="secondary" style={{ fontSize: 12 }}>训练截止</Text>
          <DatePicker
            size="small"
            value={trainEnd}
            onChange={(v) => v && setTrainEnd(v)}
            allowClear={false}
            disabledDate={(cur) => Boolean(cur && (cur.isBefore(range[0], 'day') || cur.isAfter(range[1], 'day')))}
            style={{ width: 130 }}
          />
        </span>
        <span className="suggest-field">
          <Text type="secondary" style={{ fontSize: 12 }}>只算这些分组</Text>
          <Select
            mode="multiple"
            size="small"
            value={groups}
            onChange={setGroups}
            placeholder="默认全部"
            style={{ minWidth: 190 }}
            options={RECOMMEND_GROUPS.map((g) => ({ value: g.key, label: g.label || g.event }))}
          />
        </span>
        <Button type="primary" size="small" icon={<BulbOutlined />} loading={loading} onClick={run} disabled={disabled || !code}>
          给出建议
        </Button>
        <Button size="small" onClick={apply} disabled={!result?.changes?.length}>
          套用建议
        </Button>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        message="训练段选值、验证段复核：只统计持有窗口完整落在段内的样本，避免跨段泄漏。"
        description="评分 =（均值+中位数）/2 × n/(n+8)：样本越少越向 0 收缩，避免 2 个样本 +8% 被当成最优。系统只给建议，不会自动改参数。"
      />
      {error && <div className="status err">{error}</div>}

      {result && (
        <>
          <Space size={8} wrap style={{ marginBottom: 8 }}>
            <Tag color="green">{result.code}</Tag>
            <Tag>复权 {result.adjust}</Tag>
            <Tag>
              {result.dataRange.start} ~ {result.dataRange.end}
            </Tag>
            <Tag>训练 ≤ {result.trainEnd}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {result.changes.length
                ? `有 ${result.changes.length} 项与当前值不同`
                : '当前参数已是最优组合之一'}
            </Text>
          </Space>
          {result.emptyGroups?.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message={`样本不足、未给建议的分组：${result.emptyGroups.join('、')}`}
              description={`把区间拉长（建议 3–5 年）或调小「最少样本」再试。样本 < ${result.minSamples} 时结论不可信。`}
            />
          )}
          {result.noGainGroups?.length > 0 && (
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
              这些分组样本够了，但最优候选比当前值只好一点点（&lt; {((result.minGain ?? 0) * 100).toFixed(2)} 个百分点），
              已判定为「当前值已足够」：{result.noGainGroups.join('、')}
            </Text>
          )}
          <Table
            size="small"
            rowKey="key"
            columns={columns}
            dataSource={result.groups}
            pagination={false}
            scroll={{ x: 900 }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            套用后请重新「识别事件」并回测验证——样本量通常很小，别把建议当结论。
          </Text>
        </>
      )}
    </section>
  )
}

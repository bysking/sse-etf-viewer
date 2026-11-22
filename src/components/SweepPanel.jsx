import React, { useMemo, useState } from 'react'
import { Alert, Button, DatePicker, InputNumber, Select, Space, Table, Tag, Typography, message } from 'antd'
import { ExperimentOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { postApi } from '../api.js'

const { Text } = Typography

const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : ((+v) * 100).toFixed(2) + '%')
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')

/** 可扫描参数：集中在最影响结果的几项，避免一次生成过多组合 */
export const SWEEP_AXES = [
  {
    key: 'execution.position.riskPct',
    label: '单笔风险',
    values: [0.005, 0.01, 0.02],
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'wyckoff.spring.maxBreakAtr',
    label: 'Spring 破位',
    values: [0.5, 1.0, 1.5],
    format: (v) => `${v} ATR`,
  },
  {
    key: 'wyckoff.spring.confirmBars',
    label: 'Spring 确认',
    values: [3, 5, 7],
    format: (v) => `${v} 根`,
  },
  {
    key: 'wyckoff.sc.volZ',
    label: 'SC 量能 Z',
    values: [1.0, 1.2, 1.5],
    format: (v) => `${v}`,
  },
  {
    key: 'wyckoff.sos.breakAtr',
    label: 'SOS 突破',
    values: [0.2, 0.3, 0.5],
    format: (v) => `${v} ATR`,
  },
]

/**
 * 参数扫描：训练段选参数、验证段检验。
 * UI 只负责选择轴与展示，不做自动择优——过拟合判断留给人。
 */
export function SweepPanel({ code, range, buildStrategyConfig, initialCash }) {
  const [selected, setSelected] = useState(['execution.position.riskPct'])
  const [trainEnd, setTrainEnd] = useState(() => {
    const start = range[0]
    const end = range[1]
    const days = end.diff(start, 'day')
    return start.add(Math.floor(days * 0.7), 'day')
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [msgApi, msgCtx] = message.useMessage()

  const comboCount = useMemo(
    () => selected.reduce((n, key) => n * (SWEEP_AXES.find((a) => a.key === key)?.values.length || 1), 1),
    [selected],
  )

  const run = async () => {
    if (!selected.length) {
      msgApi.warning('至少选择一个参数轴')
      return
    }
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const config = buildStrategyConfig()
      const grid = selected.map((key) => ({
        path: key,
        values: SWEEP_AXES.find((a) => a.key === key).values,
      }))
      const r = await postApi('/api/backtests/sweep', {
        config,
        start: range[0].format('YYYY-MM-DD'),
        end: range[1].format('YYYY-MM-DD'),
        trainEnd: trainEnd.format('YYYY-MM-DD'),
        initialCash: Number(initialCash) || 100000,
        grid,
      })
      setResult(r)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const axisLabel = (path) => SWEEP_AXES.find((a) => a.key === path)?.label || path
  const axisFormat = (path, v) => {
    const a = SWEEP_AXES.find((x) => x.key === path)
    return a ? a.format(v) : String(v)
  }

  const columns = [
    {
      title: '参数',
      render: (_, r) => (
        <Space size={4} wrap>
          {Object.entries(r.params || {}).map(([k, v]) => (
            <Tag key={k}>
              {axisLabel(k)} {axisFormat(k, v)}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '训练段收益',
      width: 110,
      render: (_, r) => <span className={cls(r.train?.totalReturn)}>{pct(r.train?.totalReturn)}</span>,
    },
    { title: '训练段回撤', width: 110, render: (_, r) => pct(r.train?.maxDrawdown) },
    { title: '训练段交易', width: 96, render: (_, r) => r.train?.tradeCount ?? '-' },
    {
      title: '验证段收益',
      width: 110,
      render: (_, r) =>
        r.validation?.totalReturn == null ? (
          <Text type="secondary">无数据</Text>
        ) : (
          <span className={cls(r.validation.totalReturn)}>{pct(r.validation.totalReturn)}</span>
        ),
    },
    { title: '验证段回撤', width: 110, render: (_, r) => pct(r.validation?.maxDrawdown) },
    { title: '验证段交易', width: 96, render: (_, r) => r.validation?.tradeCount ?? '-' },
  ]

  return (
    <section className="panel" style={{ marginTop: 12 }}>
      {msgCtx}
      <Space style={{ marginBottom: 8 }} wrap>
        <Text strong>参数扫描</Text>
        <Select
          mode="multiple"
          value={selected}
          onChange={setSelected}
          style={{ minWidth: 320 }}
          options={SWEEP_AXES.map((a) => ({ value: a.key, label: `${a.label}（${a.values.length} 值）` }))}
          placeholder="选择要扫描的参数"
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          训练截止
        </Text>
        <DatePicker
          value={trainEnd}
          onChange={(v) => v && setTrainEnd(v)}
          allowClear={false}
          disabledDate={(cur) => cur && (cur.isBefore(range[0], 'day') || cur.isAfter(range[1], 'day'))}
        />
        <Button icon={<ExperimentOutlined />} loading={loading} onClick={run} disabled={!code}>
          开始扫描
        </Button>
        <Tag color={comboCount > 60 ? 'orange' : 'default'}>{comboCount} 组</Tag>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        message="训练段用来选参数，验证段用来检验是否只是样本内好看。"
        description="扫描结果只做排序与对比，不会自动替你选定参数——样本量通常很小，最后一步应由你判断。"
      />
      {error && <div className="status err">{error}</div>}

      {result && (
        <>
          <Space size={8} wrap style={{ marginBottom: 8 }}>
            <Tag color="green">共 {result.combos} 组</Tag>
            <Tag>复权 {result.adjust}</Tag>
            <Tag>{result.reanalyzed ? '含 Wyckoff 参数，逐组重新分析' : '复用分析结果'}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              训练段 ≤ {result.trainEnd}
            </Text>
          </Space>
          <Table
            size="small"
            rowKey={(r) => JSON.stringify(r.params)}
            columns={columns}
            dataSource={result.ranked?.length ? result.ranked : result.results}
            pagination={{ pageSize: 10, size: 'small' }}
            scroll={{ x: 900 }}
            locale={{ emptyText: '没有可用结果（可能交易数不足）' }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            排序依据：训练段与验证段收益的较小值（取更差的一段），交易数为 0 的组合已过滤。
          </Text>
        </>
      )}
    </section>
  )
}

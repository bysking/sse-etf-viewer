import React, { useEffect, useState } from 'react'
import { Button, Descriptions, Drawer, Popconfirm, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { DeleteOutlined, EyeOutlined, HistoryOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { api, postApi, putApi } from './api.js'

const { Title, Text } = Typography

const n2 = (v) => (v == null || !Number.isFinite(+v) ? '-' : (+v).toFixed(2))
const pct = (v) => (v == null || !Number.isFinite(+v) ? '-' : ((+v) * 100).toFixed(2) + '%')
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')
const STATUS_LABEL = { draft: '草稿', validated: '已校验', active: '启用中', archived: '已归档' }
const STATUS_COLOR = { draft: 'orange', validated: 'blue', active: 'green', archived: 'default' }

export function StrategiesPage() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [detail, setDetail] = useState(null)
  const [versions, setVersions] = useState([])
  const [runs, setRuns] = useState([])
  const [msgApi, msgCtx] = message.useMessage()

  const load = async () => {
    setLoading(true)
    try {
      const r = await api('/api/strategies')
      setItems(r.items || [])
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const openDetail = async (strategy) => {
    setDetail({ strategy })
    setVersions([])
    setRuns([])
    try {
      const [v, r] = await Promise.all([
        api(`/api/strategies/${strategy.id}/versions`),
        api(`/api/strategies/${strategy.id}/runs`),
      ])
      setVersions(v.items || [])
      setRuns(r.items || [])
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const refreshDetail = async (id) => {
    const [v, r, s] = await Promise.all([
      api(`/api/strategies/${id}/versions`),
      api(`/api/strategies/${id}/runs`),
      api(`/api/strategies/${id}`),
    ])
    setVersions(v.items || [])
    setRuns(r.items || [])
    // 抽屉里的策略信息也要跟着刷新，否则启用后仍显示“未启用”
    setDetail((d) => (d ? { ...d, strategy: s } : d))
    await load()
  }

  const toggleEnabled = async (s, enabled) => {
    try {
      await putApi(`/api/strategies/${s.id}`, { enabled })
      msgApi.success(enabled ? '已启用' : '已停用')
      await load()
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const remove = async (s) => {
    try {
      await fetch(new URL(`/api/strategies/${s.id}`, location.origin), { method: 'DELETE' }).then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok || j.error) throw new Error(j.error || '删除失败')
      })
      msgApi.success('已删除')
      if (detail?.strategy?.id === s.id) setDetail(null)
      await load()
    } catch (e) {
      msgApi.error(e.message)
    }
  }

  const promote = async (version) => {
    setBusy(`p-${version.id}`)
    try {
      const r = await postApi(`/api/strategy-versions/${version.id}/promote`, { status: 'active' })
      msgApi.success(`已启用 v${r.version}`)
      await refreshDetail(version.strategyId)
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const validate = async (version) => {
    setBusy(`v-${version.id}`)
    try {
      const r = await postApi(`/api/strategy-versions/${version.id}/validate`, {})
      msgApi.success(r.validation?.ok ? `v${r.version} 校验通过` : '校验未通过')
      await refreshDetail(version.strategyId)
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const runVersionBacktest = async (version) => {
    setBusy(`b-${version.id}`)
    try {
      const end = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
      const start = new Date(Date.now() - 365 * 864e5 + 8 * 3600 * 1000).toISOString().slice(0, 10)
      const r = await postApi(`/api/strategy-versions/${version.id}/backtests`, { start, end })
      msgApi.info(`回测已提交（v${version.version}），可在下方回测记录查看`)
      // 轮询几次刷新列表
      for (let i = 0; i < 30; i++) {
        await new Promise((res) => setTimeout(res, 700))
        const detailRuns = await api(`/api/strategies/${version.strategyId}/runs`)
        setRuns(detailRuns.items || [])
        const run = detailRuns.items?.find((x) => x.id === r.id)
        if (run && (run.status === 'done' || run.status === 'failed')) break
      }
    } catch (e) {
      msgApi.error(e.message)
    } finally {
      setBusy('')
    }
  }

  const columns = [
    {
      title: '策略',
      render: (_, s) => (
        <div>
          <div style={{ fontWeight: 500 }}>{s.name}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {s.config?.symbol || '-'} · {s.engineVersion}
          </div>
        </div>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (e, s) => <Switch size="small" checked={e} onChange={(v) => toggleEnabled(s, v)} />,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (v) => String(v).replace('T', ' ').slice(0, 19),
    },
    {
      title: '操作',
      width: 260,
      render: (_, s) => (
        <Space size={4}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(s)}>
            详情
          </Button>
          <Popconfirm title="删除后不可恢复，确认？" onConfirm={() => remove(s)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const versionColumns = [
    { title: '版本', dataIndex: 'version', width: 70, render: (v) => `v${v}` },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s) => <Tag color={STATUS_COLOR[s] || 'default'}>{STATUS_LABEL[s] || s}</Tag>,
    },
    {
      title: '校验',
      width: 110,
      render: (_, v) =>
        v.validation ? (
          v.validation.ok ? (
            <Tag color="green">通过</Tag>
          ) : (
            <Tag color="red">{v.validation.errors?.length || 0} 项错误</Tag>
          )
        ) : (
          <Tag>未校验</Tag>
        ),
    },
    {
      title: '来源',
      width: 120,
      render: (_, v) => (v.provenance?.source === 'ai' ? `AI · ${v.provenance.model || ''}` : '人工'),
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 160, render: (v) => String(v).replace('T', ' ').slice(0, 19) },
    {
      title: '操作',
      width: 250,
      render: (_, v) => (
        <Space size={4}>
          {v.status === 'draft' && (
            <Button size="small" loading={busy === `v-${v.id}`} onClick={() => validate(v)}>
              校验
            </Button>
          )}
          {['draft', 'validated', 'archived'].includes(v.status) && (
            <Button size="small" type="primary" loading={busy === `p-${v.id}`} onClick={() => promote(v)}>
              启用
            </Button>
          )}
          <Button size="small" ghost loading={busy === `b-${v.id}`} onClick={() => runVersionBacktest(v)}>
            回测
          </Button>
        </Space>
      ),
    },
  ]

  const runColumns = [
    { title: '区间', width: 200, render: (_, r) => `${r.start} ~ ${r.end}` },
    { title: '状态', dataIndex: 'status', width: 90, render: (s) => <Tag color={s === 'done' ? 'green' : s === 'failed' ? 'red' : 'blue'}>{s}</Tag> },
    { title: '总收益', width: 100, render: (_, r) => <span className={cls(r.metrics?.totalReturn)}>{pct(r.metrics?.totalReturn)}</span> },
    { title: '基准', width: 100, render: (_, r) => pct(r.metrics?.benchmarkReturn) },
    { title: '回撤', width: 100, render: (_, r) => pct(r.metrics?.maxDrawdown) },
    { title: '口径', width: 90, render: (_, r) => r.metrics?.adjust || '-' },
    { title: '版本', width: 110, render: (_, r) => (r.strategyVersionId ? r.strategyVersionId.slice(0, 8) : '-') },
    { title: '时间', width: 160, dataIndex: 'createdAt', render: (v) => String(v).replace('T', ' ').slice(0, 19) },
  ]

  return (
    <>
      {msgCtx}
      <main>
        <div className="ai-head">
          <div>
            <Title level={2} style={{ margin: '4px 0 2px' }}>
              策略管理
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              版本化的策略列表：查看校验结果、回测记录，启用或归档版本。
            </Text>
          </div>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        </div>

        <section className="panel" style={{ marginTop: 12 }}>
          <Table
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={items}
            loading={loading}
            pagination={{ pageSize: 10, size: 'small' }}
            locale={{ emptyText: '还没有策略；可在「AI 助手」生成，或「策略研究」回测后保存' }}
          />
        </section>

        <footer>
          策略内容按版本不可变：修改会产生新版本，历史回测可按当时的版本与数据口径复现。
          启用版本会同步策略配置并开启监控。
        </footer>
      </main>

      <Drawer
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        width={960}
        title={detail?.strategy?.name || '策略详情'}
      >
        {detail?.strategy && (
          <>
            <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="标的">{detail.strategy.config?.symbol || '-'}</Descriptions.Item>
              <Descriptions.Item label="引擎">{detail.strategy.engineVersion}</Descriptions.Item>
              <Descriptions.Item label="状态">
                {detail.strategy.enabled ? <Tag color="green">已启用</Tag> : <Tag>未启用</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="入场条件" span={3}>
                <code style={{ fontSize: 12 }}>{JSON.stringify(detail.strategy.config?.entry)}</code>
              </Descriptions.Item>
              <Descriptions.Item label="出场条件" span={3}>
                <code style={{ fontSize: 12 }}>{JSON.stringify(detail.strategy.config?.exit)}</code>
              </Descriptions.Item>
            </Descriptions>

            <Title level={5}>
              <HistoryOutlined /> 版本
            </Title>
            <Table
              size="small"
              rowKey="id"
              columns={versionColumns}
              dataSource={versions}
              pagination={false}
              scroll={{ x: 860 }}
              locale={{ emptyText: '暂无版本记录' }}
            />

            <Title level={5} style={{ marginTop: 16 }}>
              <PlayCircleOutlined /> 回测记录
            </Title>
            <Table
              size="small"
              rowKey="id"
              columns={runColumns}
              dataSource={runs}
              pagination={{ pageSize: 8, size: 'small' }}
              scroll={{ x: 900 }}
              locale={{ emptyText: '暂无回测记录' }}
            />
          </>
        )}
      </Drawer>
    </>
  )
}

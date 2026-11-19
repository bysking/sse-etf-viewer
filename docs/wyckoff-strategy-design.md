# 上交所 ETF Wyckoff 策略系统 — 技术方案（定稿）

- 项目：`sse-etf-viewer`
- 版本：v1.0
- 日期：2026-11-19
- 状态：定稿，作为 P0–P3 实施依据
- 适用：沪市 ETF（5 开头）、单标的、只做多、日线执行、收盘后日频监控

---

## 0. 目标与非目标

### 目标

1. **自定义 Wyckoff 策略**：以「区间 + 量价事件 + 阶段 + 确认条件 + 执行参数」表达，不依赖任意 JS 代码。
2. **历史回测**：收益率、回撤、夏普、交易明细、买卖点、基准对比。
3. **向前模拟盘（双账本）**：
   - **规则模拟盘**：命中规则即自动虚拟成交，评估策略本身；
   - **人工确认盘**：只记录人工确认的信号，评估人工过滤的增益/损耗。
4. **收盘后日频监控**：检测候选买卖点，飞书 / Telegram 推送，人工确认后记录。
5. **事件研究与校准**：统计历史事件的前瞻收益、胜率、MFE/MAE，用于调参和阈值验证。
6. **可解释**：行情图自动标注区间、支撑阻力、Swing、事件、阶段；推送携带证据。

### 非目标（本期不做）

- 券商实盘自动下单；
- 做空、杠杆、期权、股指期货；
- 盘中分钟级触发（日线级别，止损按收盘确认、次日开盘执行）；
- 深交所 ETF、已退市标的；
- 多用户、权限体系（默认单机单用户；公网部署需外置鉴权）；
- 微信通知（保留适配器接口，暂不实现）。

---

## 1. 决策摘要

| 维度 | 定稿结论 |
| --- | --- |
| 策略表达 | 引擎内置 Wyckoff 事件层 + 声明式策略 DSL |
| 自动化 | 规则模拟盘自动成交；通知只发「候选」；人工确认盘保留 |
| 事件范围 | 区间 + SC / AR / ST / Spring / Test / UTAD / SOS / LPS / SOW / LPSY + 努力结果 + 简化阶段状态机 |
| 分析周期 | 日线执行 + 周线背景（周线只用已收盘数据） |
| 份额数据 | 纳入 ETF 净申购 / 赎回作为供需证据 |
| 监控频率 | 收盘后日频：15:10（纯价格）/ 18:40（含份额，重试至 22:00） |
| 通知渠道 | 飞书 + Telegram；微信暂缓 |
| 存储 | Node 内置 `node:sqlite`（`engines` 升至 >=22.5，建议 >=24） |
| 调度运行 | 生产进程内启动；开发环境不跑调度，只提供「手动检查」 |
| 标的范围 | 沪市 ETF，单标的、单仓位、只做多 |
| 成交口径 | T 日收盘确认 → T+1 开盘成交；T+1 可卖限制；结构失效则取消订单 |

---

## 2. 现状与可行性

### 2.1 现有项目

- Vite + React + antd + ECharts 单页；`src/main.jsx` 544 行。
- 后端：`server/sse.js` 负责上交所份额与指数日 K，`server/api.js` 路由中间件，Vite dev/preview 与生产共用。
- 缓存：`.cache/<YYYY-MM-DD>.json` 按日缓存全市场 ETF 份额。
- 无数据库、无测试、无调度、无鉴权。

### 2.2 已验证的关键事实

| 事实 | 验证结果 |
| --- | --- |
| yunhq 可取 ETF 日 K | `510300` 返回 3519 根；一次取 1300 根（约 5 年）正常 |
| yunhq 可取实时快照 | 返回 last/open/high/low/prev_close/volume/amount |
| 份额发布时间 | T 日晚间；实测当日 16:30 查询为空，前一日已可查 |
| Node 环境 | v24.22.2；`node:sqlite`、`node:test`、全局 `fetch` 可用 |
| 份额覆盖 | 沪市 ETF、近 5 年；价格可比份额更长 |

### 2.3 当前缺口

- 没有 ETF 自身价格，无法计算策略收益；
- 没有 Wyckoff 事件识别、回测引擎、模拟盘、调度、通知；
- 没有持久化策略 / 信号 / 通道配置；
- 前端单页结构不足以承载策略研究与监控。

---

## 3. 总体架构

```text
浏览器（React）
 ├─ 行情查看（现有页面）
 ├─ 策略研究：策略编辑 / 模板 / 标注图 / 事件研究
 ├─ 回测：收益曲线 / 回撤 / 交易 / 买卖点
 ├─ 模拟盘：规则账本 + 人工确认账本
 └─ 监控与设置：候选信号 / 确认 / 渠道 / 发送日志
        │ REST /api
Node 单一进程（开发由 Vite 中间件；生产由 server/prod.js）
 ├─ data/      上交所代理：份额 + 日 K + 快照 + 交易日历 + 缓存
 ├─ shared/    Wyckoff 分析器 + 指标 + 条件求值 + 指标计算
 ├─ backtest/  bar-by-bar 组合模拟 + 异步任务
 ├─ paper/     规则模拟盘 / 人工确认盘 / 待成交订单
 ├─ monitor/   调度 + 信号状态 + 去重 + 补跑
 ├─ notify/    飞书 / Telegram 适配器 + 重试 + 日志
 └─ store/     SQLite
```

### 3.1 核心原则

1. **单一信号源**：`shared/wyckoff/analyzer.js` 是唯一的事件/信号实现；回测、事件研究、模拟盘、监控都调用它。
2. **流式无未来函数**：分析器按 bar 顺序推进，只维护当前状态，绝不回看未来。
3. **事件双时间**：`occurredAt`（价格发生日）与 `detectedAt`（确认日）；所有交易、监控、去重均以 `detectedAt` 为准。
4. **候选语义**：通知永远描述「候选事件 + 证据」，不表述为「指令」。
5. **可复现**：策略配置、引擎版本、数据版本随每次回测/模拟运行快照保存。

---

## 4. 目录结构

```text
shared/                         前后端共用，Node 与 Vite 均直接 import
  indicators.js                 SMA / EMA / RSI / MACD / ATR / STD / ZScore / 涨跌幅
  wyckoff/
    features.js                 spread、closePos、volZ、volRatio、progress、effortResult
    structure.js                ATR ZigZag Swing、支撑阻力、区间、周线重采样、相对强弱
    events.js                   SC / AR / ST / Spring / Test / UTAD / SOS / LPS / SOW / LPSY
    phase.js                    吸筹 / 派发状态机 + 置信度
    analyzer.js                 流式主循环（核心）
    config.js                   参数默认值、校验、版本
  strategy/
    evaluate.js                 条件 AST 求值
    metrics.js                  收益、回撤、夏普、胜率、事件研究统计

server/
  data/
    kline.js                    ETF / 指数日 K（复用 yunhq，按 code 缓存）
    snap.js                     实时快照
    calendar.js                 交易日历（由指数 K 线推导）
  store/
    schema.sql                  建表语句
    db.js                       初始化、迁移、WAL
    repositories.js             查询封装
  jobs/queue.js                 回测异步任务 + 进度
  backtest/engine.js            bar-by-bar 组合模拟
  paper/service.js              规则模拟盘 / 人工确认盘 / 待成交订单 / 结算
  monitor/scheduler.js          tick + 检查时点 + 补跑
  monitor/signals.js            信号生成、状态、去重、确认/忽略
  notify/
    dispatch.js                 统一分发、重试、限流、日志
    feishu.js
    telegram.js
  api.js                        扩展路由
  prod.js                       生产入口（按环境变量启动调度）

src/
  pages/
    ViewerPage.jsx              现有页面平移
    StrategyPage.jsx            策略列表 + 编辑器
    ResearchPage.jsx            标注图 + 事件研究
    BacktestPage.jsx            回测结果
    PaperPage.jsx               双账本模拟盘
    MonitorPage.jsx             候选信号 / 确认 / 发送记录
    SettingsPage.jsx            通知渠道 / 测试发送
  components/
    WyckoffChart.jsx
    EventStudyPanel.jsx
    StrategyEditor.jsx
    ...
  api.js
```

> `shared/` 放在 Vite 根目录内，`src` 通过 `../shared/...` 导入；Node 直接 ESM 导入，不需要构建步骤。

---

## 5. 数据层设计

### 5.1 新增接口

| 接口 | 返回 |
| --- | --- |
| `GET /api/kline?code=510300&start=&end=` | `{ code, adjust: "none"|"qfq", series: [[date, open, high, low, close, volume], ...] }` |
| `GET /api/snap?code=510300` | `{ code, date, time, last, open, high, low, prevClose, volume, amount }` |
| `GET /api/calendar?start=&end=` | `{ dates: ["2026-11-19", ...] }` |
| 现有 `GET /api/shares` | 保持不变，`[[date, 万份|null], ...]` |
| 现有 `GET /api/index` | 保持不变；指数 K 也可改用 `/api/kline` |

### 5.2 缓存策略

- 份额：沿用 `.cache/<date>.json`，按日全市场缓存。
- 日 K：`.cache/kline/<code>.json`，保存全量历史 + `updatedAt`；当日最后一根按 TTL（例如 60 秒）刷新，其余不可变。
- 快照：不落盘，或在内存缓存 3–5 秒。
- 日历：由 `000001` 指数日 K 推导，缓存最近 5 年。
- 回测任务复用同一缓存，冷启动时按月分块拉取并上报进度。

### 5.3 对齐与新鲜度

- **主轴**：价格 K 线的交易日。
- **份额**：按日对齐；缺失时最多前向填充 `staleMaxDays = 2` 个交易日；超过则 `fresh = false`，份额条件判 `false`，并在证据中标注 stale。
- **数据依赖**：策略声明是否使用份额；使用份额时回测区间受「近 5 年 + 数据可得」限制，纯价格策略可用更长历史。
- **缺失**：停牌、未上市、请求失败均视为 `null`，绝不补 0。

### 5.4 时间语义

| 数据 | 可知时点 | 用途 |
| --- | --- | --- |
| 日 K 收盘价 | T 日 15:00 | 价格类事件、收盘信号 |
| ETF 份额 | T 日晚间（实测 16:30 尚未发布） | 供需证据、份额类确认 |
| 周线 | 本周最后一个交易日收盘后 | 周线背景，且只用上一完整周 |

- 信号在 T 日收盘后确认；**默认 T+1 开盘价成交**。
- 日线级别止损按收盘确认，次日开盘执行；不做盘中触发。
- 模拟盘与回测使用同一时序，禁止「用 T 日收盘价成交却使用了 T 日晚间份额」。

### 5.5 复权（已验证并实现）

**验证结论（2026-11-19）：yunhq 日 K 确实不复权。** 用「ETF 相对上证指数的额外开盘跳空」交叉验证：

- `510880`（红利ETF）每年 1 月出现 3–5% 的除息跳空，逐年可复现；
- `510300` 每年 1 月有 1–2% 的除息；
- 影响量级：`510880` 2016–2026 买入持有收益，未复权 **25.31%**，前复权 **76.13%**，相差约 51 个百分点。

**实现**：

1. `dividend_events` 表存除息事件（代码、除息日、相对跌幅、估算金额、source、confirmed）；
2. `server/data/adjust.js`：
   - `detectDividends()` 用「ETF 相对基准指数的额外低开」识别候选，默认阈值 2%、每年最多 2 笔；
   - `applyForwardAdjust()` 按完整精度比例回溯缩放，先统一算比例再应用，避免多次除息累积误差；
3. **自动识别结果一律 `confirmed=0`**，只有人工确认后才参与复权——避免把真实利空误判为除息；
4. K 线、研究、回测、AI 上下文统一走 `applyAdjust()`，默认 `qfq`，`adjust=none` 可取原始价格；
5. 回测结果记录 `metrics.adjust`、`metrics.adjustmentCount` 与 `dataVersion`（`qfq:9:起始日:结束日:根数`），保证可复现。

仍然存在的局限：估算金额是按跳空幅度反推的近似值，不是公告分红数据；ETF 分红有时是收益分配而非股息，口径不完全等价。若后续接入官方分红公告数据，可替换 `detectDividends()` 的来源。

### 5.6 交易日历

- 以 `000001` 指数日 K 的日期集合为准；缺失的日期即非交易日（含节假日）。
- 调度、周线重采样、回测区间全部使用该日历。
- 若指数数据不可用，回退为「周一至周五」，但会在 UI 标注降级状态。

---

## 6. Wyckoff 引擎

### 6.1 分层

| 层 | 产出 | 内容 |
| --- | --- | --- |
| L1 量价基础 | 每根 bar 的特征 | spread、closePos、progress、volRatio、volZ、effortResult |
| L2 市场结构 | 结构与关键位 | Swing 高低点、支撑/阻力、交易区间、周线背景、相对强弱 |
| L3 Wyckoff 事件 | 带双时间的事件 | SC / AR / ST / Spring / Test / UTAD / SOS / LPS / SOW / LPSY |
| L4 阶段 | 阶段 + 置信度 | 吸筹 A–E、派发 A–E、markup、markdown、range、neutral |
| L5 策略 | 买卖点与仓位 | 事件 + 阶段 + 周线 + 份额 + 结构性止损 |

### 6.2 L1 特征（参数可配）

- `ATR(n=14)`
- `volMA(20)`、`volZ(60)`
- `spreadAtr = (high - low) / ATR`
- `closePos = (close - low) / (high - low)`（0–1）
- `progressAtr = |close - prevClose| / ATR`
- `effortResult`：
  - `absorption`：`volZ >= 1.0 && progressAtr < 0.5`（高量小进展）
  - `noSupply`：阴线且 `volZ <= -0.5`
  - `noDemand`：阳线且 `volZ <= -0.5`
  - `genuineMove`：`volZ >= 0.5 && progressAtr >= 1.0`
  - 其余 `neutral`

### 6.3 L2 结构

- **Swing**：ATR ZigZag；从上一 pivot 反向移动 ≥ `atrMult * ATR` 时确认 pivot，再额外等待 `confirmBars` 根。
  - 默认 `atrPeriod=14, atrMult=1.5, confirmBars=2`。
  - pivot 的 `occurredAt` 为极值日，`detectedAt` 为确认日。
- **支撑/阻力**：已确认 swing 高点/低点按 `0.5 ATR` 聚类；至少 2 次触碰。
- **交易区间**：
  - 上沿取 swing 高点聚类，下沿取 swing 低点聚类；
  - 宽度 `<= maxWidthAtr * ATR`（默认 3.0）；
  - 持续 `>= minBars`（默认 20）；
  - 收盘突破边界 `breakAtr`（默认 0.3 ATR）后区间失效；
  - `rangeId = "R-" + 区间起始日`，事件绑定到区间。
- **区间方向推断**：pivot 区间用起点之前 `sideLookbackBars=60` 根的涨跌幅判断方向：≤ -`sideMinReturn`（默认 5%）为吸筹，≥ +5% 为派发，否则保持 neutral。避免所有非 SC/BC 种子区间都因 `neutral` 而跳过 Spring / UTAD / SOW。
- **相对强弱**：`close / benchmarkClose` 的 N 日动量；用于区间内的强弱确认（可选）。
- **周线背景**：日 K 重采样为周 K，只取**上一完整周**：
  - `weeklyTrend`（收盘相对 MA30 上/下）；
  - `weeklyRangeHigh/Low`（最近 N 周）；
  - `weeklyPosition`（收盘在周线区间中的位置）。
  - v1 不要求周线事件识别；完整周线 Wyckoff 放 P4。

### 6.4 L3 事件定义（v1 核心集）

| 事件 | 可计算定义（参数默认值） | 确认 / 失效 |
| --- | --- | --- |
| **SC** 卖出高潮 | 创 `lookback=60` 日新低；`volZ>=1.2`；`spreadAtr>=1.0`；`closePos>=0.4` | SC 当日记录；需 AR 确认区间上沿；失效位 = SC 低点 |
| **AR** 自动反弹 | SC 后 `maxBars=15` 内，从 SC 低点反弹 `>=1.2 ATR` | 反弹高点作为区间上沿候选 |
| **ST** 二次测试 | 回踩 SC 低点 ±`0.5 ATR`；量能低于 SC；收盘守住 SC 低点 | 确认区间下沿 |
| **Spring** 弹簧 | 最低价跌破区间下沿 `<=1.0 ATR`；`confirmBars=5` 内收盘回到区间内 | `occurredAt` = 破位 bar；`detectedAt` = 收回 bar；失效位 = Spring 低点 |
| **Test** 测试 | Spring 后回踩 Spring 低点附近，量能低于 Spring | 低点 = 二次防守位 |
| **UTAD** 派发后上冲 | 最高价突破区间上沿 `<=1.0 ATR`；`5` 根内收盘回到区间内，通常放量 | `occurredAt` = 突破 bar；`detectedAt` = 收回 bar；失效位 = UTAD 高点 |
| **SOS** 强势信号 | 阳线；`spreadAtr>=1.2`；`closePos>=0.7`；`volZ>=0.5`；收盘突破区间上沿 `>=0.3 ATR` | 收盘确认；突破位转支撑 |
| **LPS** 最后支撑 | SOS 后缩量回踩，回撤 `<=1.0 ATR`，守住突破位 | 回踩低点 = 止损位 |
| **SOW** 弱势信号 | 阴线；`spreadAtr>=1.2`；`closePos<=0.3`；`volZ>=1.0`；收盘跌破区间下沿 `>=0.3 ATR` | 收盘确认 |
| **LPSY** 最后供应 | SOW 后缩量反弹，`<=1.0 ATR`，受阻于区间下沿 | 反弹高点 = 防守位 |

补充：

- **BC / PSY / UT** 与 SC / PS / ST 对称，v1 一并实现（派发侧）。
- **努力 vs 结果**作为确认证据，不单独触发交易。
- 对 ETF **只做多**：UTAD / SOW / LPSY 只产生离场或减仓信号，不产生做空信号。
- 以上默认值于 2026-11-19 用 4 只 ETF、10 年训练/验证段校准，并用上证指数 + 7 只未参与校准的 ETF 做样本外检验；SOS/SOW 的放宽在样本外变差，因此保持旧阈值。详见 `docs/wyckoff-calibration-2026-11-19.md`。样本量仍偏小，建议每季度复跑。
- 所有阈值、确认根数、容差均写入策略配置，回测与监控共用。

### 6.5 L4 阶段状态机（简化）

```text
neutral
  └─(SC + AR)──────────────▶ accumulation_A
        └─(ST / 多次测试)───▶ accumulation_B
              └─(Spring/Test)─▶ accumulation_C
                    └─(SOS+LPS)▶ accumulation_D
                          └─(突破 + 站稳)▶ accumulation_E / markup
派发侧对称：
neutral
  └─(BC + AR)──────────────▶ distribution_A
        └─(ST)───────────────▶ distribution_B
              └─(UT/UTAD)────▶ distribution_C
                    └─(SOW+LPSY)▶ distribution_D
                          └─(跌破 + 走弱)▶ distribution_E / markdown
```

- 输出 `{ phase, confidence, rangeId, since }`。
- 置信度示例：基础 0.3；SC+0.2、AR+0.15、ST+0.15、Spring+0.2、SOS+0.2；出现反向事件时扣分；上限 0.95。
- 阶段不完整时输出 `range` 或 `neutral`，**不硬判**；策略可选择是否要求 `minConfidence`。
- 阶段迁移只在 `detectedAt` 时生效。

### 6.6 周线背景

- 由日 K 重采样为周 K（每周最后一个交易日为周收盘）。
- 对任意日 bar，只能使用**上一完整周**的数据；实现 `weeklyAsOf(date)`。
- v1 字段：`weeklyTrend`、`weeklyRangeHigh/Low`、`weeklyPosition`、`closeAboveMa30`。
- 周线事件（周线 SC/Spring/UTAD）放 P4。

### 6.7 份额流

- `shareDelta = shares_t - shares_{t-1}`（万份；正 = 净申购，负 = 净赎回）。
- `cumDeltaN`：N 日累计；`shareZ`：60 日 Z 分数；`shareTrend`：N 日方向。
- 新鲜度：`staleDays <= 2` 才参与条件；否则 `fresh=false`，条件判 `false`，证据标注。
- 定位：净申购 = 一级市场资金进场（需求）；净赎回 = 供给。作为吸筹/派发的**确认证据**，不单独作为交易信号。
- 风险：份额变化可能由套利行为驱动，不能等同于方向性资金；UI 需标注这一局限。

### 6.8 流式与无未来函数

`shared/wyckoff/analyzer.js` 维护以下状态，逐 bar 推进：

- 当前 swing 方向、最近确认的 pivot；
- 当前区间（`rangeId/high/low/start`）；
- 当前阶段与置信度；
- 待确认事件（如 SC 等待 AR、Spring 等待 reclaim）；
- 份额缓存、周线缓存。

约束：

- 处理第 t 根 bar 后，只能产生 `detectedAt <= t` 的事件与信号。
- 回测中第 t 根 bar 的信号只能使用 `detectedAt <= t` 的事件。
- 事件研究用同一 pass 输出，不允许离线批次重新计算一套不同逻辑。
- 必须通过「截断测试」：把未来 bar 去掉后重算，过去所有信号不变。

### 6.9 事件研究

对每个已确认事件：

- 入场：`detectedAt` 之后第一个交易日开盘；
- 时间窗：5 / 10 / 20 / 60 个交易日；
- 统计：平均收益、中位数、胜率、MFE、MAE、样本数；
- 分组：按事件类型、阶段、区间质量、周线背景、份额新鲜度；
- 用途：校准阈值（例如 Spring 破位幅度取 0.5 还是 1.0 ATR），**不用于自动选择最优参数**，避免过拟合。

---

## 7. 策略 DSL

### 7.1 完整示例

```json
{
  "schemaVersion": 1,
  "engine": "wyckoff-v1",
  "name": "沪深300 吸筹 Spring 反转",
  "symbol": "510300",
  "context": {
    "benchmark": "000001",
    "weekly": {
      "enabled": true,
      "maPeriod": 30,
      "rangeWeeks": 20
    }
  },
  "wyckoff": {
    "swing":  { "atrPeriod": 14, "atrMult": 1.5, "confirmBars": 2 },
    "range":  { "minBars": 20, "maxWidthAtr": 3.0, "minTouches": 2, "breakAtr": 0.3,
                "sideLookbackBars": 60, "sideMinReturn": 0.05 },
    "volume": { "maPeriod": 20, "zWindow": 60, "highZ": 1.5, "lowZ": -0.5 },
    "sc":     { "lookback": 60, "volZ": 1.2, "spreadAtr": 1.0, "closePos": 0.4 },
    "bc":     { "lookback": 60, "volZ": 1.2, "spreadAtr": 1.0, "closePos": 0.6 },
    "ar":     { "maxBars": 15, "reboundAtr": 1.2 },
    "st":     { "toleranceAtr": 0.5, "volBelowSc": true },
    "spring": { "maxBreakAtr": 1.0, "confirmBars": 5 },
    "utad":   { "maxBreakAtr": 1.0, "confirmBars": 5 },
    "sos":    { "spreadAtr": 1.2, "closePos": 0.7, "volZ": 0.5, "breakAtr": 0.3 },
    "sow":    { "spreadAtr": 1.2, "closePos": 0.3, "volZ": 1.0, "breakAtr": 0.3 },
    "lps":    { "maxPullbackAtr": 1.0, "volBelowMa": true },
    "lpsy":   { "maxRallyAtr": 1.0, "volBelowMa": true }
  },
  "shareFlow": {
    "enabled": true,
    "zWindow": 60,
    "cumulativeDays": 3,
    "staleMaxDays": 2
  },
  "entry": {
    "all": [
      { "event": "spring", "withinBars": 5,
        "require": { "closeBackInRange": true, "volumeZ": { "gte": 1.0 } } },
      { "phase": { "in": ["accumulation_C", "accumulation_D"], "minConfidence": 0.6 } },
      { "weekly": { "phaseIn": ["accumulation", "markup"], "closeAboveMa": 30 } },
      { "shareFlow": { "cumulativeDays": 3, "gt": 0, "requireFresh": true } }
    ]
  },
  "exit": {
    "any": [
      { "event": "utad", "withinBars": 3 },
      { "event": "sow", "withinBars": 2 },
      { "event": "lpsy", "withinBars": 3 },
      { "stopLoss": { "reference": "eventLow", "event": "spring", "bufferAtr": 0.5 } }
    ]
  },
  "execution": {
    "fillAt": "nextOpen",
    "tPlus1": true,
    "position": { "type": "riskBased", "riskPct": 0.01, "maxPositionPct": 1.0 },
    "feeRate": 0.0003,
    "minFee": 5,
    "slippageBps": 2,
    "lotSize": 100,
    "cancelIfInvalidated": true
  },
  "notification": {
    "mode": "candidate",
    "channels": ["feishu-main", "telegram-main"],
    "aggregateDaily": true
  }
}
```

### 7.2 条件 AST

- 组合：`all` / `any` / `not`。
- 事件类：`event`（`withinBars` 从 `detectedAt` 起算）、`require`（事件证据条件）。
- 状态类：`phase`、`weekly`、`shareFlow`。
- 过滤类：`filter`（原生指标条件，如 `closeAbove(ma50)`、`volZ`）。
- 风险类：`stopLoss`（结构位 + buffer）、`takeProfit`、`trailingStop`。
- 原生指标条件格式：

```json
{ "filter": { "fn": "closeAbove", "input": "ma50", "value": true } }
```

- 校验：拒绝未知字段、非法周期、越界参数；`riskBased` 必须提供可用止损位。

### 7.3 模板

1. 吸筹 Spring 反转（Spring + 阶段 C/D + 周线不空头 + 份额净申购）
2. SOS 突破回踩（SOS + LPS）
3. UTAD 派发离场（仅离场 / 减仓）
4. SOW 破位止损
5. 份额净申购 + Spring（ETF 特有 confluence）

### 7.4 版本化

- `engine` 固定为 `wyckoff-v1`；算法实现变更时升级为 `wyckoff-v2`。
- 策略保存时校验并补默认值；回测/模拟保存 `config_snapshot`。
- 旧运行结果永远按当时的引擎版本与配置解释。

---

## 8. 回测引擎

### 8.1 成交模型

- 第 t 根 bar 收盘后评估信号；默认 `fillAt=nextOpen` → 第 t+1 根 bar 开盘成交。
- 入场价 = 开盘价 × (1 + slippageBps / 10000)；出场价 = 开盘价 × (1 - slippageBps / 10000)。
- 手续费 = `max(minFee, 成交额 × feeRate)`；ETF 无印花税。
- 数量按 `lotSize` 向下取整。
- **T+1**：当日买入不可卖；出场检查 `sellableUnits`。
- **开盘失效取消**：`cancelIfInvalidated=true` 时，若次日开盘已跌破结构失效位（多头），入场订单取消。
- **止损/离场**：按收盘确认，次日开盘执行；不做盘中触发。
- v1 单仓位、不加仓、不减仓（分批/金字塔放 P4）。

### 8.2 仓位

- `riskBased`：
  - `riskAmount = equity × riskPct`；
  - `stopDistance = 参考入场价 - 止损位`；
  - `qty = floor(min(riskAmount / stopDistance, equity × maxPositionPct / close) / lotSize) × lotSize`。
- 若止损位不可用或 `stopDistance <= 0`，策略校验失败，不进行回测。

### 8.3 指标

- 总收益、年化收益、最大回撤、回撤区间；
- 夏普、索提诺、卡玛；
- 胜率、盈亏比、Profit Factor、交易次数、平均持仓天数、暴露率；
- 基准：买入持有 ETF（同期、同费用）与指数；
- 按事件类型/阶段的交易表现归因；
- 月度收益矩阵。

### 8.4 任务与存储

- `POST /api/strategies/:id/backtests` 创建异步任务；
- 冷缓存时按日拉取份额，任务记录 `progress`（已取天数/总天数）；
- `GET /api/backtests/:id` 轮询；
- 结果保存：`metrics_json`、`equity_json`（date/equity/benchmark/drawdown）、`trades_json`（含事件证据、reason）、`status`、`error`；
- 同一策略/区间/配置 + 相同数据版本可命中缓存。

### 8.5 无未来函数自检

- 截断历史数据，重算过去信号，结果必须与完整数据一致；
- 周线背景必须使用上一完整周；
- 事件研究使用 `detectedAt` 和次日开盘，不使用事件发生日的收盘价。

---

## 9. 模拟盘（双账本，定稿保留）

### 9.1 规则模拟盘（自动）

- 每个规则信号（候选）自动生成待成交订单；
- 次日开盘按回测同一规则成交/取消；
- 记录现金、持仓、可卖数量、净值、交易；
- 用途：评估策略本身，不受人工干预影响。

### 9.2 人工确认盘

- 候选信号进入监控页，状态为 `candidate`；
- 人工点击「确认」→ 记录到人工账本；点击「忽略」→ 标记 `ignored`；
- 人工账本同样按次日开盘结算（与回测口径一致），不启用“用户手填成交价”，避免口径漂移；
- 用途：评估「人工过滤」相对「规则自动」的增益或损耗。

### 9.3 待成交与结算

- 信号生成时创建 `paper_orders(status=pending)`；
- 下一次调度（或手动检查）时取信号日之后第一个交易日开盘价：
  - 若已失效且 `cancelIfInvalidated` → `cancelled`；
  - 否则 `filled`，写入 `paper_trades`；
- 服务停机错过开盘：仍按信号后第一个交易日开盘价补结算；若该日已超过 `maxSettlementLag=5` 个交易日，标记 `missed` 并发送系统提醒，不伪造成交；
- 双账本各自独立结算，互不影响。

### 9.4 对照展示

- 模拟盘页并列展示：规则自动净值 vs 人工确认净值 vs 买入持有基准；
- 统计：信号总数、确认率、忽略率、人工相对规则的收益差；
- 支持按策略、区间切换。

---

## 10. 监控

### 10.1 调度

- 生产进程内每 30 秒 tick；开发环境不启动。
- 策略按数据依赖选择检查时点：
  - **15:10**：纯价格事件（Spring / SOS / UTAD / SOW 收盘已确认）；
  - **18:40**：依赖份额的策略；份额未发布则重试，最晚 **22:00**。
- 仅交易日运行（交易日历）。
- 环境变量 `ENABLE_MONITOR=1` 控制生产启动；提供 `POST /api/strategies/:id/check` 手动检查。

### 10.2 信号生成

- 拉取最新日 K / 份额（必要时绕过当日缓存）；
- 调用同一流式分析器，取 `detectedAt = 最新交易日` 的新事件；
- 结合阶段迁移、持仓状态、入场/出场规则，生成：
  - `entry_candidate`
  - `exit_candidate`
  - `phase_change`（观察类，可配置是否推送）
- 写入 `signals`，规则账本自动创建待成交订单；人工账本等待确认。

### 10.3 去重与幂等

- 唯一键：`strategy_id + symbol + range_id + event_type + occurred_at + detected_at + action`；
- 数据库 `UNIQUE` 约束；
- 重启、重复计算、手动检查均不重复推送、不重复下单；
- 同一轮多策略/多信号按渠道合并为一条消息。

### 10.4 补跑

- 启动时读取 `strategy_state.last_bar`，补齐到最新交易日；
- 历史信号入库，但通知只发最新一条（可配置补发窗口）；
- 补跑期间若份额缺失，按新鲜度规则处理并记录错误。

### 10.5 异常

- 数据拉取失败：记录日志，重试；超过窗口后向默认渠道发送「数据不可用」系统提醒；
- 单策略计算异常：隔离该策略，不影响其他策略；
- 通知失败：记录 `notify_log`，按退避重试，不阻塞监控主流程。

---

## 11. 通知

### 11.1 适配器抽象

```js
// notify/<type>.js
export default {
  type: 'feishu',
  validateConfig(config) { ... },
  async send(config, message) { ... }, // -> { ok, status, response }
}
```

- 注册表按 `notify_channels.type` 分发；
- 统一消息结构：

```json
{
  "level": "candidate",
  "title": "【威科夫候选】510300 沪深300ETF",
  "markdown": "事件：Spring（吸筹 C，置信度 0.72）...",
  "fields": {
    "event": "spring",
    "occurredAt": "2026-11-19",
    "detectedAt": "2026-11-19",
    "range": "3.95–4.15",
    "action": "entry_candidate",
    "referencePrice": 4.06,
    "invalidation": 3.91
  },
  "link": "http://127.0.0.1:8765/#/monitor/signals/<id>"
}
```

### 11.2 飞书

- 自定义机器人 webhook；支持可选的 timestamp + secret 签名校验；
- 优先使用 interactive card；失败或超长时回退 text；
- 单条长度受限，超出时截断并附详情链接。

### 11.3 Telegram

- Bot API `sendMessage`，配置 `botToken`、`chatId`；
- `parseMode=HTML`；
- `apiBase` 可配置（默认 `https://api.telegram.org`），大陆网络可配置代理/自建 Bot API；
- 失败重试 3 次，指数退避。

### 11.4 微信（本期不做）

- 保留 `notify_channels.type` 与适配器注册表；
- 个人微信群无官方机器人 API，后续若接入需明确采用企业微信群机器人或第三方推送，并接受相应风险。

### 11.5 安全

- secret 只存服务端；API 返回时脱敏（只显示末尾若干字符）；
- 可选 `APP_SECRET_KEY` 环境变量对 `config_json` 的密钥字段做 AES-GCM 加密存储；
- 日志不打印完整 webhook URL / bot token；
- 默认只监听 `127.0.0.1`；公网部署必须加 token 鉴权。

### 11.6 日志、重试、限流

- `notify_log` 记录：渠道、信号、消息预览（脱敏）、HTTP 状态、错误、时间；
- 失败指数退避重试 3 次；
- 单渠道串行发送，约 1 条/秒；企微若后续接入需遵守其限流；
- 每日汇总模式：同一渠道一轮只发一条，避免刷屏。

---

## 12. 数据库（SQLite）

- `PRAGMA journal_mode=WAL;`
- `PRAGMA foreign_keys=ON;`
- 使用 `node:sqlite` 的 `DatabaseSync`；启动时执行 `schema.sql` + 轻量迁移。

```sql
CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued|running|done|failed
  progress REAL NOT NULL DEFAULT 0,
  metrics_json TEXT,
  equity_json TEXT,
  trades_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_accounts (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  ledger TEXT NOT NULL,            -- rule|manual
  cash REAL NOT NULL,
  units INTEGER NOT NULL,
  sellable_units INTEGER NOT NULL,
  avg_cost REAL NOT NULL,
  last_equity REAL,
  updated_at TEXT NOT NULL,
  UNIQUE(strategy_id, ledger)
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  signal_id TEXT,
  ledger TEXT NOT NULL,            -- rule|manual
  side TEXT NOT NULL,              -- buy|sell
  qty INTEGER NOT NULL,
  signal_date TEXT NOT NULL,
  fill_date TEXT,
  fill_price REAL,
  status TEXT NOT NULL,            -- pending|filled|cancelled|missed
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL,
  trade_date TEXT NOT NULL,
  signal_id TEXT,
  pnl REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  range_id TEXT,
  event_type TEXT NOT NULL,
  occurred_at TEXT,
  detected_at TEXT NOT NULL,
  action TEXT NOT NULL,            -- entry_candidate|exit_candidate|phase_change
  price REAL,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'candidate', -- candidate|confirmed|ignored|expired
  created_at TEXT NOT NULL,
  UNIQUE(strategy_id, symbol, range_id, event_type, occurred_at, detected_at, action)
);

CREATE TABLE IF NOT EXISTS strategy_state (
  strategy_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  last_bar TEXT,
  last_phase TEXT,
  last_confidence REAL,
  last_action TEXT,
  last_event_key TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- feishu|telegram|(reserved: wecom)
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_log (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  signal_id TEXT,
  payload_preview TEXT,
  status TEXT NOT NULL,            -- ok|failed
  http_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_strategy_date
  ON signals(strategy_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_orders_status
  ON paper_orders(status, signal_date);
CREATE INDEX IF NOT EXISTS idx_notify_log_created
  ON notify_log(created_at);
```

---

## 13. API 设计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（现有） |
| GET | `/api/search?q=` | ETF 搜索（现有） |
| GET | `/api/shares?code=&start=&end=` | 份额（现有） |
| GET | `/api/index?code=&start=&end=` | 指数（现有） |
| GET | `/api/kline?code=&start=&end=` | 日 K（新增） |
| GET | `/api/snap?code=` | 实时快照（新增） |
| GET | `/api/calendar?start=&end=` | 交易日历（新增） |
| GET/POST | `/api/strategies` | 策略列表 / 新建 |
| GET/PUT/DELETE | `/api/strategies/:id` | 详情 / 更新 / 删除 |
| POST | `/api/strategies/:id/backtests` | 创建回测任务 |
| GET | `/api/backtests/:id` | 查询任务进度/结果 |
| GET | `/api/strategies/:id/runs` | 历史回测列表 |
| POST | `/api/research/events` | 事件研究（code、区间、参数） |
| GET | `/api/research/candles` | 标注图数据（K 线 + 事件 + 区间） |
| POST | `/api/strategies/:id/check` | 手动检查 |
| GET | `/api/strategies/:id/signals` | 信号列表 |
| POST | `/api/signals/:id/confirm` | 人工确认 |
| POST | `/api/signals/:id/ignore` | 人工忽略 |
| GET | `/api/strategies/:id/paper?ledger=` | 模拟盘账户 |
| GET | `/api/strategies/:id/paper/orders` | 待成交/历史订单 |
| GET/POST | `/api/channels` | 渠道列表 / 新建 |
| PUT/DELETE | `/api/channels/:id` | 更新 / 删除 |
| POST | `/api/channels/:id/test` | 测试发送 |
| GET | `/api/notify-log?limit=` | 发送日志 |
| GET/PUT | `/api/settings` | 全局设置 |

约定：

- 错误统一 `{ error: "..." }`；参数错误 400，未找到 404，冲突 409，上游数据失败 502；
- 不在响应中返回 webhook / bot token 明文；
- 回测任务状态：`queued → running → done|failed`。

---

## 14. 前端

### 14.1 页面

- **行情查看**：现有页面平移，保持功能不变。
- **策略**：策略列表、新建/编辑、模板、启用开关、通知渠道、账本开关。
- **研究**：标的 + 区间 + 参数；标注行情图；事件列表；事件研究统计；参数调整实时预览。
- **回测**：任务进度、指标卡片、净值/基准/回撤曲线、交易表、买卖点标记、按事件类型归因。
- **模拟盘**：规则自动 vs 人工确认双净值、账户、待成交订单、成交历史。
- **监控**：策略状态、上次/下次检查、候选信号、确认/忽略、发送记录。
- **设置**：飞书 / Telegram 渠道、测试发送、数据状态、运行状态。

### 14.2 标注图

- K 线 + 成交量；
- 区间框（上沿/下沿/起始日）；
- swing 高低点；
- 事件 marker：SC / AR / ST / Spring / UTAD / SOS / SOW / LPS / LPSY；
- 阶段色带 + 置信度；
- 买卖点 marker（回测/模拟盘）；
- 成交量按 effort/result 着色；
- 周线背景摘要（趋势、区间位置）。

### 14.3 策略编辑器

- 事件卡片 + 确认条件 + 阶段过滤 + 周线过滤 + 份额过滤；
- 参数输入带默认值和取值范围；
- 结构性止损选择（事件低点/区间下沿/LPS 低点）；
- 高级 JSON 视图（双向同步，校验失败时阻止保存）；
- 保存前做 schema 校验。

### 14.4 研究面板

- 事件列表：类型、发生日、确认日、区间、量能证据、阶段；
- 点击定位图表；
- 前瞻收益统计表（5/10/20/60 日）；
- 参数调整后即时重算（前端调用研究接口）。

---

## 15. 测试策略

使用 Node 内置 `node:test`（零新增依赖）：

1. **指标黄金测试**：SMA/EMA/ATR/ZScore 等固定输入输出。
2. **合成 fixture**：
   - 吸筹区间 + Spring；
   - 派发区间 + UTAD；
   - SOS/LPS、SOW/LPSY 序列；
   - 验证事件类型、`occurredAt`、`detectedAt`、区间边界。
3. **无未来函数**：截断未来 bar 重算，过去信号逐项一致。
4. **周线 as-of**：跨越周末时只能看到上一完整周。
5. **回测确定性**：相同数据 + 配置 → 相同净值/交易；含手续费、滑点、T+1、开盘失效取消。
6. **事件研究**：入场时点、前瞻窗口、MFE/MAE 计算正确。
7. **信号去重**：重复运行、重启、手动检查不产生重复 `signals` / 订单 / 推送。
8. **API 校验**：非法代码、区间、策略配置返回 400。
9. **通知适配器**：mock fetch，验证飞书/Telegram 载荷、失败重试、日志落库。

---

## 16. 实施计划

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| **P0（1–2 天）** | 日 K / 快照 / 日历接口；SQLite + schema；`shared/indicators.js`；前端拆页骨架；复权验证 | `/api/kline` 返回 1300 根；`node --test` 通过；现有查看器功能不变 |
| **P1（3–5 天）** | 流式 Wyckoff 分析器；核心事件；周线背景；份额流；事件研究；回测核心 | 合成 fixture 能识别 Spring/UTAD；截断测试通过；510300 事件统计可输出 |
| **P2（3–5 天）** | 标注行情图；事件研究面板；策略编辑器；回测结果页 | 能新建「Spring 吸筹」策略、跑回测、看到区间/事件/买卖点/收益指标 |
| **P3（2–3 天）** | 规则模拟盘 + 人工确认盘；EOD 调度；信号去重；飞书 / Telegram；发送日志 | 同一信号重启后不重复推送；待成交按次日开盘结算；两个渠道收到测试消息 |
| **P4（按需）** | 参数扫描；完整 Phase A–E；周线事件；P&F 目标位；图表截图推送；公网鉴权 | 按需验收 |

预计总计 **2–3 周**（个人开发节奏）；主要不确定性在事件阈值校准，不在架构。

---

## 17. 风险与待验证

| 优先级 | 风险 | 处理 |
| --- | --- | --- |
| ~~高~~ → 已缓解 | yunhq 日 K 未复权，长回测收益失真 | 已验证并实现前复权：自动识别 + 人工确认 + 统一口径 + 回测记录 dataVersion |
| 高 | Wyckoff 事件阈值敏感，误报多 | 事件研究 + 人工标注 + 参数校准；默认使用候选语义 |
| 高 | 未来函数（pivot 确认、AR、周线、区间边界） | 流式分析器 + 截断测试 + 周线 as-of |
| 中 | ETF 只能做多 | UTAD/SOW/LPSY 仅离场/减仓 |
| 中 | 份额 T 日晚发布、缺失、5 年限制 | 新鲜度规则 + 重试窗口 + 区间校验 |
| 中 | 进程需常驻 | Windows 任务计划/NSSM；Linux systemd；启动补跑 |
| 中 | 事件参数过拟合 | 事件研究仅用于校准，不自动择优；保留样本外区间 |
| 低 | 公网部署泄露 webhook | 默认 127.0.0.1；外网加 token；secret 脱敏 |
| 低 | 已退市 ETF 缺失 | 明确仅覆盖当前上交所 ETF |

---

## 18. 术语表

| 中文 | 英文 | 含义 |
| --- | --- | --- |
| 吸筹 | Accumulation | 主力在区间内收集筹码 |
| 派发 | Distribution | 主力在区间内派发筹码 |
| 卖出高潮 | Selling Climax (SC) | 下跌末端的恐慌性放量 |
| 自动反弹 | Automatic Rally (AR) | SC 后的反弹，定义区间上沿 |
| 二次测试 | Secondary Test (ST) | 回踩 SC 低点确认供给耗尽 |
| 弹簧 | Spring | 跌破区间下沿后快速收回的震仓 |
| 测试 | Test | Spring 后的低量回踩 |
| 强势信号 | Sign of Strength (SOS) | 放量突破区间上沿 |
| 最后支撑点 | Last Point of Support (LPS) | SOS 后缩量回踩守住突破位 |
| 买入高潮 | Buying Climax (BC) | 上涨末端的放量 |
| 上冲回落 | Upthrust (UT) | 突破区间上沿后收回 |
| 派发后上冲 | UTAD | 派发阶段末期的假突破 |
| 弱势信号 | Sign of Weakness (SOW) | 放量跌破区间下沿 |
| 最后供应点 | Last Point of Supply (LPSY) | SOW 后缩量反弹受阻 |
| 努力与结果 | Effort vs Result | 成交量（努力）与价格进展（结果）的背离 |
| 因果 | Cause and Effect | 区间蓄势（因）对应后续行情幅度（果） |

---

## 19. AI 助手与策略生成

- 支持任意 **OpenAI-compatible chat/completions** 端点：`baseUrl`、`model`、可选 `apiKey`、`temperature`、`maxTokens`；配置只存服务端，接口返回脱敏。
- 新增「AI 助手」页：
  - 基于 `code + 区间 + 可选份额流` 构建紧凑上下文（阶段、区间、最近事件、事件研究、最近 60 根日 K）；
  - 「分析数据」输出结构化威科夫分析；
  - 「生成策略」要求 AI 输出 DSL JSON，服务端解析并调用 `validateStrategyConfig` 校验；
  - 校验通过后可直接 `/api/backtests/quick` 回测，并在页面展示指标、净值、交易。
- AI 生成策略的约束：只做多、riskBased 必须含 `stopLoss`、`fillAt=nextOpen`、不支持未实现节点；AI 输出只作为数据，不执行任意代码。
- 新增 `GET /api/strategy-authoring/schema` 与 `docs/ai-strategy-authoring.md`，供未来 AI/外部工具读取契约。
- 下一步：把 AI 生成的策略保存为不可变版本（draft → validated → active），再接入沙箱 JS 策略。

## 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1.0 | 2026-11-19 | 定稿：Wyckoff 事件层 + 声明式 DSL；日线 + 周线背景；纳入份额流；收盘后日频监控；飞书/Telegram；**规则模拟盘与人工确认盘双账本保留**；微信暂缓。 |
| v1.1 | 2026-11-19 | 增加 AI 助手：OpenAI-compatible 模型配置、行情上下文分析、AI 生成 DSL 策略、服务端校验与快速回测；新增 AI 策略编写契约。 |
| v1.2 | 2026-11-19 | 验证并实现前复权（除息事件表 + 自动识别 + 人工确认）；回测绑定策略版本并记录 `dataVersion`；新增轻量 DB 迁移，旧库自动补列。 |

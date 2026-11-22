# ETF 份额 × 指数（Vite + React + antd 前后端一体化）

> **第一次使用请先看 [docs/user-guide.md](docs/user-guide.md)** — 完整的功能介绍与分步使用说明。
>
> 其他文档：[部署与安全](docs/deployment.md) ｜ [技术方案](docs/wyckoff-strategy-design.md) ｜ [参数校准记录](docs/wyckoff-calibration-2026-11-19.md) ｜ [AI 策略契约](docs/ai-strategy-authoring.md)

输入 ETF 代码或关键词，查看上交所 ETF **总份额**走势，并与**指数**（默认上证指数）叠加对比。数据全部来自上海证券交易所。

- **收藏**：查询后可点 ☆（或按 `F`）收藏，收藏项显示在输入框下方，点击即快速查看；点标签上的 × 移除。收藏存 `localStorage`，不随账号同步。
- **时间范围**：近 1 月 / 3 月 / 6 月 / 1 年 / 2 年 / 3 年 / 5 年预设，也可用 antd `RangePicker` **自定义起止日期**。超过 5 年自动截断。
- **叠加指数可自定义**：默认上证指数，内置沪深300、上证50、中证500、科创50、中证1000 等，也可在下拉底部输入任意 6 位指数代码。
- **空数据填充**：区间内没有数据的交易日按**空值**处理，曲线断开而不补 0（节假日、未上市、请求失败都不影响）。
- **自动恢复**：刷新页面后自动恢复上次查询的 ETF、时间范围与叠加指数。

## 策略管理

顶部「策略管理」页：策略列表、启停开关、详情抽屉。

详情里可以看到：

- **版本历史**：每个版本的状态（草稿 / 已校验 / 启用中 / 已归档）、校验结果、来源（AI 模型或人工）；
- **回测记录**：区间、收益、基准、回撤、复权口径、绑定的版本；
- **一键操作**：校验、启用、回测。

策略内容按版本不可变；修改会产生新版本，历史回测可按当时的版本与数据口径复现。

## 监控与模拟盘

顶部「监控」页：

- **候选信号**：收盘后按策略条件检测，展示事件、阶段、区间、失效位，可直接**确认**或**忽略**；
- **双账本模拟盘**：`规则账本`自动成交（评估策略本身）、`人工确认账本`手工确认后才挂单；
- **通知渠道**：飞书群机器人 / Telegram，支持测试发送，密钥仅存服务端且返回脱敏；
- **发送记录**：每次发送的渠道、状态、HTTP 状态与内容摘要。

调度时点：价格类事件 15:10；依赖 ETF 份额 18:40（未发布则重试至 22:00）。非交易日自动跳过。

开发环境（`npm run dev`）不启动自动调度，用页面上的「立即检查」；生产 `npm start` 启动后自动运行，可用 `ENABLE_MONITOR=0` 关闭。

> 信号是**候选**不是指令；结算口径与回测一致（信号日次日开盘成交，含滑点/佣金/T+1/结构失效取消）。进程未常驻时，落后过多的订单会标记 `missed` 而不是伪造成交。

## AI 助手

顶部切换到「AI 助手」，在「模型设置」中填写任意 **OpenAI-compatible chat/completions** 端点：

- `baseUrl`：如 `https://api.deepseek.com`、`https://api.openai.com/v1`、`https://api.moonshot.cn/v1`、`http://127.0.0.1:11434/v1`；
- `model`：如 `deepseek-chat`、`gpt-4o-mini`、`qwen-plus`；
- `apiKey`：可选，本地 Ollama 等可留空；
- `temperature` / `maxTokens` 可按需调整。

助手会基于当前标的、区间、事件与最近日 K 生成分析，或生成 Wyckoff DSL 策略；策略会先通过服务端校验、存为草稿版本，再可直接回测或启用。API Key 只保存在服务端 SQLite，接口返回脱敏。

后端使用官方 `openai` npm 包调用，任何兼容 `/chat/completions` 的服务都可直接接入。

在「模型设置」里可以看到**近 30 天用量**（调用次数、失败次数、输入/输出 token），便于估算成本。用量只记 token 与模型元信息，不保存提示词全文。

也可用环境变量作为无数据库配置时的回退：`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`、`AI_TEMPERATURE`、`AI_MAX_TOKENS`。

AI 策略编写契约见 `docs/ai-strategy-authoring.md`，也可通过 `GET /api/strategy-authoring/schema` 获取。

## 运行（需要 Node ≥ 22.5）

```bash
pnpm install
pnpm dev             # 开发：http://localhost:5173 （页面 + /api 同一个服务，带热更新）
pnpm test            # 运行 node:test 测试
```

生产使用：

```bash
pnpm build           # 构建前端到 dist/
pnpm start           # http://localhost:8765 （托管 dist/ + /api）
# 常用环境变量：
#   PORT=9000 HOST=127.0.0.1
#   APP_SECRET_KEY=<随机串>    敏感字段加密，未配置则明文落库（启动会告警）
#   APP_AUTH_TOKEN=<随机串>    访问令牌；对外监听时必须设置
#   ENABLE_MONITOR=0          关闭收盘后自动调度
```

> **安全**：默认只监听 `127.0.0.1`。改成 `0.0.0.0` 前必须设置 `APP_AUTH_TOKEN`，否则任何人都能调用接口（包括触发 AI 消耗额度）。详见 [docs/deployment.md](docs/deployment.md)。

也可以 `pnpm preview`（Vite 预览构建产物，同样带 /api）。

## 结构

```
index.html            页面骨架（挂载 #root）
src/
  main.jsx            React 入口：搜索、收藏(localStorage)、时间范围面板、指数选择、加载进度、导出 CSV
  chart.js            图表：prepare/computeStats 纯函数 + buildOption（份额 + 指数双轴叠加，下方份额日变化柱）
  indices.js          内置指数清单（代码 → 名称）与默认值
  api.js              调用同源 /api/*
  style.css
server/
  sse.js              上交所数据访问（带 Referer 代请求、按日缓存到 .cache/）
  api.js              /api/* 路由中间件（Vite dev/preview 与生产共用）
  prod.js             生产服务器：静态托管 dist/ + /api
vite.config.js        挂载 @vitejs/plugin-react 与 server/api.js 中间件
```

## 接口

| 路径 | 说明 |
| --- | --- |
| `GET /api/search?q=` | 按代码前缀或名称关键词搜索沪市 ETF |
| `GET /api/shares?code=510300&start=YYYY-MM-DD&end=YYYY-MM-DD` | 某 ETF 的每日份额（万份）。区间内每个工作日都返回；当日无数据为 `null`。最多回最近 5 年（`MAX_RANGE_DAYS=1830`） |
| `GET /api/index?code=000001&start=&end=` | 某指数日收盘价（`code` 缺省为上证指数 000001） |
| `GET /api/kline?code=&start=&end=&adjust=` | 日 K（OHLCV）。默认返回前复权；`adjust=none` 取原始价 |
| `GET /api/dividends?code=` | 某标的的除息事件列表 |
| `POST /api/dividends/detect` | 自动识别除息候选，入库为「待确认」 |
| `POST /api/dividends/confirm` | 人工确认/取消除息事件（确认后才参与复权） |
| `POST /api/research/events` | 跑 Wyckoff 事件识别 + 事件研究，返回事件、区间、逐日状态 |
| `POST /api/research/param-suggest` | **参数推荐**：用事件研究样本给每个事件分组打分，返回建议阈值（`minSamples` / `minGain` / `trainEnd` 可调） |

## 说明

- **价格复权**：行情接口返回的日 K **不复权**，ETF 分红会在除息日留下向下跳空（实测 510880 十年买入持有收益：未复权 25.31% vs 前复权 76.13%）。系统提供除息事件管理：在「策略研究」页点「自动识别」，确认后即参与前复权；K 线、事件研究、回测、AI 上下文使用同一口径。自动识别是启发式结果，必须人工确认。
- 上交所接口要求 `sse.com.cn` 的 Referer，浏览器无法伪造，所以必须经由本服务端请求。
- 份额接口一天只能查一次全市场，查询区间越长首次越慢；已过去的交易日会缓存在 `.cache/`，之后秒开。
  近 5 年约 1200 个交易日，首次全冷缓存需数十秒（前端按月分块、边拉边画，可实时看到进度）。
- 接口返回的 `series` 对区间内每个工作日都给一条：有数据为 `[date, 万份]`，无数据（节假日、未上市、请求失败）为 `[date, null]`，
  前端按空值断开曲线，不会补 0 造成假跌。
- 仅覆盖上交所 ETF（5 开头）；深交所 159 开头及已退市产品不支持。SSE 份额数据最早可追溯到 2013 年前后，但接口限最近 5 年。
- 环境变量（调试用）：`SSE_QUERY_URL`、`SSE_YUNHQ_URLS`、`CACHE_DIR`。

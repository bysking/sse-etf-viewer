# ETF 份额 × 指数（Vite + React + antd 前后端一体化）

输入 ETF 代码或关键词，查看上交所 ETF **总份额**走势，并与**指数**（默认上证指数）叠加对比。数据全部来自上海证券交易所。

- **收藏**：查询后可点 ☆（或按 `F`）收藏，收藏项显示在输入框下方，点击即快速查看；点标签上的 × 移除。收藏存 `localStorage`，不随账号同步。
- **时间范围**：近 1 月 / 3 月 / 6 月 / 1 年 / 2 年 / 3 年 / 5 年预设，也可用 antd `RangePicker` **自定义起止日期**。超过 5 年自动截断。
- **叠加指数可自定义**：默认上证指数，内置沪深300、上证50、中证500、科创50、中证1000 等，也可在下拉底部输入任意 6 位指数代码。
- **空数据填充**：区间内没有数据的交易日按**空值**处理，曲线断开而不补 0（节假日、未上市、请求失败都不影响）。
- **自动恢复**：刷新页面后自动恢复上次查询的 ETF、时间范围与叠加指数。

## AI 助手

顶部切换到「AI 助手」，在「模型设置」中填写任意 **OpenAI-compatible chat/completions** 端点：

- `baseUrl`：如 `https://api.deepseek.com`、`https://api.openai.com/v1`、`https://api.moonshot.cn/v1`、`http://127.0.0.1:11434/v1`；
- `model`：如 `deepseek-chat`、`gpt-4o-mini`、`qwen-plus`；
- `apiKey`：可选，本地 Ollama 等可留空；
- `temperature` / `maxTokens` 可按需调整。

助手会基于当前标的、区间、事件与最近日 K 生成分析，或生成 Wyckoff DSL 策略；策略会先通过服务端校验，再可直接回测。API Key 只保存在服务端 SQLite，接口返回脱敏。

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
# 可选环境变量：PORT=9000 HOST=0.0.0.0
```

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

## 说明

- 上交所接口要求 `sse.com.cn` 的 Referer，浏览器无法伪造，所以必须经由本服务端请求。
- 份额接口一天只能查一次全市场，查询区间越长首次越慢；已过去的交易日会缓存在 `.cache/`，之后秒开。
  近 5 年约 1200 个交易日，首次全冷缓存需数十秒（前端按月分块、边拉边画，可实时看到进度）。
- 接口返回的 `series` 对区间内每个工作日都给一条：有数据为 `[date, 万份]`，无数据（节假日、未上市、请求失败）为 `[date, null]`，
  前端按空值断开曲线，不会补 0 造成假跌。
- 仅覆盖上交所 ETF（5 开头）；深交所 159 开头及已退市产品不支持。SSE 份额数据最早可追溯到 2013 年前后，但接口限最近 5 年。
- 环境变量（调试用）：`SSE_QUERY_URL`、`SSE_YUNHQ_URLS`、`CACHE_DIR`。

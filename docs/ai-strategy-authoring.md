# AI 策略编写契约（v1）

> 给 AI 或外部工具使用的系统契约。AI 生成的策略必须先校验、再回测、人工审核后才能进入监控。

## 1. 可用接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/strategy-authoring/schema` | 返回当前支持的 DSL 结构、事件、条件、执行参数和示例 |
| PUT | `/api/ai/config` | 保存 baseUrl / model / API Key |
| GET | `/api/ai/config` | 返回脱敏配置（不含 Key） |
| POST | `/api/ai/analyze` | 基于行情上下文做分析 |
| POST | `/api/ai/strategy` | 生成策略 JSON，并返回服务端校验结果 |
| POST | `/api/ai/chat` | 基于上一次上下文继续追问 |
| POST | `/api/backtests/quick` | 用一段配置直接回测，不需要先保存策略 |

`/api/ai/analyze` 与 `/api/ai/strategy` 的请求体：

```json
{
  "code": "510300",
  "start": "2025-11-19",
  "end": "2026-11-19",
  "includeShares": false,
  "question": "分析当前结构",
  "instructions": "生成一个 Spring 反转策略"
}
```

## 2. 策略结构

```json
{
  "schemaVersion": 1,
  "engine": "wyckoff-v1",
  "name": "策略名",
  "symbol": "510300",
  "wyckoff": {},
  "entry": { "all": [ 条件 ] },
  "exit": { "any": [ 条件, { "stopLoss": { ... } } ] },
  "execution": {
    "fillAt": "nextOpen",
    "tPlus1": true,
    "position": { "type": "riskBased", "riskPct": 0.01, "maxPositionPct": 1 },
    "feeRate": 0.0003,
    "minFee": 5,
    "slippageBps": 2,
    "lotSize": 100,
    "cancelIfInvalidated": true
  }
}
```

`entry` / `exit` 支持 `all`、`any`、`not` 组合。

## 3. 条件

### 事件

```json
{ "event": "Spring", "withinBars": 5, "require": { "closeBackInRange": true } }
```

事件名（不区分大小写）：

`SC`、`BC`、`AR`、`ST`、`Spring`、`Test`、`UTAD`、`SOS`、`SOW`、`LPS`、`LPSY`

`require` 支持布尔、数字或比较对象：

```json
{ "volumeZ": { "gte": 1.0 } }
```

### 阶段

```json
{ "phase": { "in": ["accumulation_C", "accumulation_D"], "minConfidence": 0.5 } }
```

阶段：`neutral`、`range`、`accumulation_A` 到 `accumulation_E`、`distribution_A` 到 `distribution_E`、`markup`、`markdown`。

### 周线

```json
{ "weekly": { "phaseIn": ["accumulation", "markup"], "closeAboveMa": true } }
```

### 份额流

```json
{ "shareFlow": { "cumulativeDays": 3, "gt": 0, "requireFresh": true } }
```

### 过滤

```json
{ "filter": { "fn": "closeAbove", "value": true } }
```

`fn` 仅支持 `closeAbove` / `volZ` / `close`。

### 止损

```json
{ "stopLoss": { "reference": "eventLow", "event": "Spring", "bufferAtr": 0.5 } }
```

```json
{ "stopLoss": { "reference": "rangeLow", "bufferAtr": 0.5 } }
```

`reference` 仅支持 `eventLow` / `rangeLow` / `price`。

## 4. 执行与约束

- 只做多；ETF 不支持做空。
- `position.type` 为 `riskBased` 时，`exit` 必须包含 `stopLoss`。
- `fillAt` 只能是 `nextOpen`；T+1 由引擎处理。
- 不支持 `takeProfit` / `trailingStop` 等未实现节点。
- `symbol` 必须是 6 位沪市 ETF 代码。
- 不支持在策略中访问未来数据；`ctx` 只提供截至当前 bar 的信息。
- AI 生成策略默认是 draft，不会自动启用监控。

## 5. 示例

```json
{
  "schemaVersion": 1,
  "engine": "wyckoff-v1",
  "name": "Spring 吸筹反转",
  "symbol": "510300",
  "entry": {
    "all": [
      { "event": "Spring", "withinBars": 5, "require": { "closeBackInRange": true } },
      { "phase": { "in": ["accumulation_C", "accumulation_D"], "minConfidence": 0.5 } }
    ]
  },
  "exit": {
    "any": [
      { "event": "SOS", "withinBars": 4 },
      { "stopLoss": { "reference": "eventLow", "event": "Spring", "bufferAtr": 0.5 } }
    ]
  },
  "execution": {
    "fillAt": "nextOpen",
    "tPlus1": true,
    "position": { "type": "riskBased", "riskPct": 0.01, "maxPositionPct": 1 },
    "feeRate": 0.0003,
    "minFee": 5,
    "slippageBps": 2,
    "lotSize": 100,
    "cancelIfInvalidated": true
  }
}
```

## 6. AI 生成与审核流程

```text
AI 读取 schema → 输出策略 JSON + 解释
→ 服务端解析 + validateStrategyConfig
→ 校验通过自动落 draft 版本（策略 enabled=false）
→ 用户在 AI 页面预览 JSON
→ “回测此版本”（/api/strategy-versions/:id/backtests）
→ 人工查看样本内/样本外结果
→ “启用策略”（promote → active，策略 enabled=true）
→ 模拟盘 → 监控
```

AI 页面已实现以上全部步骤；`active` 目前只表示“策略已启用”，收盘后调度与模拟盘在 P3 接入。

## 6.1 策略版本

AI 生成且校验通过的策略会自动落成 `draft` 版本（不会自动启用）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/strategies/:id/versions` | 版本列表（倒序） |
| POST | `/api/strategies/:id/versions` | 新建版本（内容不可变，版本号自增） |
| GET | `/api/strategy-versions/:id` | 版本详情 |
| POST | `/api/strategy-versions/:id/validate` | 校验：通过则 `draft → validated` |
| POST | `/api/strategy-versions/:id/promote` | 推进状态：`validated` / `active` / `archived` |
| POST | `/api/strategy-versions/:id/backtests` | 按版本回测，结果与版本绑定 |

状态语义：

- `draft`：AI 生成或人工新建，未校验；
- `validated`：通过结构校验，可回测；
- `active`：人工启用，同一策略同时只有一个 active；同步策略配置并 `enabled=true`；
- `archived`：历史版本，策略被停用。

版本内容（`config` / `code`）不可修改；要改只能新建版本，保证历史回测可复现。

## 7. 安全与限制

- API Key 只保存在服务端，接口返回脱敏；AI 页面不接触原始 Key。
- AI 生成内容只作为数据，不作为系统指令执行。
- 服务端校验必须通过才允许回测；后续沙箱执行 JS 策略时还会加 Worker + vm + 超时/内存限制。
- 不要让 AI 生成 `fetch`、`require`、文件读写或任意代码；当前只接受 DSL JSON。

## 8. 给 AI 的系统提示词要点

- 只输出 DSL JSON，不要输出 JS/Python。
- 必须包含 `stopLoss`；`fillAt` 只能是 `nextOpen`。
- 不要发明字段或条件；事件/阶段从上面的列表选择。
- 样本量可能很小；优先选择可解释、不过度拟合的策略。
- SOS 入场需要周线或 LPS 确认；UTAD/SOW 只作为风险提示，不作自动清仓依据。
- 明确说明数据局限，不构成投资建议。

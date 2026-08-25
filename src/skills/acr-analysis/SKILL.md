---
name: acr-analysis
description: '面向 GTM、销售运营和业务运营角色的 Azure Consumed Revenue (ACR) 专业分析 skill。用于通过 msxi_lake_* Remote MCP 查询亚洲六区域、产品与服务层级、AI/Foundry 模型、Top Parent、TPID、Segment、Sales Unit、Territory、Region 等维度，执行构成、排名、下钻、交叉切片和 mapped/unmapped 对账。触发词包括：ACR 分析、区域 ACR、亚洲六区域、GTM 分析、销售运营分析、产品组合、服务层级、AI ACR、Foundry model、Direct Model、Fireworks、DeepSeek、Top Parent、TPID、Segment、Sales Unit、Territory、Region、区域排名、客户排名、ACR breakdown、mix analysis。只读，不提供任意 SQL，不写入业务系统。'
license: Internal Microsoft use only
---

# ACR Analysis

通过只读 `msxi_lake_*` Remote MCP，为 GTM、Sales Operations 和 Business
Operations 用户提供可审计的 ACR 多维分析。默认数据集为
`finhub-asia-acr`，当前湖仓按财政月份发布亚洲六区域快照。

本 skill 是独立执行单元，不依赖其他 skill、脚本或本地数据库。所有业务数字必须
直接来自 MCP 工具结果。

## 1. 核心原则

1. **先发现、后查询。** 在使用任何文本筛选值前，先通过
   `msxi_lake_get_catalog` 获取该维度的精确值。不得猜测、模糊匹配或自动扩大范围。
2. **先检查发布状态。** 每次分析会话首次查询前调用
   `msxi_lake_get_release_status`，确认目标财政月存在且发布完整。
3. **选择正确事实表。**
   - 产品、服务、AI、Foundry、区域产品组合分析使用
     `msxi_lake_query_regional_acr`。
   - 客户与销售组织分析使用 `msxi_lake_query_account_acr`。
   - 两张事实表粒度不同，不得将它们按行直接 join，也不得把两者相加。
4. **默认使用 Finance-net 口径。** 用户未指定 adjustment 口径时，区域产品查询先
   从 catalog 验证并使用 `N/A + Other`。若不存在，停止假设并明确报告可用值。
5. **分页必须完整。** 当 `hasMore=true` 时，使用 `nextOffset` 继续查询，直到
   `hasMore=false`，再做排名、占比或总计。
6. **保留未映射金额。** 账户查询必须报告 `mappedAcr`、`unmappedAcr` 及未映射
   占比。不得伪造 TPID，也不得把 unmapped 静默归入某个客户或组织。
7. **只报告证据。** 不从单月 ACR 推断客户意图、竞争输赢、迁移、流失或销售绩效。
   可以描述数值信号，但业务原因必须标为待验证假设。
8. **只读与最小披露。** 绝不调用写工具；只返回回答问题所需的最低粒度，不主动
   展示客户标识。跨客户或大范围结果优先聚合到组织层级。

## 2. 可用工具

| 工具 | 用途 | 何时调用 |
|---|---|---|
| `msxi_lake_get_release_status` | 发布 ID、期间、文件校验与 reconciliation 状态 | 每次分析会话首次查询 |
| `msxi_lake_get_catalog` | 可用期间、维度及精确维度值 | 查询前发现维度和筛选值 |
| `msxi_lake_query_regional_acr` | 区域、产品、服务、AI、Foundry 聚合 | 产品和区域产品组合问题 |
| `msxi_lake_query_account_acr` | 客户、销售组织、地理组织聚合 | GTM、账户和销售运营问题 |

所有查询均为只读。`fiscalMonth` 必填，格式示例为 `FY27-Jul`；`limit`
默认 50、最大 200。

## 3. 维度字典

### 3.1 区域产品事实

`msxi_lake_query_regional_acr.groupBy` 支持：

| 业务含义 | groupBy 值 |
|---|---|
| 亚洲区域 | `area` |
| Service L1–L5 | `service-l1`、`service-l2`、`service-l3`、`service-l4`、`service-l5` |
| AI hierarchy L1–L5 | `ai-l1`、`ai-l2`、`ai-l3`、`ai-l4`、`ai-l5` |
| Foundry model | `model` |
| Foundry deployment type | `deployment` |
| Foundry offer type | `offer` |
| ACR adjustment group | `adjustment` |

对应筛选参数为：

`area`、`serviceLevel1`–`serviceLevel5`、`aiHierarchyLevel1`–
`aiHierarchyLevel5`、`foundryModel`、`foundryDeploymentType`、
`foundryOfferType`、`adjustmentTypeGroup`。

### 3.2 账户与销售组织事实

`msxi_lake_query_account_acr.groupBy` 支持：

| 业务含义 | groupBy 值 |
|---|---|
| Top Parent | `top-parent-id`、`top-parent-name` |
| Account | `tpid`、`tp-name` |
| 市场分层 | `segment`、`sub-segment` |
| 销售组织 | `sales-unit`、`territory`、`atu-group`、`atu-name` |
| 地理组织 | `field-area`、`area`、`region`、`sub-region`、`subsidiary`、`ww-region` |
| Accountability Unit | `accountability` |
| 映射状态 | `mapping-status` |

对应筛选参数为：

`topParentId`、`topParentName`、`tpid`、`segment`、`subSegment`、
`salesUnit`、`territory`、`atuGroup`、`fieldArea`、`area`、`region`、
`subRegion`、`subsidiary`、`wwRegion`、`accountabilityUnit`、
`mappingStatus`。

注意：当前查询 API 可按 `tp-name` 和 `atu-name` 分组，但不提供对应名称筛选参数。
需要定位名称时，先按名称分组发现结果，再使用返回的 TPID 或 ATU Group 做精确筛选。

## 4. 标准执行流程

### Step 1 — 解析业务问题

从用户请求中提取：

- 财政月；未提供时，不猜测，先从 catalog 的 partitions 选择最新可用月份，并在答案
  中明确写出采用的月份。
- 分析范围：区域产品事实、账户事实，或两者分别分析。
- 筛选条件：区域、服务层级、AI 层级、模型、销售组织、账户等。
- 分组维度：用户想“按什么看”。
- 排序与 Top N；未提供时，返回全部分组并按 ACR 降序展示前 10。
- 口径：默认 Finance-net；若用户明确要求 gross 或其他 adjustment，按其要求执行。

常见意图路由：

| 用户问题 | 工具与分组 |
|---|---|
| 六区域某产品/模型 ACR | regional，`groupBy=["area"]` |
| 某区域 Service L1–L5 构成 | regional，对应 service 层级 |
| AI/Foundry 模型组合 | regional，`groupBy=["model"]`，必要时加 `area` |
| Segment / Sales Unit / Territory 排名 | account，对应组织维度 |
| Top Parent / TPID 分布 | account，`top-parent-name` 或 `tp-name` |
| 某组织向下钻取 | account，保留父级筛选并切换到下一层 groupBy |
| 数据完整性或新鲜度 | release status，不返回业务行 |

### Step 2 — 校验发布

调用 `msxi_lake_get_release_status`：

- 目标财政月必须存在。
- manifest、文件 hash 和 reconciliation 必须有效。
- 如状态异常，停止业务分析，报告发布 ID、异常类别和建议重新发布；不得继续输出可能
  不完整的数字。
- 在最终答案注明 release ID 和 published time。

### Step 3 — 发现精确值

先调用一次不带 `scope`/`dimension` 的 `msxi_lake_get_catalog` 获取期间及维度。
然后对每个用户提供的文本筛选分别调用：

```json
{
  "dataset": "finhub-asia-acr",
  "fiscalMonth": "FY27-Jul",
  "scope": "regional",
  "dimension": "model"
}
```

`scope` 只能是 `regional` 或 `account`，并且必须与 `dimension` 同时提供。

解析规则：

- 精确命中：直接使用 catalog 返回值。
- 大小写或空格差异但唯一命中：使用 catalog 中的规范值，并在答案中展示规范值。
- 多个候选：先列出候选，请用户选择；不得自行挑选。
- 无候选：明确说明该发布中不存在此值，并列出最接近的少量可用值；不得改用更宽泛
  的父级值继续查询。

### Step 4 — 执行最窄查询

只发送解决问题所需的筛选和分组。示例：查询 FY27-Jul、AI Foundry Direct
Model 中某个精确模型的亚洲六区域 ACR：

```json
{
  "dataset": "finhub-asia-acr",
  "fiscalMonth": "FY27-Jul",
  "groupBy": ["area"],
  "aiHierarchyLevel1": "<catalog 精确值>",
  "aiHierarchyLevel2": "<catalog 精确值>",
  "foundryModel": "<catalog 精确值>",
  "foundryDeploymentType": "<catalog 精确值>",
  "adjustmentTypeGroup": "N/A + Other",
  "limit": 200,
  "offset": 0
}
```

不要把示例占位符当作真实值。每个值都必须来自当前 release 的 catalog。

### Step 5 — 分页、计算与核验

1. 收集全部分页结果。
2. 使用返回的 `acr` 原值进行计算，不从格式化字符串反解析。
3. 计算时允许：
   - 排名：按 ACR 降序。
   - 占比：`组 ACR / grandTotalAcr`。
   - 区域或组织集中度：Top N ACR / 总 ACR。
   - mapped 覆盖率：`mappedAcr / (mappedAcr + unmappedAcr)`。
   - 维度交叉表：使用多维 `groupBy` 返回的数据透视，不自行 join 两张事实表。
4. 核验：
   - 分页行之和应与同一筛选范围的 `grandTotalAcr` 一致，允许正常浮点舍入差。
   - 账户事实中 `mappedAcr + unmappedAcr` 应与总额一致。
   - 六区域问题应检查返回的 area 数量；少于六个时说明是零值/无匹配还是数据缺失，
     不补造零值。

### Step 6 — 形成业务答案

默认输出：

```markdown
# <主题> — <财政月>
> 数据集 <dataset> · release <releaseId> · 发布于 <publishedAt>
> 口径：<adjustment> · 筛选：<规范化后的精确筛选>

## Executive summary
- <总 ACR、覆盖范围、最重要的 2–3 个结构性事实>

## Breakdown
| Rank | <维度> | ACR | Share |
|---:|---|---:|---:|

## GTM observations
- <只描述有数字支撑的集中度、组合或覆盖信号>
- <需要业务验证的解释明确标为“待验证假设”>

## Data quality
- Rows: <totalCount>
- Account query only: mapped <金额/占比> · unmapped <金额/占比>
- Pagination: complete · Reconciliation: passed
```

格式要求：

- 金额默认使用 USD，千分位和两位小数；大额可同时给出 `$1.23M` 简写。
- 百分比保留一位小数。
- 排名必须建立在完整分页数据上。
- 用户只要求数字时，仍至少提供财政月、筛选口径和总计，避免脱离上下文。
- 账户级明细仅在用户明确要求且其授权范围允许时展示。

## 5. 专业分析模式

### 5.1 区域对比

使用 regional 工具按 `area` 分组，回答：

- 六区域 ACR、份额和排名。
- Top 1 / Top 3 区域集中度。
- 指定服务、AI 层级或 Foundry 模型在区域间的分布。

区域间差异只描述为“分布”或“集中度”，不得自动解释为市场潜力或执行优劣。

### 5.2 产品与 AI/Foundry 组合

使用 regional 工具按 service、AI hierarchy、model、deployment 或 offer 分组。
下钻必须逐层进行：

`service-l1 → ... → service-l5`，或 `ai-l1 → ... → ai-l5 → model`。

每层先用 catalog 获取精确值，再将已确认的父层值作为下一层筛选。不得跳过父层后把
同名模型误归到错误产品口径。

### 5.3 GTM 组织分析

使用 account 工具按以下典型路径下钻：

- `segment → sub-segment → sales-unit → territory`
- `field-area → area → region → sub-region → subsidiary`
- `top-parent-name → tp-name`
- `atu-group → atu-name`

保留上一级筛选，避免下钻后范围漂移。展示组织排名时同时报告 unmapped 占比；占比
较高时，明确说明组织归因可能不完整。

### 5.4 客户集中度

按 `top-parent-name` 或 `tp-name` 分组，计算 Top N 集中度。默认不在聊天中展示 TPID；
仅在用户明确要求识别或后续系统操作需要时展示。不得将 unmapped 金额分摊到客户。

### 5.5 交叉切片

多维 `groupBy` 用于回答类似问题：

- `["area", "model"]`：区域 × Foundry 模型。
- `["segment", "sales-unit"]`：Segment × Sales Unit。
- `["area", "service-l2"]`：区域 × Service L2。

为控制结果规模，最多优先使用 2–3 个业务必要维度。结果超过 200 组时必须分页，不得
截断后计算占比或排名。

## 6. 错误与边界处理

| 情况 | 处理 |
|---|---|
| `401` | 说明登录或 token 已失效，要求重新通过 OAuth 登录 |
| `403` | 说明缺少 `Lake.Read.All`，检查 `ifacr-agents` 或应用角色授权 |
| 首次调用超时 | 服务可能正在 scale from zero；等待冷启动后重试一次 |
| fiscal month 不存在 | 展示 catalog 中可用期间，不替换为其他月份 |
| 精确筛选无结果 | 报告“当前 release 无匹配”，不移除筛选扩大查询 |
| `hasMore=true` | 按 `nextOffset` 继续，完成分页后再分析 |
| reconciliation 失败 | 停止业务输出，报告数据发布异常 |
| unmapped 占比非零 | 单列展示并降低客户/组织归因结论的确定性 |
| 两张事实表总额看似不同 | 检查粒度、筛选和 adjustment 口径，不相加、不强行对齐 |

## 7. Guardrails

- 只调用本文件列出的四个 `msxi_lake_*` 工具。
- 不使用任意 SQL，不访问底层 Blob，不尝试写入或修改湖仓。
- 不记录或复述 bearer token、tenant ID、subscription ID 或其他认证信息。
- 不把真实客户名称、TPID 或 ACR 数字写入代码、模板、日志、GitHub artifact 或示例。
- 不跨授权边界披露客户数据；业务汇总优先使用区域或组织聚合。
- 不伪造缺失值、零值、客户映射、期间、币种或业务解释。
- 不把单月快照描述为趋势。跨月趋势需要多个已发布财政月分别查询，并保持完全相同的
  筛选、维度和 adjustment 口径。
- 所有结论需附财政月、release 和筛选口径，使结果可复核。

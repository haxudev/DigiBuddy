# HaeronClaw

[English](README.md) | [简体中文](README.zh-CN.md)

> 在 Microsoft Foundry Hosted Agent 中运行的 Codex Coding Agent。

HaeronClaw 将 Codex app-server 作为 Microsoft Foundry Hosted Agent 内部的 Coding Agent Runtime / Execution Engine，对外提供 Foundry Responses `2.0.0` 协议，并提供独立的 Next.js + React + AG-UI Web UI 容器项目。

原 Azure Functions on Azure Container Apps 运行时继续保留在 `infra/`，作为 Teams、MCP、定时任务和企业交付集成的迁移兼容路径。

**核心能力**

- 通过 Microsoft Foundry 部署 Responses `2.0.0` Hosted Agent
- 通过 Codex app-server 执行 coding agent loop、shell、Git 和文件操作
- 使用持久化 response/session 映射恢复 Codex thread
- 运行时配置模型 endpoint、key 和 model name
- 通过独立的 Next.js + React + AG-UI Web 应用连接 Agent
- 将 Web UI 部署到 Web App for Containers 或任意 OCI 容器平台

## 本项目新增的高级能力

- **Azure Blob 制品分发**：生成的文件会上传到 Azure Blob Storage，并通过应用自有下载链接对外提供，无需手动处理 SAS token。
- **Microsoft 365 邮件工作流**：`m365_cli` 工具可在 agent 运行时发送邮件、读取邮件、查看日历、浏览 OneDrive、查询 SharePoint。
- **基于 Blob 的邮件附件处理**：二进制邮件附件在不适合直接投递时，会自动暂存到 Blob Storage，并重写为整洁的下载链接。
- **Teams 异步执行**：长耗时任务可在后台处理，并通过主动回复、typing indicator 和心跳式进度反馈告知用户。
- **语音消息转录**：Teams 音频附件可通过 Azure Speech 转录，使用户能用语音与 HaeronClaw 交互。
- **SharePoint 与 OneDrive 内容接入**：可通过 Microsoft Graph 的 OBO 流程解析共享文档链接，生成基于文档内容的回答。
- **文档与制品生成**：agent 可生成 PPTX、DOCX、XLSX、PDF 等交付物，并通过 Teams、HTTP 或邮件友好的链接进行交付。
- **知识增强回答**：可组合存储侧的 `work_memory/`、`index_memory/` 与 Microsoft Learn 文档，输出带来源依据的回答。

**将你的 agent 托管在 Azure Functions 上**

Azure Functions 是一个已经支持 JavaScript、Python、.NET 等运行时的无服务器计算平台。包含 `AGENTS.md`、skills 和 MCP servers 的 agent 项目，本质上也是一种工作负载。本仓库将这些能力封装为一个可在云端运行的 Azure 托管 agent runtime。

开发流程如下：

1. 在 VS Code 中以标准 Copilot 项目方式定义并测试 agent
2. 将同一份项目部署到 Azure Container Apps 上的 Azure Functions
3. 你的 agent 即成为一个云托管 HTTP API，无需重写业务逻辑

本仓库打包的是 **HaeronClaw**：一个帮助开发者、架构师和业务用户处理 Azure 定价、官方文档、内部知识、邮件流程、SharePoint 内容和文档制品生成的 Microsoft 专家 agent。

## 项目结构

```text
azure.yaml                    # Microsoft Foundry Hosted Agent 清单
hosted-agent/                 # Responses 适配器和 Codex 执行运行时
webui/                        # 独立 Next.js + React + AG-UI 应用

src/                          # Agent 定义、skills、tools 和 work memory
├── AGENTS.md                 # HaeronClaw 指令、行为定义，以及可选的 function frontmatter
├── .github/skills/           # 运行时加载的 Markdown skills
├── .vscode/mcp.json          # 本地创作与运行时一致性的 MCP server 配置
├── tools/
│   ├── cost_estimator.py     # 定价计算工具
│   ├── create_eml.py         # EML 生成工具
│   ├── fetch_url.py          # URL 抓取工具
│   └── m365_cli.py           # 邮件、日历、OneDrive、SharePoint 操作
├── work_memory/              # 领域知识和内部 FAQ 内容
└── index_memory/             # 检索工作流使用的索引内容

infra/assets/                 # 旧版 Azure Functions + Teams 运行时
├── function_app.py           # HTTP / function 入口
├── teams_bot.py              # Teams bot 编排与主动回复
├── file_upload.py            # Azure Blob 上传与下载链接生成
├── sharepoint_graph.py       # 基于 Graph 的 SharePoint / OneDrive 访问
├── speech_service.py         # Azure Speech 音频转录集成
├── scripts/                  # 打包运行时依赖时使用的安装辅助脚本
└── vendor/m365-cli/          # npm install 后再应用的仓库内覆盖文件

teams-app/                    # Teams app manifest 与 sideload 包
```

主部署由 `azure.yaml` 定义，并从 `hosted-agent/Dockerfile` 构建。`webui/` 镜像独立部署并连接 Foundry Responses endpoint。`infra/` 下的 Azure Functions 实现不属于主 Hosted Agent 部署。

仓库不会跟踪完整的 `node_modules/` 目录树。对第三方依赖的必要定制统一存放在 `infra/assets/vendor/` 中，并通过 `infra/assets/scripts/apply-m365-cli-patches.mjs` 在 `npm install` 后自动应用。

`AGENTS.md` 支持可选的 YAML frontmatter。通过 frontmatter，你可以把 agent 从单纯的聊天接口扩展到 Azure Functions 的事件驱动模型，例如定义按 [计划](#agentsmd-frontmatter-中的定时触发) 运行的 timer trigger，而无需手写 Azure Functions 代码。

## 在 VS Code 中本地运行

1. 在 VS Code 中打开 `src` 目录
2. 启用实验性设置：`chat.useAgentSkills`
3. 在 Copilot Chat 中启用内置工具
4. 在 Copilot Chat 中直接与 agent 对话

`AGENTS.md` 中的指令、`.github/skills/` 中的 skills，以及 `.vscode/mcp.json` 中的 MCP server 都会自动加载。

## 部署 Foundry Hosted Agent

### 部署方式

配置模型并通过 Azure Developer CLI 部署：

统一入口命令如下：

```bash
azd auth login
azd env set CODEX_MODEL_ENDPOINT "https://your-resource.openai.azure.com/openai/v1"
azd env set CODEX_MODEL_API_KEY "<model-key>"
azd env set CODEX_MODEL_NAME "gpt-5.2-codex"
azd up
```

随后把 `webui/Dockerfile` 部署到 Web App for Containers 或其他 OCI 平台，并设置 `FOUNDRY_AGENT_ENDPOINT`。详见 [快速开始](docs/quickstart.md) 和 [架构](docs/architecture.md)。

## 旧版 Azure Functions 部署

以下章节记录保留的 Azure Functions/ACA 运行时，不会配置 Foundry Hosted Agent。

### GitHub Models 的鉴权方式

当使用 `github:` 模型时，本项目支持两种认证模式：

- **推荐方案（Scheme B）**：在每个请求中传入用户级 GitHub OAuth token（`gho_` / `ghu_`），避免在 Function App 设置中保存长期 token。
- **兼容方案**：部署时提供 `GITHUB_TOKEN`，使用共享服务 token。

在安全要求较高的环境中，应优先选择用户级 OAuth token，以降低密钥泄露风险。

### 模型配置约定

本项目在运行时完全由环境变量驱动。

- 使用 `COPILOT_MODEL` 作为唯一的运行时模型配置项。
- 对 GitHub Copilot 模型，始终使用完整模型 ID，例如 `github:gpt-5.4`。
- 对 Microsoft Foundry 模型，始终使用完整模型 ID，例如 `foundry:gpt-5.2-codex`。
- 不要再引入 `GHCP_MODEL_NAME` 之类的别名变量。保持单一运行时变量能让部署和排障更可预测。

部署输入会在运行时被归一化为 `COPILOT_MODEL`：

- ACA 路径：部署脚本直接把 `COPILOT_MODEL` 注入到 Container App 中。

### 部署到 ACA

在终端中运行部署入口：

```powershell
./scripts/deploy.ps1 -Mode aca -ResourceGroup <rg-name> -Location eastus2 -Prefix fmaaca -Model github:gpt-5.4 -ImageTag v3
```

几分钟后，你会得到一个通过 HTTP API 暴露、并附带内置聊天 UI 的已部署 agent。也就是说，在本地 Copilot Chat 中运行的同一份源码，会直接运行在 Azure Functions on ACA 上。

主要输入参数如下：

| 输入项 | 说明 |
|--------|------|
| **Resource Group** | 目标 Azure 资源组 |
| **Azure Location** | 部署区域 |
| **GitHub Token** | 可选的共享服务 token。留空则要求每次请求携带用户 OAuth token（`x-github-token` header） |
| **Model** | 运行时模型 |
| **Image Tag** | ACA 部署使用的容器镜像 tag |

#### 模型选择

你可以从两类模型中选择：

- **GitHub models**（`github:` 前缀）: 使用 GitHub Copilot model API，不额外部署 Azure 模型基础设施。示例：`github:claude-sonnet-4.6`、`github:gpt-5.4`、`github:gpt-5.2`
- **Microsoft Foundry models**（`foundry:` 前缀）: 在你的订阅中部署 Microsoft Foundry 账户与模型。示例：`foundry:gpt-4.1-mini`、`foundry:claude-opus-4-6`、`foundry:o4-mini`

如果需要在首次部署后切换模型：

```powershell
./scripts/deploy.ps1 -Mode aca -ResourceGroup <rg-name> -Location eastus2 -Prefix fmaaca -Model github:gpt-5.4 -ImageTag <new-tag>
```

使用 `-Model github:gpt-5.4` 重新部署时，脚本会自动更新 `COPILOT_MODEL`。

### 会话持久化

在 Azure 中运行时，agent session 会自动持久化到挂载到容器运行时中的 Azure Files 共享。这意味着会话状态可以跨重启保留，也可在多实例间共享，从而支持多轮会话和会话恢复。

本地运行时，会话保存在 `~/.copilot/session-state/`。

## `AGENTS.md` Frontmatter 中的定时触发

你可以直接在 `src/AGENTS.md` 的 frontmatter 中，通过 `functions` 数组定义定时运行的 agent。

```yaml
---
functions:
  - name: timerAgent
    trigger: timer
    schedule: "0 */2 * * * *"
    prompt: "What's the price of a Standard_D4s_v5 VM in East US?"
    logger: true
---
```

当前行为：

- 目前只支持 `trigger: timer`。其他触发器类型会在启动时被显式拒绝。
- `functions` 区块是可选的。
- `schedule` 和 `prompt` 是 timer 项必填。
- `name` 可选；如果省略，会自动生成安全且唯一的名称。
- `logger` 可选，默认值为 `true`。

当 `logger: true` 时，定时任务会通过 `logging.info` 输出完整 agent 结果，包括：

- `session_id`
- 最终 `response`
- `response_intermediate`
- `tool_calls`

定时函数会在启动时从 frontmatter 动态注册，并与 `/agent/chat` 运行在同一运行时中。

## 使用 Python 构建自定义工具

你可以通过把普通 Python 文件放到 `src/tools/` 中来扩展工具能力。

示例：

```python
from pydantic import BaseModel, Field


class CostEstimatorParams(BaseModel):
    unit_price: float = Field(description="Retail price per unit")
    unit_of_measure: str = Field(description="Unit of measure, e.g. '1 Hour'")
    quantity: float = Field(description="Monthly quantity")


async def cost_estimator(params: CostEstimatorParams) -> str:
    """Estimate monthly and annual costs from unit price and usage."""
    monthly_cost = params.unit_price * params.quantity
    annual_cost = monthly_cost * 12
    return f"Monthly: ${monthly_cost:.4f} | Annual: ${annual_cost:.4f}"
```

工具发现机制：

- 运行时会扫描 `tools/*.py` 以发现工具定义。
- 它会加载模块级函数，并过滤掉以 `_` 开头的名称。
- 函数 docstring 会作为工具描述；如果没有 docstring，则回退为 `Tool: <function_name>`。
- 每个文件只注册一个函数（按名称排序后选择第一个）。
- 如果工具模块导入或加载失败，运行时会记录错误并继续启动。

建议：

- 保持工具函数聚焦且可预测。
- 优先使用类型化参数模型（例如 Pydantic `BaseModel`）作为函数参数。
- 写清晰的类型标注和 docstring。
- 若工具需要新的 Python 依赖，请添加到 `src/requirements.txt`。

重要说明：自定义 Python 工具只会在云端运行时（Azure Functions）执行，不会在本地 Copilot Chat 中执行。

## 打包依赖补丁

本仓库会对 Azure 运行时使用的部分 `m365-cli` 文件做定制，但这些补丁不再直接存放在 `node_modules` 下。

- 版本控制中的覆盖文件位于 `infra/assets/vendor/m365-cli/`
- `infra/assets/scripts/apply-m365-cli-patches.mjs` 会在安装后把这些文件复制到 `node_modules/m365-cli/`
- `infra/assets/package.json` 通过 `postinstall` 自动执行补丁应用步骤

这种做法能在保持运行时行为不变的同时，避免把 `node_modules` 作为仓库的一部分公开出来，更适合开源协作。

## 使用聊天 UI（根路由）

部署完成后，打开根 URL：

```text
https://<your-app>.<environment>.<region>.azurecontainerapps.io/
```

根路由会提供一个内置单页聊天界面。

首次访问时，需要输入：

- Base URL（通常就是你的 ACA 应用 URL）
- GitHub OAuth 用户 token（`gho_` / `ghu_`）

Base URL 会保存在浏览器 local storage 中；GitHub token 只保存在 session storage 中，浏览器会话结束后即清除。

你也可以通过 URL hash 预填这两个值：

```text
https://<your-app>.<environment>.<region>.azurecontainerapps.io/#baseUrl=https%3A%2F%2F<your-app>.<environment>.<region>.azurecontainerapps.io&token=<url-encoded-gho-token>
```

页面加载后，会读取这些值，分别写入 local storage 和 session storage，并从地址栏中移除 hash。

## 使用 MCP Server

已部署应用还会暴露一个 MCP server 端点：

```text
https://<your-app>.<environment>.<region>.azurecontainerapps.io/runtime/webhooks/mcp
```

如果你的环境为 MCP extension 端点启用了 function key，需要通过 `x-functions-key` header 传入。

### MCP Host 示例

```bash
# Get the ACA host name
APP_NAME=<container-app-name>
RG=<resource-group>
HOST=$(az containerapp show --name "$APP_NAME" --resource-group "$RG" --query properties.configuration.ingress.fqdn -o tsv)
echo "https://$HOST/runtime/webhooks/mcp"
```

### VS Code `mcp.json` 示例（安全密钥输入）

使用 `inputs` 并设置 `password: true`，避免把 MCP key 硬编码进文件。

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "functions-mcp-extension-system-key",
      "description": "Azure Functions MCP Extension System Key",
      "password": true
    },
    {
      "type": "promptString",
      "id": "functionapp-host",
      "description": "Container app host, e.g. fmaaca-xxxx.<env>.<region>.azurecontainerapps.io"
    }
  ],
  "servers": {
    "remote-mcp-function": {
      "type": "http",
      "url": "https://${input:functionapp-host}/runtime/webhooks/mcp",
      "headers": {
        "x-functions-key": "${input:functions-mcp-extension-system-key}"
      }
    }
  }
}
```

## 使用 API

部署后，agent 会以 HTTP API 形式提供两个聊天端点：

- `POST /agent/chat`：返回标准 JSON
- `POST /agent/chatstream`：返回流式 SSE

### 基础请求

```bash
curl -X POST "https://<your-app>.<environment>.<region>.azurecontainerapps.io/agent/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <gho_or_ghu_token>" \
  -H "x-github-token: <gho_or_ghu_token>" \
  -d '{"prompt": "What is the price of a Standard_D4s_v5 VM in East US?"}'
```

### 响应

```json
{
  "session_id": "abc123-def456-...",
  "response": "The agent's final response text",
  "response_intermediate": "Any intermediate responses",
  "tool_calls": ["list of tools invoked during the response"]
}
```

响应中始终会包含 `session_id`，并且也会通过 `x-ms-session-id` 响应头返回。你可以使用它继续会话。

### 多轮会话

要恢复已有会话，请在请求头中传入 `x-ms-session-id`：

```bash
# Follow-up — resumes the same session with full conversation history
curl -X POST "https://<your-app>.<environment>.<region>.azurecontainerapps.io/agent/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <gho_or_ghu_token>" \
  -H "x-github-token: <gho_or_ghu_token>" \
  -H "x-ms-session-id: abc123-def456-..." \
  -d '{"prompt": "If I run that VM 24/7 for a month, what would it cost?"}'
```

如果省略 `x-ms-session-id`，系统会自动创建一个新会话，并在响应中返回该会话 ID。更多示例见 `test/test.cloud.http`。

### 流式端点（SSE）

使用 `POST /agent/chatstream` 可以通过 SSE 增量接收响应。

```bash
curl -N -X POST "https://<your-app>.<environment>.<region>.azurecontainerapps.io/agent/chatstream" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "Authorization: Bearer <gho_or_ghu_token>" \
  -H "x-github-token: <gho_or_ghu_token>" \
  -d '{"prompt": "Give me a quick summary of Azure Functions pricing in 3 bullets."}'
```

如果要恢复已有会话，可以像 `/agent/chat` 一样传入 `x-ms-session-id`。

典型的流式事件类型包括：

- `session`：包含 `session_id`
- `delta`：增量文本块
- `intermediate`：中间响应片段
- `tool_start` / `tool_end`：工具执行生命周期信息
- `message`：最终完整响应
- `done`：流结束

示例 SSE 序列：

```text
data: {"type":"session","session_id":"..."}

data: {"type":"delta","content":"Hello"}

data: {"type":"tool_start","tool_name":"bash","tool_call_id":"..."}

data: {"type":"message","content":"Hello...final"}

data: {"type":"done"}
```

### 获取 URL

部署后，可以用 Azure CLI 获取 Container App 的 hostname：

```bash
# Get the base URL
APP_NAME=<container-app-name>
RG=<resource-group>
HOST=$(az containerapp show --name "$APP_NAME" --resource-group "$RG" --query properties.configuration.ingress.fqdn -o tsv)
echo "https://$HOST"
```

你可以把这个值填入 `test/test.cloud.http` 的 `@baseUrl`，并在 `Authorization: Bearer ...` 中传入 GitHub OAuth token。

## 已知限制

- **`src/tools/` 下的 Python 工具在本地不可用**，因为 Copilot 本地环境并不原生支持它们；部署到 ACA 后可正常工作。
- **Windows 不受支持。** 打包 hook 主要依赖 shell 脚本（`.sh`），需要 macOS、Linux 或 WSL。

## 快速体验

1. 克隆本仓库
2. 在 VS Code 中打开 `src`，本地先与 agent 对话（MCP 和 skills 可用；Python tools 需要云端部署）
3. 浏览 `src` 目录，理解 agent 定义方式
4. 运行 `./scripts/deploy.ps1 -Mode aca ...` 部署到 Azure Functions on ACA
5. 打开云端聊天 UI 根路由 `/`
6. 如有需要，直接调用 `/agent/chat`（JSON）或 `/agent/chatstream`（SSE），示例见 `test/test.cloud.http`

# DigiBuddy

[English](README.md) | [简体中文](README.zh-CN.md)

> 在 Microsoft Foundry Hosted Agent 中运行的 Codex Coding Agent。

DigiBuddy 将 Codex app-server 封装为 Microsoft Foundry Hosted Agent 内部的 Coding Agent Runtime / 执行引擎。它对外提供 Foundry Responses 协议 `2.0.0`，并附带一个独立的、可容器化部署的 Next.js + React + AG-UI Web UI。

在该运行时之上，本仓库还提供了一份 agent payload，将 Codex 变成 **DigiBuddy** —— 一位 Microsoft 领域专家 agent，帮助开发者、架构师与业务用户处理 Azure 定价、文档、内部知识、邮件流程、SharePoint 内容以及各类交付物的生成。

**核心特性**

- 通过 Microsoft Foundry 部署协议 `2.0.0` 的 agent
- 使用 Codex app-server 完成 coding-agent 循环、shell、Git 与文件操作
- 通过持久化的 response/session 映射恢复 Codex thread
- 在运行时配置模型 endpoint、密钥与模型名称
- 通过独立的 Next.js + React + AG-UI 应用连接
- 将 Web UI 部署到 Web App for Containers 或任意兼容 OCI 的宿主

## Agent 能力

- **Azure Blob 交付物分发**：生成的文件会上传到 Azure Blob Storage，并通过使用 agent 的 Entra ID 身份签名的 user-delegation SAS 链接对外暴露，全程不使用账户密钥。
- **Microsoft 365 工作流**：`m365_cli` 工具可在 agent 运行时中发送邮件、读取邮件、查看日历、浏览 OneDrive 并查询 SharePoint。
- **基于 Blob 的邮件附件**：二进制附件会自动暂存到 Blob Storage 并改写为简洁的下载链接；纯文本文件仍作为直接附件发送。
- **SharePoint 与 OneDrive 接入**：共享文档链接通过 Microsoft Graph 解析，默认使用 app-only 凭据，在提供用户断言时使用 on-behalf-of。
- **文档与交付物生成**：agent 在 `/workspace` 下生成 PPTX、DOCX、XLSX、PDF 交付物，并通过下载链接分发。
- **知识驱动的回答**：skills 提供内部知识库，优先于 Microsoft Learn MCP 工具进行查询，并附带来源引用。
- **云定价与成本估算**：实时查询 Azure 零售价，并给出月度与年度预测。

## 项目结构

```
azure.yaml                    # Microsoft Foundry Hosted Agent 清单
hosted-agent/                 # Responses 适配器与 Codex 执行运行时
├── Dockerfile                # 协议 2.0.0 运行时镜像
├── main.py                   # Responses 处理器与流式适配器
├── AGENTS.md                 # 运行时护栏
└── codex_adapter/            # Codex stdio JSON-RPC 客户端、配置、session 映射

webui/                        # 独立的 Next.js + React + AG-UI 应用

src/                          # Agent payload，构建时打入镜像 /opt/digibuddy
├── AGENTS.md                 # DigiBuddy 人设与能力目录
├── mcp.json                  # 远程与本地 MCP server 目录
├── skills/                   # <name>/SKILL.md 定义，按需加载
├── tools/                    # Python 工具，每个都有 CLI 入口
│   ├── azure_blob.py         # Blob 上传与 user-delegation SAS 链接
│   ├── cost_estimator.py     # 定价计算辅助
│   ├── create_eml.py         # EML 生成辅助
│   ├── fetch_url.py          # URL 抓取辅助
│   ├── m365_cli.py           # 邮件、日历、OneDrive、SharePoint 操作
│   └── sharepoint.py         # 基于 Graph 的 SharePoint/OneDrive 访问
├── scripts/                  # 内置依赖的安装期辅助脚本
├── vendor/m365-cli/          # npm install 之后应用的仓库自有覆盖文件
└── work_memory/              # 内部 FAQ 知识库（已 gitignore，构建时提供）
```

主部署由 `azure.yaml` 定义，并基于 `hosted-agent/Dockerfile` 构建。`webui/` 镜像单独部署，并连接到部署产生的 Foundry Responses endpoint。

## Agent Payload

Codex 沙箱只暴露一个 shell —— 没有工具注册表。因此能力以文件形式复制进镜像，并通过环境变量暴露：

| 路径 | 环境变量 | 内容 |
| --- | --- | --- |
| `/opt/digibuddy` | `DIGIBUDDY_PAYLOAD_ROOT` | 人设、`mcp.json`、`node_modules/` |
| `/opt/digibuddy/tools` | `DIGIBUDDY_TOOLS_ROOT` | Python 工具，已加入 `PYTHONPATH` |
| `/opt/digibuddy/skills` | `DIGIBUDDY_SKILLS_ROOT` | Skill 定义 |
| `/workspace` | `CODEX_WORKSPACE` | 可写工作目录 |

启动时，适配器会将 `hosted-agent/AGENTS.md` 与 `src/AGENTS.md` 拼接为 Codex 的 base instructions，并把 `src/mcp.json` 渲染为生成的 Codex `config.toml` 中的 `[mcp_servers.*]` 配置块。

### 工具

每个 payload 工具都是一个可从 shell 调用的 Python 模块：

```bash
python -m cost_estimator --unit-price 0.192 --unit-of-measure "1 Hour" --quantity 730
python -m fetch_url https://example.com/article
python -m m365_cli 'mail list --top 5 --json'
python -m sharepoint download <share-url> --out /workspace
python -m azure_blob upload /workspace/report.pdf
python -m create_eml --out /workspace/message.eml --from a@b.com --to c@d.com \
  --subject "Hi" --body "Hello"
```

新增工具时，把带有基于 `argparse` 的 `main()` 以及 `if __name__ == "__main__"` 守卫的模块放入 `src/tools/`，然后在 `src/AGENTS.md` 中记录它。Python 依赖请加入 `src/requirements.txt`。

## 部署 Foundry Hosted Agent

```bash
azd auth login
azd env set CODEX_MODEL_ENDPOINT "https://your-resource.openai.azure.com/openai/v1"
azd env set CODEX_MODEL_API_KEY "<model-key>"
azd env set CODEX_MODEL_NAME "gpt-5.2-codex"
azd up
```

随后将 `webui/Dockerfile` 部署到 Web App for Containers 或其他 OCI 宿主，并设置 `FOUNDRY_AGENT_ENDPOINT`。参见 [快速开始](docs/quickstart.md) 与 [架构](docs/architecture.md)。

## 使用 API

Hosted Agent 使用 Foundry Responses 协议 `2.0.0`：

```bash
curl -N -X POST "https://<foundry-endpoint>/responses" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "api-key: <key>" \
  -d '{
    "model": "gpt-5.2-codex",
    "input": "What is the price of a Standard_D4s_v5 VM in East US?",
    "stream": true,
    "store": true,
    "agent": { "name": "digibuddy-codex", "version": "1" }
  }'
```

将上一次响应的 `id` 作为 `previous_response_id` 传入即可恢复同一个 Codex thread。完整事件列表以及 Web UI 的 AG-UI endpoint 参见 [API 参考](docs/api.md)。

## 打包依赖补丁

本仓库对部分 `m365-cli` 文件打了补丁，这些补丁在 `node_modules` 之外管理：

- 纳入源码管理的覆盖文件位于 `src/vendor/m365-cli/`。
- `src/scripts/apply-m365-cli-patches.mjs` 在安装后把这些文件复制到 `node_modules/m365-cli/`。
- `src/package.json` 通过 `postinstall` 脚本自动执行该补丁步骤。

## 本地校验

```bash
cd hosted-agent && python -m unittest discover -s tests -t . -v
cd ../webui
npm test
npm run lint
npm run build
```

## 已知限制

- **不支持视频生成。** agent 镜像中未安装任何渲染工具链。
- **不支持 Windows** 运行打包钩子；请使用 macOS、Linux 或 WSL。

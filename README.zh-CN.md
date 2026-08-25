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
- 通过 Web UI 管理控制台统一管理模型接入、远程 MCP 工具与 agent profile
- 用 profile 装配面向不同业务的 agent，无需重新构建镜像
- 通过独立的 Next.js + React + AG-UI 应用连接
- 将 Web UI 部署到 Web App for Containers 或任意兼容 OCI 的宿主

## Agent 能力

- **平台托管交付物**：生成文件保存到私有共享存储，通过同源交付卡片安全预览和下载；仅在明确要求外部分享时使用临时 SAS 链接。若重试后仍写入失败，答案照常交付，控制台在回答下方显示可关闭的交付提醒，而不是把失败句子写进会话记录。
- **实时运行轨迹**：消息一发出，控制台就显示脉动占位和耗时计时；reasoning 开始流式返回后，轨迹跟随最新一行更新，行默认折叠，并在 `prefers-reduced-motion` 下关闭动画。
- **Microsoft 365 工作流**：`m365_cli` 工具可在 agent 运行时中发送邮件、读取邮件、查看日历、浏览 OneDrive 并查询 SharePoint。
- **基于 Blob 的邮件附件**：二进制附件会自动暂存到 Blob Storage 并改写为简洁的下载链接；纯文本文件仍作为直接附件发送。
- **SharePoint 与 OneDrive 接入**：共享文档链接通过 Microsoft Graph 解析，默认使用 app-only 凭据，在提供用户断言时使用 on-behalf-of。
- **文档与交付物生成**：agent 在 `/workspace` 下生成 PPTX、DOCX、XLSX、PDF、HTML、Markdown、图片和数据文件；本轮新增或更新的交付物会自动附加到回复。
- **知识驱动的回答**：skills 提供内部知识库，优先于 Microsoft Learn MCP 工具进行查询，并附带来源引用。
- **云定价与成本估算**：实时查询 Azure 零售价，并给出月度与年度预测。

## 项目结构

```
azure.yaml                    # Microsoft Foundry Hosted Agent 清单
hosted-agent/                 # Responses 适配器与 Codex 执行运行时
├── Dockerfile                # 协议 2.0.0 运行时镜像
├── main.py                   # Responses 处理器与流式适配器
├── AGENTS.md                 # 运行时护栏
└── codex_adapter/            # Codex stdio JSON-RPC 客户端、配置、profile、session 映射

webui/                        # 独立的 Next.js + React + AG-UI 应用，含 /admin 管理控制台

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

### Skills

一个 skill 是一个目录，包含 `SKILL.md` 以及它工作所需的一切 —— 参考资料、脚本、随包携带的库、CLI。skills 通过三个平面到达 agent。

**用户**用斜杠命令加载。在输入框中键入 `/` 会打开一个菜单，列出当前 agent profile 可触达的 skills：方向键移动选中项，Enter 确认，Esc 关闭菜单且不会动到已经输入的文字。选中后即附加到下一条消息。选择是按消息生效，而非按会话：skill 是模型按需读取的 markdown，因此不同于 `@agent` 提及（Codex 在线程启动时就已固定），它可以在会话的任意时刻选择。运行时会依据已绑定的 profile 校验该请求，并在这一轮的提示词前加上指向该 skill `SKILL.md` 的指令。当目录读不到时，菜单会直接说明原因，而不是显示为空——"这个部署没有装 skill"和"配置存储不可达"是两个不同的问题，修法也不同。

profile 可触达的每个 skill 都会自动出现在菜单中。`commands.json` 文档在其上叠加一层策展能力，管理员可以重命名命令、撰写更好的描述、隐藏不适合出现在聊天菜单中的条目，或将多个 skills 归并到一个命令下。`/agent-adoption-assessment` 作为内置示例随附：它会加载 `agent-maturity-assess` 与 `agent-maturity-report`。

**管理员**从控制台上传 skills，可以是 zip 或 HTTPS URL。bundle 以内容寻址方式存储在 `bundles/<name>/<sha256>.zip`；运行时先校验摘要再解包，并拒绝符号链接、路径穿越和超限压缩包。上传的**代码**（tools 与 MCP server）在管理员批准那一份确切字节之前保持惰性，因此替换一个已批准的产物会撤销授权，而不是继承它。

控制台的 Skills 标签页会列出**全部**清单，把镜像默认加载的 skills 与自定义上传区分开，每一项都带一个开关。关掉一个 skill 意味着运行时不再安装它：任何 agent profile 都触达不到，它也会从 `/` 菜单中消失。两者的开关分开存放 —— 上传件的开关在其注册表条目里，默认加载 skill 的开关在 `skill-policy.json` —— 因为它们是两类不同的声明；而运行时会拒绝与默认 skill 同名的上传，所以两个集合永不重叠。无论哪一种，改动都在下一轮运行时重新读取配置时生效。

**是软件包，而不只是文档。**一个包含多个 skills、共享 Python 包与脚手架的仓库，会被**炸开**为每个 skill 一个自包含 bundle：共享库被复制进各个 skill，入口 shim 自动生成，因此 skill 在 `PYTHONPATH` 为空时也能工作。请在压缩包根部用 `digibuddy-skills.json` 声明布局：

```json
{
  "schema_version": 1,
  "skills": [{ "name": "my-skill", "path": "skills/my-skill" }],
  "shared": [{ "path": "src/my_package", "as": "_lib/my_package" }],
  "entrypoints": [{ "path": "scripts/run.py", "module": "my_package.cli", "call": "main" }]
}
```

没有 manifest 时，导入器仍会发现任何包含 `SKILL.md` 的目录，但它无从得知 `src/my_package/` 正是这些 skills 所导入的代码 —— 每个 bundle 都是被单独解包的，因此其目录之外的内容根本不存在。上传预览会在有软件包将被遗落时发出警告。

### Skills 与 MCP server

一个 skill 可以被 MCP server **加速**，但绝不能**依赖**它。

MCP server 是进程级的。它们被写入生成的 Codex `config.toml` 并随引擎一同启动，而渲染后的配置属于运行时指纹的一部分 —— 因此改动这一集合会重启整个容器的 Codex，而该容器是用同一个进程服务所有会话的。这在部署或管理时刻可以接受，按轮切换则不可接受，这正是斜杠命令绝不触碰它的原因。

所以 skill 自带运行时：随包携带的 `_lib/` 以及可从 shell 调用的 `scripts/` shim。这条路径零成本、在任何 profile 下都可用，对上传的 skill 也无需任何 MCP 接线。确实注册了 server 的场景，会按需要限定到相应 profile —— `agent-adoption` profile 携带 `agent-maturity`，而在其他任何地方，评估依然通过该 skill 自己的 CLI 运行。

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

## 管理控制台与 Agent Profile

模型接入、远程 MCP 目录、agent profile 与私有回复交付物都存放在共享存储中 —— Azure Blob 容器（`DIGIBUDDY_CONFIG_URI`）或本地目录（`DIGIBUDDY_CONFIG_DIR`）—— Web UI 与 hosted agent 均可访问。交付物位于保留的 `artifacts/` 前缀下，浏览器只接收同源的 `/api/artifacts/...` 引用。

Web UI 提供 `/admin`，一个面向该存储的三页签控制台：

| 页签 | 管理内容 |
| --- | --- |
| 模型接入 | 模型名称、endpoint、provider 与 API key |
| 远程 MCP | HTTPS MCP server 目录 |
| Agent profile | 人设，以及每个 profile 装配的 skills、tools、MCP server 与模型 |

运行时在每个 turn 边界重新读取该存储，当生效配置发生变化时重启 Codex 引擎，因此管理端的修改无需重新部署即可生效。启动时运行时还会发布 `catalogue.json`，描述镜像实际包含的 skills 与 tools，从而保证控制台不会提供未部署的能力。

聊天用户在对话顶部的控件中选择 agent，该选择以 `metadata.profile` 传给运行时，运行时会回传它实际解析出的 profile。由于 Codex 在 thread 启动时就固定了基础指令，一次对话会一直使用它开始时的 agent：首轮之后该控件转为陈述当前 agent，选择其他 agent 会新建一次对话。不选则使用运行时默认值；指名一个已不存在的 agent 会报错，而不是静默回退。

聊天登录可通过 `AUTH_REQUIRE_CORPORATE_ACCOUNT`、`AUTH_TENANT_ID` 与 `AUTH_ALLOWED_UPN_DOMAINS` 限制为 Microsoft Entra 公司账户。通过 `AUTH_ALLOWED_HOME_TENANT_IDS` 与 `AUTH_ALLOWED_EMAIL_DOMAINS` 可允许受信任的企业 B2B 账户，同时继续拒绝 Hotmail 与未受信任 Guest。校验依据是签发租户、`idp` claim 与已验证的登录地址，而不是随宿主变化的 Easy Auth provider 标签。

`/admin` 可通过 `ADMIN_USERNAME`、scrypt 格式的 `ADMIN_PASSWORD_HASH` 与 `ADMIN_SESSION_SECRET` 启用独立的管理员用户名密码登录；该模式优先于 Easy Auth 白名单。未配置这些值时，访问权限回退到 `ADMIN_PRINCIPAL_IDS` Entra 白名单，空白名单拒绝所有人。模型 API key 只写不读 —— 永远不会返回给浏览器，留空保存则保留已存的值。详见 [功能](docs/features.md) 与 [API 参考](docs/api.md)。

## 部署 Foundry Hosted Agent

```bash
azd auth login
azd env set CODEX_MODEL_ENDPOINT "https://your-resource.openai.azure.com/openai/v1"
azd env set CODEX_MODEL_API_KEY "<model-key>"
azd env set CODEX_MODEL_NAME "gpt-5.2-codex"
azd up
```

随后将 `webui/Dockerfile` 部署到 Web App for Containers 或其他 OCI 宿主，并设置 `FOUNDRY_AGENT_ENDPOINT`。参见 [快速开始](docs/quickstart.md) 与 [架构](docs/architecture.md)。

首次初始化后，日常更新统一执行：

```bash
python scripts/release-hosted-agent.py
```

该命令会发布不可变的 Hosted Agent 与 Web UI 镜像，创建并验证新的
Foundry Agent 版本，更新 Web App，并在 `.azure/releases/` 写入不含敏感值的
发布回执。`--fast` 仅跳过本地 Docker 验证，`--build-only` 只发布镜像，
`--skip-webui` 用于明确的 Agent-only 发布。

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

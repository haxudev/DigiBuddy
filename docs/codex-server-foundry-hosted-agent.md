# Codex Server on Microsoft Foundry Hosted Agent

## 1. 核心结论

可以。

但不建议简单理解为“把 Codex Server 塞进 Hosted Agent”，更合理的定义是：

> **把开源 Codex 作为 Hosted Agent 内部的 Coding Agent Runtime / Execution Engine。**

Microsoft Foundry Hosted Agent 负责 Agent Service / Runtime 层，Codex 负责 Coding Agent / Software Engineering 层。

---

## 2. 推荐架构

```text
                    Your Multi-Tenant Agent Platform
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Next.js / React Web UI                                    │
│       │                                                     │
│       │ AG-UI / Responses                                  │
│       ▼                                                     │
│  User Agent / Task Orchestrator                            │
│       │                                                     │
│       │ dispatch task                                      │
│       ▼                                                     │
│  Microsoft Foundry Hosted Agent                            │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │              Per-Session Sandbox                     │ │
│  │                                                       │ │
│  │   Agent Wrapper                                       │ │
│  │        │                                              │ │
│  │        ▼                                              │ │
│  │   ┌───────────────┐                                   │ │
│  │   │ Codex Server  │                                   │ │
│  │   │               │                                   │ │
│  │   │ Agent Loop    │                                   │ │
│  │   │ Tool Calls    │                                   │ │
│  │   │ File Editing  │                                   │ │
│  │   │ Shell         │                                   │ │
│  │   │ Git            │                                   │ │
│  │   └───────┬───────┘                                   │ │
│  │           │                                           │ │
│  │           ▼                                           │ │
│  │     Workspace / Repo                                 │ │
│  │                                                       │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 为什么适合

Codex 最需要的不是普通 Agent Framework，而是一个能够真正操作代码的隔离执行环境。

Hosted Agent 可以承担：

- 每个 session 独立 sandbox
- VM-level isolation
- persistent filesystem
- session resume
- CPU / memory 配置
- scale-to-zero
- Agent identity
- 网络 / VNet
- Observability
- Responses / Invocations / WebSocket
- AG-UI

因此 Hosted Agent 与 Codex 的 Coding Agent 模型天然匹配。

---

## 4. 不要让 Codex 直接承担 Hosted Agent Service 层

建议增加一个 Adapter / Wrapper：

```text
Foundry Responses
       │
       ▼
┌──────────────────────┐
│ Hosted Agent Adapter │
│                      │
│ session mapping      │
│ auth                 │
│ streaming            │
│ lifecycle            │
└──────────┬───────────┘
           │
           ▼
     Codex Server
           │
     ┌─────┼─────┐
     ▼     ▼     ▼
   shell  git   files
```

### Foundry / Platform 负责

- Multi-tenancy
- Session lifecycle
- Identity
- Authentication / Authorization
- Scaling
- Observability
- API Gateway
- Tenant isolation
- Agent lifecycle

### Codex 负责

- Coding Agent Loop
- Code reasoning
- Repository analysis
- File editing
- Shell execution
- Git operations
- Tests
- Code generation
- Software engineering workflow

---

## 5. Multi-Tenant 模型

可以形成如下隔离关系：

```text
Tenant A
 ├── User A1
 │    └── Session A1
 │         └── Codex Sandbox A1
 │              └── Repo A1
 │
 └── User A2
      └── Session A2
           └── Codex Sandbox A2


Tenant B
 └── User B1
      └── Session B1
           └── Codex Sandbox B1
                └── Repo B1
```

核心原则：

> **Tenant → User → Session → Sandbox → Workspace**

Hosted Agent 的 session-level isolation 可以作为第一层执行环境隔离。

---

## 6. Hosted Agent 规格需要关注

当前 Hosted Agent sandbox 的资源规格有限，因此需要重点验证 Codex 的实际工作负载。

### 比较适合

- Coding Agent
- Repo analysis
- Code generation
- Bug fixing
- PR creation
- Tests
- Shell commands
- Small / medium projects

### 需要谨慎

- 大型编译
- Docker-in-Docker
- 大型 monorepo
- GPU workload
- 长时间持续运行 server
- 高 RAM build
- 大量依赖安装

尤其需要测试：

```text
npm install
pnpm install
pip install
cargo build
dotnet build
docker build
```

在实际 Hosted Agent 资源规格下的稳定性。

---

## 7. 推荐产品化方式

不要把 Codex 看成整个 Agent Platform。

建议把它定义成：

> **Codex Hosted Agent = 一个专门负责 Software Engineering Outcome 的 Hosted Agent。**

整体架构：

```text
                    Agent Platform
                         │
             ┌───────────┴───────────┐
             │                       │
        User Agent              Task Router
             │                       │
             └───────────┬───────────┘
                         │
             ┌───────────▼───────────┐
             │    Agent Registry      │
             └───────────┬───────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     Research Agent   Sales Agent   Coding Agent
                                       │
                                       ▼
                              Foundry Hosted Agent
                                       │
                                       ▼
                                  Codex Server
                                       │
                         ┌─────────────┼─────────────┐
                         ▼             ▼             ▼
                       GitHub        Shell        Files
```

---

## 8. 最终技术定位

推荐技术栈：

```text
Web UI
  Next.js + React + TypeScript
          │
        AG-UI
          │
          ▼
User Agent / Orchestrator
          │
          ▼
Microsoft Foundry Hosted Agent
          │
          ▼
Hosted Agent Adapter
          │
          ▼
Open-source Codex Server
          │
     ┌────┼────┐
     ▼    ▼    ▼
   Git   Shell Files
```

核心思想：

> **Foundry Hosted Agent = Agent Runtime / Isolation / Service Layer**

> **Codex = Coding Agent / Execution Engine**

> **Your Platform = Multi-Tenant Product / User Experience / Orchestration Layer**

这种拆分能够很好地支撑：

**User Agent → Hosted Specialized Agents → Isolated Codex Runtime**

并且后续可以继续扩展 Research Agent、Data Agent、Sales Agent 等不同类型的 Hosted Agent。


---

# 9. Codex Server + Foundry Hosted Agent Adapter Layer

## 9.1 设计目标

Adapter 层的核心职责是：

> **把 Foundry Hosted Agent 的标准 Agent 调用模型转换为 Codex Server 的 Coding Agent 调用模型，同时隔离 Foundry 生命周期、Multi-Tenant 身份和 Codex Runtime。**

Adapter 不应该实现 Coding Agent Logic，也不应该成为新的 Agent Framework。

它应该是一个轻量的 **Protocol / Lifecycle / Security / Workspace Bridge**。

---

## 9.2 核心架构

```text
                         Agent Platform
                              │
                              │ User / Task
                              ▼
                    ┌────────────────────┐
                    │ User Agent / Router│
                    └─────────┬──────────┘
                              │
                              │ Foundry Agent Invocation
                              ▼
              ┌──────────────────────────────────┐
              │      Foundry Hosted Agent        │
              │                                  │
              │  ┌────────────────────────────┐  │
              │  │      Adapter Layer         │  │
              │  │                            │  │
              │  │  Request Adapter           │  │
              │  │  Session Mapper            │  │
              │  │  Identity / Auth           │  │
              │  │  Workspace Manager         │  │
              │  │  Event / Stream Adapter    │  │
              │  │  Lifecycle Manager         │  │
              │  │  Policy / Guardrails       │  │
              │  └─────────────┬──────────────┘  │
              │                │                 │
              │                ▼                 │
              │       ┌─────────────────┐        │
              │       │   Codex Server  │        │
              │       │                 │        │
              │       │ Agent Loop      │        │
              │       │ Tools           │        │
              │       │ Shell           │        │
              │       │ Files           │        │
              │       │ Git             │        │
              │       └────────┬────────┘        │
              │                │                 │
              │                ▼                 │
              │          Workspace / Repo        │
              └──────────────────────────────────┘
```

---

## 9.3 Adapter 的六个核心职责

### 1. Request Adapter

将 Foundry invocation 转换为 Codex task。

```text
Foundry Request
      │
      ▼
┌───────────────────────┐
│ Request Adapter       │
│                       │
│ task                  │
│ instructions          │
│ session_id            │
│ tenant_id             │
│ user_id               │
│ workspace_id          │
│ repo                   │
│ permissions            │
└───────────┬───────────┘
            ▼
       Codex Request
```

Adapter 不修改用户任务语义，只负责协议转换和上下文注入。

---

### 2. Session Mapper

建立 Foundry Session 与 Codex Session 的一一映射：

```text
Foundry
Tenant
  │
User
  │
Session
  │
  └──────────────► Codex Session
                         │
                         ▼
                    Workspace
```

推荐保存：

```text
foundry_session_id
codex_session_id
tenant_id
user_id
workspace_id
repo_id
created_at
last_active_at
status
```

核心原则：

> **Foundry Session 是平台级 Session，Codex Session 是 Coding Runtime Session。**

不要让 Codex 自己成为 Multi-Tenant Session Store。

---

## 9.4 Workspace Manager

Workspace 是整个架构最重要的隔离边界之一。

推荐：

```text
Tenant
  │
  └── User
       │
       └── Session
            │
            └── Workspace
                 ├── source/
                 ├── .git/
                 ├── .codex/
                 ├── artifacts/
                 └── logs/
```

Workspace Manager 负责：

- 初始化 workspace
- Clone repository
- Checkout branch / commit
- 恢复 session workspace
- 清理临时文件
- 管理 artifacts
- 注入必要环境变量
- 控制 workspace 权限

Codex 只看到当前 session 的 workspace。

---

## 9.5 GitHub Repository Mapping

推荐建立独立的 Repo Binding：

```text
Workspace
    │
    ▼
Repo Binding
    │
    ├── provider = github
    ├── organization
    ├── repository
    ├── branch
    ├── commit
    └── credential reference
```

不要直接把 GitHub PAT 放进 Codex Task。

推荐：

```text
Platform Identity
        │
        ▼
Credential Broker
        │
        ▼
Short-lived GitHub Credential
        │
        ▼
Workspace
        │
        ▼
Codex
```

这样 Codex 只获得完成当前任务所需要的最小权限。

---

## 9.6 Identity Propagation

身份链建议：

```text
End User
   │
   ▼
Platform Identity
   │
   ├── tenant_id
   ├── user_id
   └── roles
        │
        ▼
Foundry Agent
        │
        ▼
Adapter
        │
        ▼
Codex Runtime
```

Adapter 应该明确区分：

```text
Tenant Identity
User Identity
Agent Identity
Runtime Identity
Repository Identity
```

不要依赖用户输入中的：

```text
tenant_id
user_id
role
permission
```

这些信息必须来自可信的认证上下文。

---

## 9.7 Event / Streaming Adapter

Codex 的执行过程应该转换成平台统一的 Agent Events。

推荐统一事件模型：

```text
task.started

assistant.message.delta

tool.started
tool.output.delta
tool.completed

shell.started
shell.output.delta
shell.completed

file.changed

git.status
git.commit
git.push

task.progress

task.completed
task.failed
```

因此：

```text
Codex Events
      │
      ▼
Event Adapter
      │
      ▼
Platform Agent Events
      │
      ├── AG-UI
      ├── WebSocket
      ├── SSE
      └── Observability
```

这样前端不需要理解 Codex 内部协议。

---

## 9.8 Tool / Permission Boundary

Adapter 应该成为 Codex 的安全边界。

```text
                  Adapter Policy
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
    Files            Shell            Network
       │               │               │
    Allowlist        Policy           Policy
```

至少需要控制：

- 文件系统访问
- Shell command
- Network access
- Git operations
- Package installation
- Secret access
- External API access

核心原则：

> **Codex 可以拥有能力，但不能拥有平台权限。**

平台权限由 Adapter / Runtime Policy 决定。

---

## 9.9 Secret Management

禁止：

```text
User Prompt
    │
    ▼
Codex
    │
    ▼
Environment Variables
    │
    └── Long-lived secrets
```

推荐：

```text
Foundry / Platform Identity
          │
          ▼
      Secret Store
          │
          ▼
   Short-lived Credential
          │
          ▼
      Adapter
          │
          ▼
        Codex
```

Codex 只获得当前任务需要的 credential。

任务结束后立即失效或清理。

---

## 9.10 Codex Lifecycle

建议 Adapter 管理 Codex Runtime 生命周期：

```text
Task Received
     │
     ▼
Validate Request
     │
     ▼
Resolve Session
     │
     ▼
Prepare Workspace
     │
     ▼
Inject Runtime Policy
     │
     ▼
Start / Resume Codex
     │
     ▼
Execute Task
     │
     ├── stream events
     ├── execute tools
     ├── modify files
     └── run tests
     │
     ▼
Collect Artifacts
     │
     ▼
Persist Session State
     │
     ▼
Return Result
```

---

## 9.11 长任务模型

不要把一个 Coding Task 简化成：

```text
HTTP Request
     │
     ▼
Codex
     │
     ▼
HTTP Response
```

对于真正的 Coding Agent，应设计成：

```text
Task
 │
 ▼
Session
 │
 ▼
Execution
 │
 ├── Step 1
 ├── Step 2
 ├── Step 3
 ├── Tool Calls
 ├── Tests
 ├── Fix
 └── Verify
 │
 ▼
Outcome
```

这样可以支持：

- 长时间任务
- Session Resume
- Retry
- Human Approval
- Pause / Resume
- Failure Recovery
- Incremental Progress
- Background Execution

---

## 9.12 Human-in-the-Loop

对于高风险操作，Adapter 应提供 Approval Gate：

```text
Codex
  │
  ▼
Dangerous Action
  │
  ▼
Policy Engine
  │
  ├── Allow ─────────────► Execute
  │
  ├── Deny ──────────────► Reject
  │
  └── Approval Required
             │
             ▼
         User UI
             │
       Approve / Reject
             │
             ▼
          Codex
```

典型操作：

- git push
- production deployment
- destructive shell command
- external system mutation
- credential access
- large-scale file deletion

---

## 9.13 推荐 API 抽象

Adapter 对外尽量保持简单：

```text
POST /tasks
GET  /tasks/{task_id}
POST /tasks/{task_id}/cancel
POST /tasks/{task_id}/resume
GET  /tasks/{task_id}/events

GET  /sessions/{session_id}
POST /sessions/{session_id}/resume

GET  /workspaces/{workspace_id}
POST /workspaces/{workspace_id}/sync
```

内部：

```text
Adapter
   │
   ├── SessionService
   ├── WorkspaceService
   ├── CodexService
   ├── EventService
   ├── PolicyService
   └── CredentialService
```

---

## 9.14 数据模型

建议最少包含：

```text
Tenant
 ├── id
 └── policy

User
 ├── id
 └── tenant_id

Agent
 ├── id
 ├── type
 └── runtime

Session
 ├── id
 ├── tenant_id
 ├── user_id
 ├── agent_id
 └── codex_session_id

Task
 ├── id
 ├── session_id
 ├── status
 ├── instruction
 └── outcome

Workspace
 ├── id
 ├── session_id
 ├── repo_binding
 └── state

Execution
 ├── id
 ├── task_id
 ├── runtime_id
 └── status

Artifact
 ├── id
 ├── task_id
 └── location
```

---

## 9.15 Observability

不要只记录最终回答。

需要形成完整 Execution Trace：

```text
Tenant
  │
User
  │
Session
  │
Task
  │
Execution
  │
 ├── LLM Calls
 ├── Tool Calls
 ├── Shell Commands
 ├── File Changes
 ├── Git Operations
 ├── Errors
 └── Duration
```

建议每个 execution 都拥有：

```text
trace_id
tenant_id
user_id
session_id
task_id
execution_id
workspace_id
```

这样可以实现：

- Tenant-level usage
- Cost attribution
- Token accounting
- Runtime monitoring
- Failure analysis
- Security auditing
- Agent evaluation

---

## 9.16 推荐的最终边界

整个系统最好保持以下边界：

```text
┌────────────────────────────────────────────────────────┐
│                  Product Layer                         │
│                                                        │
│  Multi-Tenant / Billing / Users / UI / Tasks          │
└────────────────────────┬───────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────┐
│                 Agent Platform Layer                   │
│                                                        │
│  User Agent / Router / Agent Registry / Policy        │
└────────────────────────┬───────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────┐
│             Foundry Hosted Agent Layer                 │
│                                                        │
│  Identity / Session / Runtime / Scaling / Monitoring   │
└────────────────────────┬───────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────┐
│                    Adapter Layer                       │
│                                                        │
│  Protocol / Session / Workspace / Security / Events   │
└────────────────────────┬───────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────┐
│                    Codex Layer                         │
│                                                        │
│  Reasoning / Coding / Shell / Git / File Operations   │
└────────────────────────────────────────────────────────┘
```

## 9.17 核心设计原则

最终建议遵循以下原则：

1. **Foundry 管 Runtime，Codex 管 Coding。**
2. **Platform 管 Multi-Tenancy，Codex 不感知 Tenant。**
3. **Foundry Session 与 Codex Session 映射，而不是混为一体。**
4. **Workspace 是 Coding Agent 的核心隔离边界。**
5. **Adapter 是 Protocol、Identity、Security、Lifecycle 和 Event 的桥梁。**
6. **Codex 不直接接触长期凭证。**
7. **所有高风险工具操作必须经过 Policy / Approval。**
8. **前端只消费统一 Agent Events，不直接依赖 Codex 内部协议。**
9. **Task、Session、Execution、Workspace 必须独立建模。**
10. **最终结果不是“Chat Response”，而是 Software Engineering Outcome。**

最终形成：

> **User → User Agent → Task Router → Foundry Hosted Agent → Adapter → Codex → Workspace → GitHub / Tools**

这比“Hosted Agent 里运行一个 Codex Server”更准确地定义了系统边界，也为未来替换 Codex、增加其他 Coding Runtime 或增加 Research / Data / Browser Agent 留出了空间。

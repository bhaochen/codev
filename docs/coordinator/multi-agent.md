# Coordinator 多代理模式

## 概述

Coordinator 模式是 VersperClaw 的一种高级执行模式，允许一个协调者（Coordinator）LLM 通过 `AgentTool` 派生子代理（Worker）并行执行任务。通过 `CLAUDE_CODE_COORDINATOR_MODE` 环境变量激活。

### 激活方式

```bash
export CLAUDE_CODE_COORDINATOR_MODE=1
```

检测逻辑位于 `src/coordinator/coordinatorMode.ts`：

```typescript
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

### 会话模式匹配

`matchSessionMode()` 确保恢复的会话与当前 coordinator 模式一致。如果环境变量与会话存储的模式不匹配（例如在 coordinator 模式下创建会话，然后在 normal 模式下恢复），会自动翻转环境变量并记录事件。

---

## 工作模式

### 核心架构

```
User → Coordinator LLM → AgentTool → Worker 1
                                 → Worker 2
                                 → Worker 3 (并行)
```

- **Coordinator LLM**：接收用户请求，制定计划，派发任务，综合结果
- **Worker**：通过 `AgentTool` 派生的子代理，执行具体任务
- **通信**：Worker 结果通过 `<task-notification>` XML 格式返回

### Worker 通信格式

Worker 完成时，结果以 `user-role` 消息形式送达 Coordinator：

```xml
<task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed</status>
  <summary>{human-readable status summary}</summary>
  <result>{agent's final text response}</result>
  <usage>
    <total_tokens>N</total_tokens>
    <tool_uses>N</tool_uses>
    <duration_ms>N</duration_ms>
  </usage>
</task-notification>
```

Coordinator 必须区分工作结果消息和真实用户消息：工作结果包含 `<task-notification>` 标签。

---

## 工作流：四阶段模型

### Phase 1: Research（研究）
- Coordinator 并行启动多个 Worker 进行独立研究
- 每个 Worker 负责调查代码库的不同方面
- 只读任务，可自由并行

### Phase 2: Synthesis（综合）
- Coordinator **亲自**阅读所有研究发现
- 理解问题本质，编写具体的实现规格
- **关键原则**：Coordinator 必须理解研究发现再分配任务，不能将理解工作委托给 Worker

### Phase 3: Implementation（实现）
- 根据综合后的规格派发实现任务
- 按文件集串行处理写操作，避免冲突

### Phase 4: Verification（验证）
- 独立的 Worker 验证实现结果
- 真正的验证意味着证明代码工作，而非确认代码存在
- 测试、类型检查和边缘用例

---

## 并行策略

### 只读任务全并行
研究阶段的所有 Worker 可同时启动，互不影响。

### 写任务按文件集串行
实现阶段的写操作需谨慎：同一组文件的操作需要串行执行。

### 验证与实现可部分并行
实现的不同文件区域可同时进行验证。

---

## 工具集

Coordinator 拥有以下专用工具（定义于 `src/tools/AgentTool/AgentTool.tsx`）：

| 工具 | 用途 |
|------|------|
| `AgentTool`（`Agent`） | 创建新的 Worker |
| `SendMessageTool` | 向已存在的 Worker 发送后续指令 |
| `TaskStopTool` | 停止正在运行的 Worker |
| `subscribe_pr_activity` | 订阅 GitHub PR 事件 |

### AgentTool 的使用

```typescript
AgentTool({
  description: "Investigate auth bug",
  subagent_type: "worker",
  prompt: "..."
})
```

重要规则：
- 不要用一个 Worker 去检查另一个 Worker 的状态——Worker 完成时会自动通知
- 不要为简单的文件读取或命令执行创建 Worker
- 不要设置 model 参数——Worker 使用默认模型
- 已完成工作的 Worker 应通过 `SendMessageTool` 继续使用其加载的上下文

---

## Prompt 编写规则

### Worker 看不到 Coordinator 的对话

每个 Worker prompt 必须**自包含**，包含执行任务所需的全部信息。Coordinator 不能假设 Worker 知道对话中发生过什么。

### 好的 Prompt 示例

```typescript
// 好的 prompt：包含具体路径、行号和精确指令
AgentTool({
  prompt: "Fix the null pointer in src/auth/validate.ts:42. " +
    "The user field can be undefined when the session expires. " +
    "Add a null check and return early with an appropriate error. " +
    "Commit and report the hash."
})
```

### 坏的 Prompt 示例（反模式）

```typescript
// 坏的 prompt：模糊、依赖上下文
AgentTool({ prompt: "Fix the bug we discussed" }) // 错误：Worker 看不到讨论
AgentTool({ prompt: "Based on your findings, implement the fix" }) // 错误：懒惰的委托
```

### 目的陈述

为 Prompt 添加目的说明，帮助 Worker 校准深度和重点：

- "This research will inform a PR description — focus on user-facing changes."
- "I need this to plan an implementation — report file paths, line numbers, and type signatures."

### continue vs spawn 的选择

| 场景 | 策略 | 原因 |
|------|------|------|
| 研究恰好覆盖了需编辑的文件 | **Continue**（SendMessageTool） | Worker 已有文件在上下文中 |
| 研究范围广，实现范围窄 | **Spawn fresh**（AgentTool） | 避免携带探索噪音 |
| 纠正错误或扩展近期工作 | **Continue** | Worker 有错误上下文 |
| 验证其他 Worker 的代码 | **Spawn fresh** | 验证者需以新视角查看代码 |
| 完全不同的任务 | **Spawn fresh** | 无有用上下文可复用 |

---

## 实现细节

### 核心文件

| 文件 | 路径 | 用途 |
|------|------|------|
| coordinatorMode.ts | `src/coordinator/coordinatorMode.ts` | Coordinator 模式检测、会话匹配、用户上下文构建 |
| AgentTool.tsx | `src/tools/AgentTool/AgentTool.tsx` | Agent 工具的实现 |
| builtInAgents.ts | `src/tools/AgentTool/builtInAgents.ts` | 内置 Agent 定义 |

### Worker 工具白名单

内部 Worker 工具（由 `INTERNAL_WORKER_TOOLS` 定义的集合）对 Worker 不可见：

- `TeamCreateTool`
- `TeamDeleteTool`
- `SendMessageTool`
- `SyntheticOutputTool`

在简单模式（`CLAUDE_CODE_SIMPLE`）下，Worker 仅有权访问：Bash、Read、Edit 工具，外加 MCP 工具。

### Worker 错误处理

当 Worker 报告失败时：
- 使用 `SendMessageTool` 继续同一 Worker——它保留完整的错误上下文
- 如果纠正尝试也失败，尝试不同方法或报告用户

### 停止 Worker

使用 `TaskStopTool` 停止方向错误的 Worker。已停止的 Worker 可通过 `SendMessageTool` 继续。

---

## Agent Teams（Swarm 拓扑）

### 概述

Agent Teams（Swarm 模式）是 VersperClaw 的多 Agent 拓扑模型，通过 `feature('AGENT_SWARMS')` 编译期标记门控。与 Coordinator/Worker 模式不同，Teams 采用**文件系统邮箱通信**，每个 Agent 在独立进程中运行（tmux split-pane / in-process）。

### 激活方式

```bash
export CLAUDE_CODE_AGENT_SWARMS=1
```

### 核心架构

```
Team Lead (AgentTool team_name="my-team" name="lead")
    │
    ├── AgentTool(name="researcher", team_name="my-team") → tmux pane / in-process
    │     └── 邮箱: ~/.claude/teams/my-team/mailbox/researcher/
    │
    ├── AgentTool(name="coder", team_name="my-team") → tmux pane / in-process
    │     └── 邮箱: ~/.claude/teams/my-team/mailbox/coder/
    │
    └── AgentTool(name="reviewer", team_name="my-team") → tmux pane / in-process
          └── 邮箱: ~/.claude/teams/my-team/mailbox/reviewer/
```

### 与 Coordinator/Worker 的区别

| 维度 | Coordinator/Worker | Agent Teams (Swarm) |
|------|-------------------|---------------------|
| 通信 | `<task-notification>` XML 消息 | 文件系统邮箱（mailbox） |
| 进程 | 同进程 | 独立 OS 进程（tmux / in-process） |
| 生命周期 | 单次任务 | 持久化团队 |
| 隔离度 | 共享上下文 | AsyncLocalStorage（in-process）或完全隔离 |
| 工具白名单 | 统一限制 | 可配置 agent_type → 自定义工具集 |
| 嵌套 | Coordinator 可 spawn worker | **禁止**团队成员 spawn 子代（仅 team lead 可） |

### 团队创建流程

1. **创建团队**: `TeamCreateTool({ name: "my-team" })` → 生成 `~/.claude/teams/my-team/config.json`
2. **设置 Leader**: 当前会话自动成为 team-lead
3. **派发成员**: `AgentTool({ name: "researcher", team_name: "my-team", prompt: "..." })`
4. **后台抉择**:
   - In-process（启用时）→ 同一进程 AsyncLocalStorage 隔离
   - tmux split-pane（默认）→ 新 tmux 窗格
   - tmux separate-window → 新 tmux 窗口
   - iTerm2 native → macOS 原生分屏
5. **通信**: 成员写入 `mailbox/{agent-name}/`，lead 轮询读取

### 邮箱通信格式

```json
{
  "from": "researcher",
  "text": "研究发现...",
  "timestamp": 1712345678000
}
```

### 团队成员配置

自定义 Agent 定义（`~/.claude/agents/`）：

```json
{
  "name": "researcher",
  "tools": ["BashTool", "ReadTool", "GrepTool", "GlobTool"],
  "model": "claude-sonnet-4-20250514"
}
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/tools/AgentTool/AgentTool.tsx` | 统一调度入口（Line 262-316 为团队路径） |
| `src/tools/shared/spawnMultiAgent.ts` | 三种 spawn 后端实现（1105 行） |
| `src/tools/TeamCreateTool/TeamCreateTool.ts` | 团队创建 + 任务列表重置 |
| `src/tools/TeamDeleteTool/TeamDeleteTool.ts` | 团队清理 + 活跃成员验证 |
| `src/utils/swarm/teamHelpers.ts` | TeamFile 类型、文件锁、清理 |
| `src/utils/swarm/inProcessRunner.ts` | 同进程 teammate 生命周期（1553 行） |
| `src/utils/swarm/teammateInit.ts` | Stop hook、路径白名单 |
| `src/utils/swarm/constants.ts` | `TEAM_LEAD_NAME`, `SWARM_SESSION_NAME` |

### Spawn 后端对比

| 后端 | 隔离 | 优点 | 缺点 |
|------|------|------|------|
| tmux split-pane | 完整进程隔离 | 可视化管理，可独立 kill | 需要 tmux |
| tmux separate-window | 完整进程隔离 | 传统方式 | UI 不够紧凑 |
| iTerm2 native | 完整进程隔离 | macOS 原生集成 | 仅 macOS |
| In-process | AsyncLocalStorage | 无需终端，快速 | 共享进程，有限隔离 |

### 清理机制

- `cleanupSessionTeams()` 在 SIGINT/SIGTERM 时自动执行
- 终止所有团队成员窗格
- 清理团队目录和任务目录
- 文件锁防止并发竞争

### Forbidden 规则

Agent 工具过滤（`filterToolsForAgent()`）：

1. MCP 工具（`mcp__*`）始终保留
2. `ALL_AGENT_DISALLOWED_TOOLS` 从所有 Agent 移除
3. `CUSTOM_AGENT_DISALLOWED_TOOLS` 额外从非内置 Agent 移除
4. `ASYNC_AGENT_ALLOWED_TOOLS` 异步 Agent 仅允许白名单工具

---

## Fork Subagent（实验性）

### 概述

通过 `feature('FORK_SUBAGENT')` 门控，提供另一种 Agent 拓扑：子 Agent **继承父会话的全部上下文**。

### 关键特性

- **上下文继承**: 子 Agent 从父会话的完整历史开始
- **字节级缓存优化**: 所有 fork 共享相同 API 前缀（字节一致），提高 prompt 缓存命中
- **权限冒泡**: `permissionMode: 'bubble'` — 权限提示冒泡到父终端
- **强制异步**: 所有 fork spawn 必须异步执行

### 适用场景

- 需要子 Agent 拥有完整对话上下文时
- 希望复用父会话的 prompt 缓存

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/tools/AgentTool/forkSubagent.ts` | `buildForkedMessages()` 构建字节相同前缀 |

# 目标系统与自动模式

## Goal 系统

Goal（目标）系统允许用户通过 `/goal <objective>` 命令设定一个长期目标，让 Agent 在多个对话轮次中持续追寻该目标，直至完成、受阻或暂停。

### 状态机

Goal 的生命周期由以下状态构成：

```
pursuing → paused → achieved / blocked
         → usage-limited / budget-limited
```

- **pursuing（追寻中）**：初始状态，Agent 正在积极地朝目标推进。
- **paused（已暂停）**：用户使用 `/goal pause` 暂停自动续跑，可用 `/goal resume` 恢复。
- **achieved（已完成）**：Agent 认定目标已完全达成。需经过严格的完成审计（Completion Audit）。
- **blocked（已阻塞）**：Agent 遇到无法继续的障碍，需要用户介入。
- **usage-limited / budget-limited**：因 token 预算或费用限制而停止。

### 核心文件

| 文件 | 路径 | 用途 |
|------|------|------|
| goal.tsx | `src/commands/goal/goal.tsx` | `/goal` 命令的 JSX 实现（React Ink 渲染） |
| index.ts | `src/commands/goal/index.ts` | 命令注册入口 |
| goal.ts | `src/utils/goal.ts` | 工具函数：构建续跑提示、状态格式化 |
| useGoalAutoContinue.ts | `src/hooks/useGoalAutoContinue.ts` | React Hook：在每轮对话结束后自动注入续跑提示 |

### 持续提示

`buildContinuationPrompt()`（定义于 `src/utils/goal.ts`）在每轮自动续跑时注入完整的上下文提示，包含：

- **目标描述**（`<objective>` XML 标签包裹）
- **续跑行为指导**：保持目标完整性，不允许缩小范围
- **基于证据的工作原则**：依赖当前工作区状态而非对话记忆
- **完成审计要求**：必须逐项验证所有需求
- **阻塞审计规则**：连续 3 轮相同阻塞条件才允许标记 blocked

`useGoalAutoContinue` hook（`src/hooks/useGoalAutoContinue.ts`）监听 `QueryGuard` 状态：
- 当查询从活跃（running）转为空闲（idle）时触发
- 仅在 goal 状态为 `pursuing` 且非 plan 模式时注入
- 自动清理旧目标的排队续跑，防止冲突
- 每次续跑递增 `continuationCount`

### 完成审计（Completion Audit）

Agent 在决定标记目标为 `achieved` 前，必须执行严格的完成审计：

1. 从目标描述中推导具体的、可验证的需求
2. 不重新定义成功标准——保留原始范围
3. 对每个需求，检查当前状态中的权威证据
4. 确认证据足以证明完成，而非仅未发现未完成的工作
5. 只有在当前证据能够经受逐项审查时，才标记为已达成

### Blocked 审计

防止 Agent 过早放弃的机制（`src/utils/goal.ts` 中 `BLOCKED_AUDIT_TURNS = 3`）：

- 阻塞条件必须连续出现 **至少 3 轮** 才能标记 blocked
- 用户恢复已阻塞的目标后，阻塞审计重置
- 仅在确实无法推进、需要用户输入或外部状态变更时才使用
- 不因任务困难、缓慢或需要澄清而标记 blocked

### 预算跟踪

`checkTokenBudget()`（定义于 `src/query/tokenBudget.ts`）根据 token 消耗决定是否继续自动续跑：

- 使用 `createBudgetTracker()` 跟踪每次续跑的 token 消耗
- `COMPLETION_THRESHOLD = 0.9`：token 消耗达到预算的 90% 时停止
- `DIMINISHING_THRESHOLD = 500`：连续 3 次续跑且每次增量 < 500 token 时视为收益递减
- 返回 `continue` 或 `stop` 决策

---

## Auto Mode（自动模式）

### 激活方式

- 用户通过 `/goal <objective>` 设置目标后自动进入自动模式
- Plan 模式下自动模式被禁用（`inPlanMode` 检查）

### 自动续跑机制

每次 Agent 响应完成后，`useGoalAutoContinue` hook 自动向命令队列注入 `[goal] Continue` 提示：

```typescript
const prompt = buildContinuationPrompt(goal, now)
enqueue({
  mode: 'prompt',
  value: prompt,
  priority: 'later',
  isMeta: true,
})
```

- 只在 `pursuing` 状态下触发
- 跳过 plan 模式
- 用户输入优先于自动续跑（有阻塞性用户输入时不注入）
- 避免为同一目标重复排队

### update_goal 工具

Agent 可通过 `update_goal` 工具报告进度：

- `status='complete'`：目标达成，停止续跑
- `status='blocked'`：受阻，需用户介入
- 调用时必须包含 `goal_id`（与目标 ID 匹配）

### 目标管理命令

| 命令 | 功能 |
|------|------|
| `/goal <objective>` | 设置新目标（若已有活跃目标则提示覆盖确认） |
| `/goal set <objective>` | 同上 |
| `/goal pause` | 暂停当前目标 |
| `/goal resume` | 恢复被暂停的目标（重置续跑计数和预算窗口） |
| `/goal edit <new objective>` | 编辑目标描述 |
| `/goal clear` | 清除当前目标 |
| `/goal`（无参数） | 查看当前目标状态 |

---

## 查询循环（query.ts）

### queryLoop() 主循环

`src/query.ts` 中的 `queryLoop()` 是 Agent 的核心执行循环，在 `QueryEngine.ts` 中被调用。每次迭代处理一个完整的模型调用周期：

```
模型调用 → 流式响应处理 → 工具执行 → stop hooks → 继续决策
```

1. **模型调用**：`queryModelWithStreaming()` 发送消息到 API
2. **流处理**：处理 `content_block_start/delta` 事件
3. **工具执行**：检测 `tool_use` 并执行
4. **stop hooks**：执行 `handleStopHooks()`（记忆提取、自动 dream、prompt 建议等）
5. **继续决策**：检查是否需要继续循环（工具调用、max_output_tokens 恢复、goal 续跑）

### max_output_tokens 恢复

当模型响应被 `max_output_tokens` 截断时，queryLoop 提供最多 **3 次** 恢复尝试（`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`）：

1. 注入恢复提示，指导模型从中断处继续
2. 若 8K 默认输出限制触发，自动升级到 64K（一次，`tengu_otk_slot_v1` 功能门控）
3. 恢复尝试耗尽后，将错误信息输出给用户

相关变量（`src/query.ts`）：
- `maxOutputTokensRecoveryCount`：当前恢复尝试次数
- `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`：最大恢复次数
- `ESCALATED_MAX_TOKENS`：升级后的输出 token 上限

### Reactive Compaction

当上下文超出 API 限制时自动触发压缩：

- `hasAttemptedReactiveCompact`：防止在同一轮迭代中重复压缩
- 上下文超时（prompt-too-long）触发的压缩流程
- 压缩后保持 stop hooks 的阻塞错误处理
- 保留反应式压缩保护（不因 stop hook 错误而重置，防止无限循环）

---

## Task 系统

Task（任务）系统管理 Agent 派发的异步子任务。

### Task 类型

定义于 `src/Task.ts`：

| 类型 | 标识 | 用途 |
|------|------|------|
| `local_bash` | `b` | 本地 Shell 命令执行 |
| `local_agent` | `a` | 本地子 Agent |
| `remote_agent` | `r` | 远程 Agent |
| `in_process_teammate` | `t` | 进程内队友 |
| `local_workflow` | `w` | 本地工作流脚本 |
| `dream` | `d` | 记忆整理任务 |
| `monitor_mcp` | `m` | MCP 监控 |

### 状态

```
pending → running → completed / failed / killed
```

- `pending`：等待分配
- `running`：正在执行
- `completed`：正常完成
- `failed`：执行失败
- `killed`：被终止

### 后台/前台任务

任务系统区分前台任务（阻塞用户交互）和后台任务（在后台运行），但 Task 类型本身不区分配置字段；区分体现在调用上下文中。

### 任务 ID 生成

`generateTaskId()`（`src/Task.ts`）生成格式为 `{类型前缀}{8位随机字母数字}` 的 ID：
- 使用 `randomBytes(8)` 生成安全随机数
- 36 进制字母表（数字 + 小写字母）
- 36^8 ≈ 2.8 万亿种组合，抗暴力枚举

### stopTask（优雅终止）

Task 的 `kill()` 方法实现优雅终止，每个 Task 类型提供独立的 `kill` 实现（`src/tasks.ts`）：

```typescript
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

### 任务注册

`src/tasks.ts` 中的 `getAllTasks()` 收集所有可用 Task：
- 始终注册：`LocalShellTask`, `LocalAgentTask`, `RemoteAgentTask`, `DreamTask`
- 条件注册（通过 feature gate）：`LocalWorkflowTask`, `MonitorMcpTask`

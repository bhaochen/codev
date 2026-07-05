# Agent 循环与查询引擎深度分析

> 本文基于 `src/query.ts`、`src/QueryEngine.ts`、`src/query/*`、`src/services/tools/*` 等核心模块，
> 详细阐述 Codev (Claude Code) 的 Agent 循环架构、模型调用管道、工具调度机制、恢复策略与继续决策逻辑。
> 文中列出具体文件路径、函数名称与行号，供开发者快速定位代码。

---

## 目录

1. [主循环架构 (queryLoop)](#1-主循环架构-queryloop)
2. [模型调用管道](#2-模型调用管道)
3. [工具调度与流式执行](#3-工具调度与流式执行)
4. [Stop Hooks (后处理管道)](#4-stop-hooks-后处理管道)
5. [继续决策](#5-继续决策)
6. [恢复机制](#6-恢复机制)
7. [QueryEngine.ts 的角色](#7-queryenginets-的角色)
8. [工具执行引擎](#8-工具执行引擎)
9. [参考文件索引](#9-参考文件索引)

---

## 1. 主循环架构 (queryLoop)

### 1.1 概述

`queryLoop()` 是整个 Agent 的核心，它是一个 `AsyncGenerator`，运行在 `query()` 函数内部的 `while (true)` 无限循环中。每次迭代代表一个 **turn**（回合），包括：输入处理、模型调用、工具执行、后处理钩子、继续决策。

```
┌─────────────────────────────────────────────────────────────────┐
│                    queryLoop (AsyncGenerator)                     │
│                                                                   │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐      │
│  │ Pre-model │──>│  Model   │──>│  Tool    │──>│  Stop    │──>    │
│  │ Context   │   │Invocation│   │Dispatch  │   │  Hooks   │       │
│  │ Shaping   │   │(Stream)  │   │& Exec    │   │(Post-turn)│      │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘      │
│       │              │              │              │              │
│       │              │              │              │              │
│       └──────────────┴──────────────┴──────────────┘              │
│                              │                                    │
│                         ┌─────▼──────┐                            │
│                         │ Continuation│                           │
│                         │  Decision   │──> continue (loop again)  │
│                         └─────┬──────┘                            │
│                               │ stop                              │
│                               ▼                                    │
│                          return Terminal                            │
└─────────────────────────────────────────────────────────────────┘
```

**文件**: `src/query.ts`
- `query()` 函数: 第 219-239 行 — 公共入口，封装 queryLoop 并处理 consumedCommandUuids
- `queryLoop()` 函数: 第 241-1729 行 — 主循环体
- `QueryParams` 类型: 第 181-199 行 — 循环的输入参数
- `State` 类型: 第 204-217 行 — 跨迭代的可变状态

### 1.2 五种核心阶段

每一个 turn 循环包含以下阶段：

#### 阶段 A: Pre-model Context Shaping (第 365-548 行)

在调用模型之前，对消息列表进行一系列上下文压缩和优化：

1. **Tool Result Budget** (第 376-394 行): `applyToolResultBudget()` 限制每个消息中 tool_result 的总大小，防止工具输出膨胀。
2. **Snip Compact** (第 400-410 行): `snipCompactIfNeeded()` — 被 `HISTORY_SNIP` 特性门控，裁剪历史消息中的冗余内容。
3. **Microcompact** (第 413-426 行): `deps.microcompact()` — 对连续工具结果进行微压缩，减小上下文体积。
4. **Context Collapse** (第 440-447 行): `applyCollapsesIfNeeded()` — 被 `CONTEXT_COLLAPSE` 门控，对历史消息进行投影式折叠。
5. **Auto-compact** (第 454-543 行): `deps.autocompact()` — 全自动上下文压缩，当 Token 数超过阈值时触发。
6. **Blocking Limit Check** (第 628-648 行): 计算是否已达到硬性阻塞限制，阻止 API 调用并返回 `blocking_limit`。

#### 阶段 B: Model Invocation (第 652-863 行)

见第 2 节详细分析。

#### 阶段 C: Tool Dispatch & Execution (第 1360-1409 行)

- 如果启用 `StreamingToolExecutor`，使用 `getRemainingResults()` 处理流式工具结果
- 否则使用 `runTools()` 执行工具（通过 `toolOrchestration.ts`）
- 工具结果被收集到 `toolResults` 数组中

#### 阶段 D: Stop Hooks (第 1267-1306 行)

`handleStopHooks()` 处理后处理管道（见第 4 节）。

#### 阶段 E: Continuation Decision (第 1308-1357 行)

根据 token 预算、stop hooks 结果等决定是否继续循环。

### 1.3 状态管理

`queryLoop` 使用 `State` 类型（第 204-217 行）管理跨迭代的可变状态：

```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

每次迭代开始时解构 state（第 311-321 行），在所有继续点（continue sites）通过 `state = { ... }`（第 1099-1116 行、第 1207-1221 行等）整体替换。

`transition` 字段记录上次迭代的继续原因，用于测试断言恢复路径是否正确触发。

---

## 2. 模型调用管道

### 2.1 callModel 实现

模型调用通过 `deps.callModel()`（第 659 行）进行，其类型为 `typeof queryModelWithStreaming`（`src/query/deps.ts` 第 23 行）。

`queryDeps.ts` (第 21-30 行) 定义了四种依赖:
- `callModel`: `typeof queryModelWithStreaming` — 流式 API 调用
- `microcompact`: `typeof microcompactMessages` — 微压缩
- `autocompact`: `typeof autoCompactIfNeeded` — 自动压缩
- `uuid`: `() => string` — UUID 生成

`productionDeps()` (第 33-39 行) 提供生产环境实现。

### 2.2 流式事件处理

模型输出的流式事件在 `for await (const message of deps.callModel({...}))` 循环中处理（第 659-863 行）：

| 事件类型 | 处理位置 | 说明 |
|---------|---------|------|
| `text_delta` | 由 claude.ts 封装 | 文本增量 |
| `tool_use` | 第 829-845 行 | 提取 tool_use 块，推入 toolUseBlocks |
| `content_block` | 第 748-787 行 | 处理 content block，backfill tool_use input |
| `message_stop` | 第 866-892 行 | 处理缓存的微压缩边界消息 |

关键逻辑：

- **Backfill tool_use input** (第 748-787 行): 当工具定义包含 `backfillObservableInput` 时，对 tool_use 块进行输入回填（如展开文件路径）。
- **Withhold 机制** (第 799-825 行): 可恢复的错误（prompt-too-long、max-output-tokens、media-size-error）在流中被扣留（withhold），不 yield 给调用方，直到恢复机制确认无法恢复后才暴露。
- **Streaming Fallback** (第 712-741 行): 当发生流式模型回退时，清空 previous assistant messages 和 tool results，创建新的 StreamingToolExecutor。

### 2.3 max_output_tokens 恢复机制

代码位置: 第 164 行、第 1188-1256 行

```
恢复步骤:
1. 第1次: 设置 maxOutputTokensOverride = ESCALATED_MAX_TOKENS (64K) 重试
          (第 1194-1221 行, 仅当 capEnabled 且第一次)
2. 第2-4次: 注入恢复消息 "Output token limit hit. Resume directly..."
            (第 1223-1252 行, 最多 3 次 = MAX_OUTPUT_TOKENS_RECOVERY_LIMIT)
3. 超出限制: 暴露扣留的错误消息并返回 (第 1254-1256 行)
```

如果用户设置了 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 环境变量，8K→64K 的自动升级会被跳过（第 1202 行）。

### 2.4 缓存控制

- `skipCacheWrite` 参数（第 192 行）— 传递给 API 调用选项（第 697 行），控制是否跳过缓存写入。
- `pendingCacheEdits`（第 423-425 行）— `CACHED_MICROCOMPACT` 特性门控，在 API 响应后使用实际 API 报告的 `cache_deleted_input_tokens` 生成边界消息（第 870-892 行）。

---

## 3. 工具调度与流式执行

### 3.1 StreamingToolExecutor 架构

**文件**: `src/services/tools/StreamingToolExecutor.ts`

`StreamingToolExecutor` 是一个类（第 40-519 行），实现工具的流式执行调度。它在模型仍输出内容时就开始执行已到达的工具。

```
模型流式输出工具调用
         │
         ▼
  StreamingToolExecutor.addTool()
         │
         ├── 并发安全工具（concurrency-safe）→ 并行执行
         └── 非并发安全工具 → 独占执行
         │
         ▼
  收集结果 → getCompletedResults() / getRemainingResults()
```

#### 核心数据结构

```typescript
type TrackedTool = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: ToolStatus        // 'queued' | 'executing' | 'completed' | 'yielded'
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: Message[]
  pendingProgress: Message[]
  contextModifiers?: Array<(context: ToolUseContext) => ToolUseContext>
}
```

#### 并发控制

- **`addTool()`** (第 76-124 行): 将工具加入队列，立即触发 `processQueue()`。
- **`canExecuteTool()`** (第 129-135 行): 决定是否可以执行：
  - 如果没有正在执行的工具 → 总是可以
  - 如果工具是并发安全的且所有正在执行的工具也是并发安全的 → 可以
  - 否则 → 阻塞
- **`processQueue()`** (第 140-150 行): 遍历队列，对每个 queued 工具检查执行条件。
- **`getCompletedResults()`** (第 412-440 行): 非阻塞收集已完成的结果，保持顺序（非并发工具会阻断后续工具的 yield）。
- **`getRemainingResults()`** (第 453-490 行): 等待所有工具完成，带进度唤醒。

#### Bash 错误级联

当 Bash 工具失败时（第 359-363 行），`hasErrored` 被置为 `true`，兄弟工具通过 `siblingAbortController` 被取消。这防止了在 `mkdir` 失败后继续执行依赖的命令。

#### 进度通知

- **BashProgress**: Bash 工具执行的 stdout/stderr 增量更新
- **AgentProgress**: 子 agent 执行进度
- **MCPProgress**: MCP 工具执行的进度

进度消息通过 `pendingProgress` 队列立即 yield（第 368-374 行），并通过 `progressAvailableResolve` 信号唤醒 `getRemainingResults()`。

### 3.2 非流式工具执行 (runTools)

**文件**: `src/services/tools/toolOrchestration.ts`

当 `StreamingToolExecutor` 未启用时，使用 `runTools()` 函数（第 19-82 行）。

#### 工具批处理分区

`partitionToolCalls()`（第 91-116 行）将工具调用分区为批次：
- **并发安全批次**: 多个工具并行执行（通过 `runToolsConcurrently()`）
- **非并发安全批次**: 单个工具串行执行（通过 `runToolsSerially()`）

最大并发数由 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 环境变量控制，默认为 10（第 8-12 行）。

---

## 4. Stop Hooks (后处理管道)

**文件**: `src/query/stopHooks.ts`

### 4.1 概要

`handleStopHooks()` 函数（第 65-473 行）在每一 turn 的模型响应结束后运行。它是一个 `AsyncGenerator`，`yield` 进度/附件消息，最终返回 `StopHookResult`。

```typescript
type StopHookResult = {
  blockingErrors: Message[]    // 阻断性错误（钩子注入的消息）
  preventContinuation: boolean // 是否阻止继续循环
}
```

### 4.2 执行流程

```
  1. 保存 cacheSafeParams (第 96-98 行)
  2. 模板作业分类 (第 108-132 行)
  3. Prompt 建议 (第 139 行) [fire-and-forget]
  4. Memory 提取 (第 141-153 行) [fire-and-forget]
  5. Auto-dream (第 154-156 行) [fire-and-forget]
  6. MCP 清理 (第 164-173 行)
  7. executeStopHooks() (第 180 行) — 主钩子执行
  8. Teammate hooks (第 335-453 行)
```

### 4.3 Stop Hooks 执行

`executeStopHooks()`（第 180 行）返回一个 generator，产生进度消息和阻断错误。

钩子结果处理（第 192-295 行）：
- **进度消息** (第 201-215 行): 收集每个钩子的 `command` 和 `promptText`
- **阻断错误** (第 257-267 行): 创建 `createUserMessage({ isMeta: true })` 作为阻断消息
- **继续阻止** (第 269-280 行): 生成 `hook_stopped_continuation` 附件
- **中止检测** (第 283-294 行): 如果被中止，返回 `{ preventContinuation: true }`

### 4.4 后台任务

| 任务 | 位置 | 说明 |
|------|------|------|
| `executePromptSuggestion()` | 第 139 行 | 生成提示建议（仅非 bare 模式） |
| `executeExtractMemories()` | 第 141-153 行 | 提取记忆（`EXTRACT_MEMORIES` 门控） |
| `executeAutoDream()` | 第 154-156 行 | 自动记忆整理 |
| `cleanupComputerUseAfterTurn()` | 第 164-173 行 | MCP 计算机使用清理（`CHICAGO_MCP` 门控） |

### 4.5 模板作业分类

当设置了 `CLAUDE_JOB_DIR` 环境变量时（第 110 行），`jobClassifierModule!.classifyAndWriteState()`（第 121 行）在每次 turn 后分类作业状态。加 60 秒超时（第 127-131 行）。

### 4.6 Teammate Hooks

在 teammate 模式下（第 335 行）：

1. **TaskCompleted hooks** (第 345-400 行): 对每个 `in_progress` 且属于当前 teammate 的任务执行 `executeTaskCompletedHooks()`。
2. **TeammateIdle hooks** (第 402-441 行): 执行 `executeTeammateIdleHooks()`。

这两个钩子都支持 `preventContinuation` 和 `blockingErrors`。

### 4.7 阻断错误与继续抑制

- `blockingErrors`: 由钩子注入的系统消息，作为当前 turn 的继续输入（第 1282-1306 行）
- `preventContinuation`: 立即结束循环返回 `stop_hook_prevented`（第 1278 行）
- **错误免入死亡螺旋** (第 1260-1264 行): 当 lastMessage 是 API 错误时，跳过 stop hooks

---

## 5. 继续决策

**文件**: `src/query/tokenBudget.ts`

### 5.1 checkTokenBudget

```typescript
function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,       // getCurrentTurnTokenBudget()
  globalTurnTokens: number,    // getTurnOutputTokens()
): TokenBudgetDecision
```

第 45-93 行。

### 5.2 决策逻辑

```
1. 跳过条件: agentId 存在 OR budget 为 null/0 → stop (第 51-53 行)
2. 计算使用率 pct = turnTokens / budget * 100 (第 56 行)
3. 收益递减检测: 连续 3+ 次继续且每次增量 < 500 tokens (第 59-62 行)
4. 如果 pct < 90% 且非收益递减 → continue (第 66-75 行)
5. 否则 → stop (第 78-92 行)
```

### 5.3 90% 阈值

`COMPLETION_THRESHOLD = 0.9`（第 3 行）: 当 token 消耗达到预算的 90% 时触发继续。

### 5.4 收益递减检测

`DIMINISHING_THRESHOLD = 500`（第 4 行）: 当连续 3+ 次继续且每次增量 < 500 tokens，认为模型收益递减，提前停止。

### 5.5 集成到 queryLoop

在 `queryLoop` 中（`src/query.ts` 第 1308-1355 行）：

```typescript
if (feature('TOKEN_BUDGET')) {
  const decision = checkTokenBudget(budgetTracker!, ...)
  if (decision.action === 'continue') {
    // 注入 nudgemessage
    // incrementBudgetContinuationCount()
    // 设置 state.transition = { reason: 'token_budget_continuation' }
    // continue (继续循环)
  }
  // 否则记录 completionEvent
}
// return { reason: 'completed' }
```

### 5.6 任务预算 (taskBudget)

`taskBudget`（`src/query.ts` 第 197-198 行）是 API 端的 `task_budget`（output_config.task_budget, beta task-budgets-2026-03-13）。与 `tokenBudget` +500k 自动继续的不同。

- 在每次压缩后计算 `taskBudgetRemaining`（第 508-515 行、第 1138-1146 行）
- 传递给 API 调用（第 699-706 行）

---

## 6. 恢复机制

### 6.1 max_output_tokens 恢复

**文件**: `src/query.ts`

| 恢复阶段 | 触发条件 | 行为 | 行号 |
|---------|---------|------|------|
| 8K→64K 升级 | 首次命中上限，capEnabled 且无用户自定义 | 设置 maxOutputTokensOverride=64K，重试 | 第 1194-1221 行 |
| 恢复消息注入 | 已升级或 cap 关闭 | 注入 "Output token limit hit" 消息 | 第 1223-1252 行 |
| 限制耗尽 | 超过 3 次 | 暴露扣留的错误 | 第 1254-1256 行 |

`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`（第 164 行）。

### 6.2 Context Collapse 压缩

**文件**: `src/query.ts`

当 API 返回 prompt-too-long 错误时（第 1085-1118 行）：

1. 首先尝试 `contextCollapse.recoverFromOverflow()`（第 1094 行） — 从已分阶段（staged）的折叠队列中释放
2. 如果已经尝试过 `collapse_drain_retry`（第 1092 行），则跳过直接走 reactive compact

### 6.3 Reactive Compact

**文件**: `src/query.ts`

当 prompt-too-long 错误和 reactive compact 都启用时（第 1119-1175 行）：

1. 调用 `reactiveCompact.tryReactiveCompact()`（第 1120 行）
2. 成功→构建压缩消息，设置 `hasAttemptedReactiveCompact = true`
3. 失败→暴露错误消息

### 6.4 错误恢复策略总结

```
API 413 (prompt too long)
  ├── Context Collapse drain (第 1094 行)
  │     └── 失败→ fall through
  ├── Reactive Compact (第 1120 行)
  │     └── 失败→ 返回 prompt_too_long
  └── (如果两者都不可用) → 返回 blocking_limit

max_output_tokens
  ├── 8K→64K escalate (第 1194 行)
  ├── 恢复消息注入 x3 (第 1223 行)
  └── 暴露错误 (第 1254 行)

model fallback (第 893-953 行)
  └── 切换到备用模型，清理并重试

一般错误 (第 955-997 行)
  └── yield 错误消息，返回 model_error
```

---

## 7. QueryEngine.ts 的角色

**文件**: `src/QueryEngine.ts`

### 7.1 概述

`QueryEngine` 类（第 184-1177 行）封装了查询生命周期和会话状态，是 `ask()` 函数的核心引擎。它提取了在 headless/SDK 和 REPL 间共享的逻辑。

### 7.2 与 query.ts 的关系

```
  ask() 函数                          QueryEngine.submitMessage() 方法
    │                                       │
    │  创建 QueryEngine 实例                  │
    │  (第 1249-1285 行)                     │
    │                                       │
    └─── query() ────────────────────────────┘
          │
          │  AsyncGenerator
          ▼
      yield 消息流 (assistant/user/attachment/stream_event/...)
```

- `ask()`（第 1186-1295 行）是一个便利包装器，创建 `QueryEngine` 实例并调用 `submitMessage()`
- `QueryEngine.submitMessage()`（第 209-1156 行）处理完整的查询生命周期：
  1. 构建 `ProcessUserInputContext`（第 335-395 行）
  2. 处理用户输入（第 410-428 行）
  3. 记录 transcript（第 450-463 行）
  4. 调用 `query()`（第 675-686 行）
  5. 处理 query 产出的所有消息类型（第 757-969 行）
  6. 生成最终 result（第 1082-1155 行）

### 7.3 关键职责

- **消息持久化**: `recordTranscript()`（第 717-732 行）
- **权限跟踪**: `wrappedCanUseTool()` 包装（第 244-271 行）记录权限拒绝
- **SDK 消息规范化**: `normalizeMessage()`（第 769、783、787 行）
- **预算检查**: USD 预算（第 972-1002 行）和结构化输出重试限制（第 1005-1048 行）
- **Snip 回放**: `snipReplay` 回调（第 905-914 行）在 SDK 模式下处理 snip 边界

### 7.4 submitMessage 的消息处理

`submitMessage()` 的 `for await` 循环处理 10+ 种消息类型：

| 消息类型 | 处理 | 行号 |
|---------|------|------|
| `assistant` | push 到 mutableMessages，yield 规范化 | 第 761-769 行 |
| `user` | push，yield 规范化，turnCount++ | 第 753-787 行 |
| `progress` | push，记录 transcript | 第 771-783 行 |
| `stream_event` | 累积 usage，跟踪 stop_reason | 第 788-827 行 |
| `attachment` | 处理结构化输出、max_turns、queued_command | 第 829-893 行 |
| `system` | 处理 compact_boundary、api_error、snip | 第 897-958 行 |
| `tool_use_summary` | yield 工具使用摘要 | 第 959-969 行 |

---

## 8. 工具执行引擎

**文件**: `src/services/tools/toolExecution.ts`

### 8.1 工具执行九步生命周期

`runToolUse()` 函数（第 337-490 行）实现工具的完整执行生命周期：

```
1. Tool Lookup & Validation
   │  findToolByName() (第 345 行)
   │  别名回退 (第 350-355 行)
   ▼
2. Abort Check
   │  abortController.signal.aborted (第 415 行)
   ▼
3. Input Validation (Zod)
   │  tool.inputSchema.safeParse() (第 615 行)
   ▼
4. Custom Validation
   │  tool.validateInput() (第 683 行)
   ▼
5. Pre-Tool Hooks
   │  runPreToolUseHooks() (第 800 行)
   ▼
6. Permission Check & User Confirmation
   │  resolveHookPermissionDecision() (第 921 行)
   │  canUseTool() (第 927 行)
   ▼
7. Tool Execution
   │  tool.call() (第 1207 行)
   ▼
8. Result Processing
   │  tool.mapToolResultToToolResultBlockParam() (第 1292 行)
   │  processToolResultBlock() (第 1415 行)
   ▼
9. Post-Tool Hooks
   │  runPostToolUseHooks() (第 1483 行)
   │  runPostToolUseFailureHooks() (第 1700 行)
```

### 8.2 详细步骤解析

#### 步骤 1-2: 工具查找与中止检查

`runToolUse()`（第 337-490 行）：

```typescript
// 1. 查找工具 (第 345-355 行)
let tool = findToolByName(toolUseContext.options.tools, toolName)
if (!tool) {
  // 通过别名回退 (第 350-355 行)
}
// 2. 中止检查 (第 415-453 行)
if (toolUseContext.abortController.signal.aborted) {
  // yield "cancelled" 消息
}
```

#### 步骤 3-4: 输入验证

`checkPermissionsAndCallTool()`（第 599-1745 行）：

**Zod Schema 验证**（第 615-679 行）:
- `tool.inputSchema.safeParse(input)` 使用 Zod 验证模型输入
- 失败时生成格式化的 Zod 错误并附加 schema-not-sent 提示（第 578-597 行）
- `buildSchemaNotSentHint()`: 检测到延迟工具（deferred tool）的 schema 没有被发送到 API 时，提示模型使用 ToolSearch 重新加载

**自定义验证**（第 683-733 行）:
- 每个工具可以定义自己的 `validateInput()` 方法
- 验证失败返回 `isValidCall.result === false`

#### 步骤 5: Pre-Tool Hooks

**文件**: `src/services/tools/toolHooks.ts`

`runPreToolUseHooks()`（第 435-650 行）:

返回多类型结果：
| 结果类型 | 说明 |
|---------|------|
| `message` | 进度消息或附件消息 |
| `hookPermissionResult` | 钩子做出的权限决定 (allow/deny/ask) |
| `hookUpdatedInput` | 钩子修改后的输入 (passthrough) |
| `preventContinuation` | 阻止继续 |
| `stopReason` | 停止原因 |
| `additionalContext` | 额外的上下文消息 |
| `stop` | 立即停止 |

#### 步骤 6: 权限检查

**文件**: `src/services/tools/toolHooks.ts`

`resolveHookPermissionDecision()`（第 332-433 行）:

- **Hook allow**: 仍然检查 settings.json 的 deny/ask 规则（第 373-385 行）
- **Hook deny**: 直接拒绝（第 408-411 行）
- **无钩子决定**: 走正常权限流程，可能包含 forceDecision（第 413-432 行）
- **需用户交互**: 钩子批准后如果 `requiresUserInteraction()` 或 `requireCanUseTool`，仍调用 `canUseTool()`（第 356-370 行）

`canUseTool` 在 `src/hooks/useCanUseTool.tsx` 中实现（React hook），处理 interactive/coordinator/swarm 三种权限模式。

#### 步骤 7: 工具执行

`tool.call()`（第 1207 行）:
- 使用处理后的输入调用工具
- 通过 `onToolProgress` 回调报告进度
- 使用 `toolAbortController`（第 301 行）实现 per-tool 取消

Bash 错误级联（第 359-363 行）:
```typescript
if (tool.block.name === BASH_TOOL_NAME) {
  this.hasErrored = true
  this.siblingAbortController.abort('sibling_error')
}
```

#### 步骤 8: 结果处理

- `tool.mapToolResultToToolResultBlockParam()`（第 1292 行）映射工具结果
- `processPreMappedToolResultBlock()` / `processToolResultBlock()`（第 1409-1415 行）进行后处理
- `applyToolResultBudget()`（第 379 行）限制工具结果大小

#### 步骤 9: Post-Tool Hooks

**文件**: `src/services/tools/toolHooks.ts`

`runPostToolUseHooks()`（第 39-191 行）:
- 对 MCP 工具，支持 `updatedMCPToolOutput`
- 支持 `blockingError`、`preventContinuation`、`additionalContext`

`runPostToolUseFailureHooks()`（第 193-319 行）:
- 工具失败时执行
- 同样支持 `blockingError`、`preventContinuation`、`additionalContext`

### 8.3 错误分类与处理

`classifyToolError()`（第 150-171 行）将错误分类为安全的 telemetry 字符串：
- `TelemetrySafeError`: 使用预审的 telemetryMessage
- Node.js `errno` 错误: 记录 `ENOENT` 等代码
- 已知错误类型: 使用构造函数名称
- 未知错误: 降级为 `"Error"`

### 8.4 工具遥测

工具执行的每个阶段都会发出遥测事件：

| 事件 | 触发时机 | 代码位置 |
|------|---------|---------|
| `tengu_tool_use_error` | 工具不存在 | 第 372 行 |
| `tengu_tool_use_cancelled` | 工具被取消 | 第 416 行 |
| `tengu_tool_use_progress` | 进度更新 | 第 523 行 |
| `tengu_tool_use_can_use_tool_rejected` | 权限拒绝 | 第 1001 行 |
| `tengu_tool_use_can_use_tool_allowed` | 权限批准 | 第 1105 行 |
| `tengu_tool_use_success` | 工具执行成功 | 第 1331 行 |
| `tool_decision` (OTel) | 权限决策 | 第 962 行 |
| `tool_result` (OTel) | 工具结果 | 第 1381 行 |

---

## 9. 参考文件索引

| 文件 | 路径 | 核心内容 |
|------|------|---------|
| 主查询循环 | `src/query.ts` | `query()`, `queryLoop()`, 完整 Agent 循环 |
| 查询配置 | `src/query/config.ts` | `buildQueryConfig()`, `QueryConfig` 类型 |
| 查询依赖 | `src/query/deps.ts` | `QueryDeps`, `productionDeps()` |
| 停止钩子 | `src/query/stopHooks.ts` | `handleStopHooks()`, StopHookResult |
| Token 预算 | `src/query/tokenBudget.ts` | `checkTokenBudget()`, `BudgetTracker` |
| 转换类型 | `src/query/transitions.ts` | `Terminal`, `Continue` 类型 |
| 查询引擎 | `src/QueryEngine.ts` | `QueryEngine` 类, `ask()` 函数 |
| 工具流式执行器 | `src/services/tools/StreamingToolExecutor.ts` | `StreamingToolExecutor` 类 |
| 工具执行 | `src/services/tools/toolExecution.ts` | `runToolUse()`, `checkPermissionsAndCallTool()` |
| 工具编排 | `src/services/tools/toolOrchestration.ts` | `runTools()`, `partitionToolCalls()` |
| 工具钩子 | `src/services/tools/toolHooks.ts` | `runPreToolUseHooks()`, `runPostToolUseHooks()`, `resolveHookPermissionDecision()` |
| 权限检查 | `src/hooks/useCanUseTool.tsx` | `useCanUseTool()` React hook, 权限模式 |

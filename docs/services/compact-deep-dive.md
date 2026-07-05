# 上下文压缩管道 (Compaction Pipeline) 深度分析

> 本文档基于 Codev 源代码分析，涵盖 `/src/services/compact/` 目录下的全部压缩机制，
> 以及 `/src/query.ts` 中压缩管道编排逻辑。

---

## 1. 压缩管道的动机

### 1.1 上下文窗口是绑定资源约束

大语言模型（LLM）的推理上下文存在**硬性 token 上限**。对 Claude 系列模型而言，
这个上限通常是 200K token。一旦消息历史超过该上限，API 将返回 `prompt_too_long` 错误，
对话无法继续。

在实际使用中，上下文窗口面临三个核心矛盾：

```
Token 使用量
  ^
  |                                  / 硬上限 (200K)
  |                                 /
  |                      / 自动压缩阈值 (~window - 13K)
  |                     /
  |          / 警告阈值 (~window - 20K)
  |         /
  |  / 实际用量 (随时间增长)
  | /
  +------------------------------------------> 时间/轮次
```

### 1.2 三个关键约束

| 约束 | 说明 | 代码证据 |
|------|------|----------|
| **Token 硬限制** | 超过模型上下文窗口后 API 拒绝请求 | `compact.ts:106-107` 的 `PROMPT_TOO_LONG_ERROR_MESSAGE` |
| **90% 阈值后性能下降** | 接近窗口上限时，模型的检索精度和推理质量显著下降 | `autoCompact.ts:62` 的 `AUTOCOMPACT_BUFFER_TOKENS = 13_000` 保留缓冲 |
| **Cache 效率衰减** | 大上下文降低 prompt caching 命中率，增加 API 成本和延迟 | `compact.ts:435-438` 的 `tengu_compact_cache_prefix` 实验开关 |

### 1.3 压缩管道的设计目标

压缩管道的核心目标是：**在保证对话质量的前提下，以最小代价持续将上下文维持在可用窗口内**。

设计原则：
- **分层递进**：从零成本到高成本逐层尝试，避免过早触发昂贵的 LLM 调用
- **优先级有向**：保留高价值消息（用户意图、关键决策、代码变更），裁剪低价值内容（工具结果、确认消息）
- **无损恢复**：压缩后的关键状态（文件附件、计划、技能）自动恢复
- **语义连续**：模型感知不到压缩的发生，对话体验自然衔接

---

## 2. 五层压缩管道

压缩管道在 `src/query.ts` 的主循环中按固定顺序编排执行。
每一层如果成功缓解了上下文压力，后续更昂贵的层就不会触发。

```
  查询开始
     │
     ▼
┌─────────────────────────────────────┐
│  Layer 1:  预算削减 (Budget Re-     │  零成本
│             duction)                 │
│  工具结果 → 磁盘换预览              │
└─────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────┐
│  Layer 2:  剪切 (Snip)              │  零成本
│  移除低价值消息                     │
└─────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────┐
│  Layer 3:  微压缩 (Micro-compact)   │  近零成本
│  删除旧工具结果 / 缓存编辑          │
└─────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────┐
│  Layer 4:  上下文折叠 (Context      │  O(1)
│             Collapse)               │
│  多轮交互 → 紧凑提交                │
└─────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────┐
│  Layer 5:  自动压缩 (Auto-compact)  │  高成本
│  LLM 语义摘要                        │  (一次 API 调用)
└─────────────────────────────────────┘
     │
     ▼
   发送给 API
```

---

### Layer 1: 预算削减 (Budget Reduction)

**文件**: `src/utils/toolResultStorage.ts` (第 740-839 行)
**函数**: `enforceToolResultBudget()`
**成本**: 零 LLM 调用。纯内存操作，涉及可选的磁盘 I/O。

#### 触发条件

每次模型调用前无条件执行。它有一个内部"预算"概念：每条用户消息中的工具结果
（`tool_result`）聚合大小超过**单条消息预算限制**（通过 GrowthBook 的
`tengu_plum_marten` 特性标识配置，见 `getPerMessageBudgetLimit()`）。

#### 算法/策略

```
对于每条用户消息的工具结果组：
  1. 划分已知结果（seenIds 中已存在）和新鲜结果
  2. 已知结果 → 从缓存中重新应用相同的预览替换
  3. 新鲜结果 → 检查聚合大小是否超限
  4. 超限 → 选择最大的新鲜结果持久化到磁盘，替换为预览摘要
  5. 记录替换决策到 seenIds 和 replacements Map
```

核心逻辑（`enforceToolResultBudget` 第 769 行）：
- `seenIds`：追踪已处理过的 `tool_use_id`，避免同一结果被反复替换
- `replacements`：缓存替换后的预览内容，后续调用直接复用（零 I/O）
- 每条消息独立计算，不会跨消息"借用"预算

#### 保留什么

- 所有不超过预算的消息保持原样
- 用户自然语言消息始终完整保留
- 不超过预算的工具结果完整保留

#### 丢弃什么

- 超预算消息中**最大的新鲜工具结果**被替换为磁盘文件引用 + 摘要预览
- 替换是幂等的：同一 `tool_use_id` 每次得到相同的预览

#### 为什么这是第一层

此层在物理上压缩消息内容但不改变消息结构。它运行在微压缩**之前**，
因为缓存微压缩（Cached MC）只通过 `tool_use_id` 操作——它对内容替换不可见，
两者可以干净地组合（`query.ts:369-394` 注释）。

---

### Layer 2: 剪切 (Snip)

**文件**: `src/services/compact/snipCompact.ts`
**成本**: 零 LLM 调用。纯消息过滤。

#### 触发条件

由 `feature('HISTORY_SNIP')` 特性标识控制，仅在内部版本中启用
（`query.ts:115-116`）。外部构建中是空操作桩（stub）。

外部构建中的状态（`snipCompact.ts:9`）：

```typescript
export function isSnipRuntimeEnabled(): boolean {
  return false
}
```

#### 算法/策略

移除低价值消息。典型的可剪切消息包括：
- 用户简短确认（"ok"、"好的"、"继续"）
- 简单的工具结果（bash 命令退出码 0、文件写入成功）
- 重复的系统消息

剪切操作会插入一个 `snip_marker` 边界消息（`subtype === 'snip_marker'`）
以标记消息已被移除，同时保持消息链的连续性。

#### Token 节省传递

`query.ts:400-410` 中，snip 操作产生的 `tokensFreed` 被传递给后续的
`shouldAutoCompact()` 检查。这是因为 `tokenCountWithEstimation` 从存活
assistant 消息的 usage 字段读取 token 计数，而 snip 移除的是用户消息，
导致计费 token 与实际压缩后的上下文不一致。

---

### Layer 3: 微压缩 (Micro-compact)

**文件**: `src/services/compact/microCompact.ts`
**函数**: `microcompactMessages()` (第 253 行)
**成本**: 近零。纯 JS 逻辑，无 LLM 调用。

微压缩有三个子路径，按优先级执行：

```
microcompactMessages()
    │
    ├── 时间触发微压缩 (Time-based MC)
    │   如果自上次 assistant 消息超过阈值 → 清除旧工具结果内容
    │
    ├── 缓存微压缩 (Cached MC)
    │   使用 API cache_edits 在不破坏缓存前缀的前提下删除工具结果
    │
    └── 传统路径 (已移除)
       之前使用本地消息修改，已被 Cached MC 完全取代
```

#### 3a: 时间触发微压缩 (Time-based MC)

**文件**: `src/services/compact/timeBasedMCConfig.ts`
**配置键**: `tengu_slate_heron`
**触发**: `evaluateTimeBasedTrigger()` (第 422 行)

当满足以下条件时触发：
1. 特性启用（`enabled: true`）
2. 主线程查询源（`querySource` 以 `repl_main_thread` 开头或为空）
3. 最后一条 assistant 消息的时间戳与当前时间之差超过配置阈值（默认 60 分钟）
4. 存在可压缩的工具结果

此时，服务器端 prompt cache 几乎肯定已过期（60 分钟 TTL），
全部前缀将被重写——因此在请求前清除旧工具结果内容以缩小重写范围。

操作：将除最近 N 个（默认 5 个，`keepRecent: 5`）之外的所有可压缩工具
结果内容替换为 `'[Old tool result content cleared]'` 标记
（`microCompact.ts:36` 的 `TIME_BASED_MC_CLEARED_MESSAGE`）。

**重要副作用**：内容更改使服务器缓存失效，因此重置缓存微压缩状态
（`resetMicrocompactState()`），防止后续缓存编辑引用已不存在的工具。

#### 3b: 缓存微压缩 (Cached MC)

**文件**: `src/services/compact/cachedMicrocompact.ts`
**函数**: `cachedMicrocompactPath()` (第 305 行)
**配置**: `cachedMCConfig.ts`

这是真正巧妙的微压缩——利用 Anthropic API 的 `cache_edits` 功能，
在不改变本地消息数组的情况下，通过 API 层面删除旧工具结果。
prompt cache 前缀保持完整，无需重新计算。

```
  传统方式 (已废弃)               缓存编辑方式 (当前)
  ┌────────────────┐             ┌────────────────┐
  │ 修改消息内容    │             │ 消息内容不变    │
  │ 删除工具结果块  │             │ 添加 cache_edits│
  │ Prompt cache 失效│             │ Prompt cache 命中│
  │ 重新发送全部前缀 │             │ 只发送差异编辑  │
  └────────────────┘             └────────────────┘
```

状态管理（`CachedMCState`）：
- `registeredTools`: 已注册的工具结果 ID 集合
- `toolOrder`: 工具结果注册的顺序列表
- `deletedRefs`: 已被删除的引用集合
- `pinnedEdits`: 需要固定在特定用户消息位置的编辑块

触发条件：
- 已注册的工具结果数 >= `triggerThreshold`（默认 12 个）
- 模型支持缓存编辑（`supportedModels: ['claude-opus-4-6', 'claude-sonnet-4-6']`）
- 主线程查询源

执行流程：
1. 扫描消息，收集所有可压缩工具 ID（`collectCompactableToolIds()`，第 226 行）
2. 将新的工具结果注册到状态中（`registerToolResult()`/`registerToolMessage()`）
3. 检查是否需要触发删除（`getToolResultsToDelete()`，第 62 行）
4. 创建 `cache_edits` 块（`createCacheEditsBlock()`，第 73 行）
5. 将待处理的编辑排入队列，在 API 调用时发送

**可压缩工具列表**（`microCompact.ts:41-50`）：

```typescript
const COMPACTABLE_TOOLS = new Set([
  FILE_READ_TOOL_NAME,     // Read
  ...SHELL_TOOL_NAMES,     // Bash
  GREP_TOOL_NAME,          // Grep
  GLOB_TOOL_NAME,          // Glob
  WEB_SEARCH_TOOL_NAME,    // WebSearch
  WEB_FETCH_TOOL_NAME,     // WebFetch
  FILE_EDIT_TOOL_NAME,     // Edit
  FILE_WRITE_TOOL_NAME,    // Write
])
```

这些工具的结果通常体积大但信息密度低，且模型可以直接重新调用这些工具
获取最新信息。

#### 3c: API 微压缩 (API Micro-compact)

**文件**: `src/services/compact/apiMicrocompact.ts`
**函数**: `getAPIContextManagement()` (第 64 行)

提供服务器端上下文管理策略配置：
- `clear_tool_uses_20250919`: 按输入 token 阈值清除旧工具结果/工具调用
- `clear_thinking_20251015`: 按轮次保留/清除思考块

仅在 `process.env.USER_TYPE === 'ant'` 且设置了环境变量时生效。

---

### Layer 4: 上下文折叠 (Context Collapse)

**文件**: `src/services/contextCollapse/index.ts`
**成本**: O(1) 投影操作。无 LLM 调用。

#### 触发条件

由 `feature('CONTEXT_COLLAPSE')` 特性标识控制。当前版本中为**空操作桩**，
仅在内部构建中实际启用（`query.ts:18-19`）。

```typescript
// 外部构建：
export function isContextCollapseEnabled(): boolean { return false }
export async function applyCollapsesIfNeeded(messages, _, __) { return { messages } }
```

#### 概念

上下文折叠是一种**增量提交**机制。它将多轮交互压缩为紧凑的摘要提交（commit），
同时保持主 REPL 数组的完整性。核心思想是将压缩操作从一次性大规模 API 调用
分解为持续的增量操作。

折叠状态通过提交日志持久化，每次投影视图时重新应用。这使得折叠在对话轮次之间保持稳定。

#### 与自动压缩的关系

当上下文折叠启用时，自动压缩（Auto-compact）**被抑制**（`autoCompact.ts:215-223`）：

```typescript
if (feature('CONTEXT_COLLAPSE')) {
  const { isContextCollapseEnabled } = require('../contextCollapse/index.js')
  if (isContextCollapseEnabled()) {
    return false  // 阻止自动压缩
  }
}
```

原因是折叠系统在 90%（提交起点）和 95%（阻塞阈值）之间自主管理上下文空间。
自动压缩在 ~93% 的阈值触发，会与折叠竞争并通常获胜——破坏折叠即将保存的
细粒度上下文。

---

### Layer 5: 自动压缩 (Auto-compact)

**文件**: `src/services/compact/autoCompact.ts` (编排), `compact.ts` (执行), `prompt.ts` (提示词)
**函数**: `autoCompactIfNeeded()` (第 241 行) -> `compactConversation()` (第 387 行)
**成本**: **高。** 一次完整的 LLM API 调用，内容包括整个待压缩消息集 + 系统提示词。

#### 触发条件

`shouldAutoCompact()` (第 160 行) 计算：

```
阈值 = getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS(13,000)
     = (contextWindow - min(maxOutputTokens, 20,000)) - 13,000
```

```
getEffectiveContextWindowSize(model) = contextWindow - min(maxOutput, 20,000)
                                                      ↓
getAutoCompactThreshold(model) = effectiveWindow - 13,000 (AUTOCOMPACT_BUFFER_TOKENS)
```

环境变量覆盖：
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: 直接设置上下文窗口上限
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: 按百分比设置阈值（用于测试）

**递归保护**（第 171-183 行）：
- `querySource === 'session_memory'` 或 `'compact'` → 跳过（分叉代理会死锁）
- `querySource === 'marble_origami'` → 跳过（上下文折叠分叉会破坏主线程状态）

**熔断机制**（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`）：
当上下文不可恢复地超限时（如 `prompt_too_long`），连续失败 3 次后
自动压缩永久跳过当前会话——否则全局每天浪费约 25 万次无效 API 调用。

#### 算法/策略

自动压缩首先尝试**会话记忆压缩**（见第 5 节，无 LLM 调用），
只有在该路径失败时才退回到完整的 LLM 摘要压缩。

```
autoCompactIfNeeded()
    │
    ├── 尝试会话记忆压缩 (trySessionMemoryCompaction)
    │    ├── 成功 → 返回 CompactionResult (无 API 调用)
    │    └── 失败 → 继续
    │
    └── 完整压缩 (compactConversation)
         ├── 执行 PreCompact 钩子
         ├── 生成 LLM 摘要
         ├── 恢复文件附件
         ├── 创建边界标记
         └── 执行 PostCompact 钩子
```

`compactConversation()` 的执行流程：

```
1. 验证消息非空
2. 执行 PreCompact 钩子（自定义指令合并）
3. 构建摘要提示词 (getCompactPrompt)
4. 流式调用 LLM 获取摘要
   ├── 优先使用缓存共享路径 (forked agent)
   │   复用主线程的 prompt cache，无需重新计算
   │   节省 ~90% 的输入 token 成本
   └── 失败时退回到常规流式路径
5. 保存预压缩文件状态，清空读文件缓存
6. 并行生成：
   ├── 文件附件恢复 (createPostCompactFileAttachments)
   ├── 异步代理状态附件 (createAsyncAgentAttachmentsIfNeeded)
   ├── 计划文件附件 (createPlanAttachmentIfNeeded)
   ├── 计划模式指令附件 (createPlanModeAttachmentIfNeeded)
   ├── 技能内容附件 (createSkillAttachmentIfNeeded)
   ├── 延迟工具增量声明 (getDeferredToolsDeltaAttachment)
   ├── 代理列表增量声明 (getAgentListingDeltaAttachment)
   └── MCP 指令增量声明 (getMcpInstructionsDeltaAttachment)
7. 执行 SessionStart 钩子
8. 创建压缩边界标记 (createCompactBoundaryMessage)
9. 构建摘要用户消息
10. 执行 PostCompact 钩子
11. 返回 CompactionResult
```

#### 缓存共享路径

`streamCompactSummary()` (第 1136 行) 使用 `runForkedAgent()` 创建分叉代理。

关键的优化：**不设置 `maxOutputTokens`**。分叉代理复用主线程的 prompt cache，
而 `maxOutputTokens` 会影响思考配置的 `budget_tokens`，设置它会破坏缓存匹配，
导致缓存未命中。

当缓存共享失败时（约 2.79% 的 Sonnet 4.6 调用），退回到在消息末尾附加
摘要请求的常规流式路径。

#### 摘要提示词结构

**文件**: `src/services/compact/prompt.ts`

提示词包含一个强力的"无工具"前缀（`NO_TOOLS_PREAMBLE`，第 19 行）：

```text
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- Tool calls will be REJECTED and will waste your only turn.
```

提示词要求模型生成 `<analysis>` 草稿块 + `<summary>` 结构化摘要。
摘要包含 9 个部分：
1. 主要请求和意图
2. 关键技术概念
3. 文件和代码部分
4. 错误和修复
5. 问题解决
6. 所有用户消息
7. 待处理任务
8. 当前工作
9. 可选下一步

`formatCompactSummary()` (第 311 行) 在摘要到达上下文之前剥离 `<analysis>` 草稿块。

#### 图像剥离

在发送给摘要 LLM 之前，`stripImagesFromMessages()` (第 145 行) 将用户消息中的
图像/文档块替换为 `[image]` / `[document]` 文本标记。原因：
- 图像对生成会话摘要不是必需的
- 图像可能导致压缩 API 调用本身命中 `prompt_too_long` 限制
- 在 CCD 会话中用户经常附加图像，这个问题尤为明显

#### Prompt-Too-Long 重试

当摘要请求本身命中 `prompt_too_long`（CC-1180）时，
`truncateHeadForPTLRetry()` (第 243 行) 按 API 轮次组从最早的轮次开始丢弃消息，
直到释放足够的 token 空间。最多重试 `MAX_PTL_RETRIES = 3` 次。

---

## 3. 压缩触发时机

压缩可以在四个不同的时间点触发：

### 3.1 预模型上下文塑造 (每次模型调用前)

**位置**: `src/query.ts` 第 369-467 行
**始终发生**: 预算削减和微压缩**在每次 API 调用前执行**。

这些是低成本的防御性操作，确保发送给 LLM 的上下文尽可能精简。

执行顺序：
```
applyToolResultBudget()     → Layer 1 (无条件)
snipCompactIfNeeded()       → Layer 2 (仅内部构建)
microcompactMessages()      → Layer 3 (无条件)
contextCollapse             → Layer 4 (仅内部构建)
autoCompactIfNeeded()       → Layer 5 (条件触发)
```

### 3.2 反应式压缩 (API 返回 prompt_too_long 时)

**文件**: `src/services/compact/reactiveCompact.ts` (外部构建桩)
**触发**: 当 API 返回 `prompt_too_long` 错误时

即使所有五层都正确执行，理论上仍可能命中 `prompt_too_long`（token 预估不准确）。
反应式压缩是"最后一道防线"——当 API 拒绝请求时触发。

由 `feature('REACTIVE_COMPACT')` 控制。

### 3.3 手动压缩 (/compact 命令)

**文件**: `src/commands/compact/compact.ts`
**触发**: 用户输入 `/compact` 或在 UI 中点击压缩按钮

手动压缩的流程：
1. 首先尝试会话记忆压缩（如果没有自定义指令）
2. 如果启用了反应式模式，通过反应式路径路由
3. 退回到传统完整压缩
4. 可选：传递自定义压缩指令（`/compact 请重点关注测试文件`）

手动压缩始终 `isAutoCompact = false`，这意味着失败时会显示错误通知。

### 3.4 自动压缩 (定期触发)

**触发**: `shouldAutoCompact()` 在每次模型调用前检查

如上所述，通过 token 阈值自动判断是否触发。自动压缩会抑制后续提问
（`suppressFollowUpQuestions: true`），模型摘要后直接继续工作。

---

## 4. 部分压缩 vs 完整压缩

### 4.1 完整压缩 (compactConversation)

**文件**: `src/services/compact/compact.ts:387`
**函数**: `compactConversation(messages, context, cacheSafeParams, suppressFollowUp, customInstructions, isAutoCompact)`

作用于**所有消息**。LLM 对整个对话生成结构化摘要，用摘要替换所有早期消息，
保留最近的附件和状态。

```
       压缩前                         压缩后
  ┌──────────────────┐         ┌──────────────────┐
  │ System Prompt     │         │ System Prompt     │
  │ User: "写一个API"  │         │ User: "写一个API"  │
  │ Assistant: [工具调用]│  ──►  │ Boundary Marker   │
  │ User: [工具结果]   │         │ Summary: "用户要求 │
  │ Assistant: "完成了"│         │ 写API，使用了Read │
  │ User: "再加日志"   │         │ 和Edit..."       │
  │ Assistant: [工具调用]│        │ File Attachments  │
  │ ...               │         │ Skill Attachments │
  └──────────────────┘         │ Hook Results      │
                               └──────────────────┘
```

### 4.2 部分压缩 (partialCompactConversation)

**文件**: `src/services/compact/compact.ts:772`
**函数**: `partialCompactConversation(allMessages, pivotIndex, context, cacheSafeParams, userFeedback, direction)`

作用于**枢轴点附近的消息**。有两种方向：

#### 方向 'from' (前缀保留)

压缩枢轴点**之后**的消息，保留之前的消息。prompt cache 对保留的（早期）消息有效。

```
  ├── 保留 ──┤  ←── 压缩 ──→
  [早期消息] [枢轴] [后续消息]
    保留                摘要
  (cache 命中)
```

#### 方向 'up_to' (后缀保留)

压缩枢轴点**之前**的消息，保留之后的消息。prompt cache 失效（摘要位于保留消息之前）。

```
  ←── 压缩 ──→  ├── 保留 ──┤
  [早期消息] [枢轴] [后续消息]
    摘要          保留
                (cache 失效)
```

#### 哪些消息类型可以被压缩

部分压缩接受完整的消息类型，但 `up_to` 方向会**剥离**旧压缩边界和摘要消息
（第 790-799 行）：

```typescript
const messagesToKeep = direction === 'up_to'
  ? allMessages.slice(pivotIndex).filter(
      m => m.type !== 'progress' &&
        !isCompactBoundaryMessage(m) &&
        !(m.type === 'user' && m.isCompactSummary))
  : allMessages.slice(0, pivotIndex).filter(m => m.type !== 'progress')
```

`progress` 类型消息在两种方向下都被排除（不可记录）。

#### 哪些需要保留

以下内容**不在压缩范围内**，需要在压缩后恢复：

| 内容 | 恢复机制 | 文件 |
|------|----------|------|
| **System Prompt** | 始终作为前缀发送，不受压缩影响 | - |
| **工具定义** | 每次 API 调用由 `normalizeMessagesForAPI()` 注入 | `messages.ts` |
| **CLAUDE.md** | `processSessionStartHooks()` 在 SessionStart 钩子中恢复 | `sessionStart.ts` |
| **已读文件** | `createPostCompactFileAttachments()` 恢复最近 5 个文件 | `compact.ts:1415` |
| **计划文件** | `createPlanAttachmentIfNeeded()` | `compact.ts:1470` |
| **已调用技能** | `createSkillAttachmentIfNeeded()` | `compact.ts:1494` |
| **异步代理状态** | `createAsyncAgentAttachmentsIfNeeded()` | `compact.ts:1568` |
| **延迟工具声明** | `getDeferredToolsDeltaAttachment()` | `attachments.ts` |
| **MCP 指令** | `getMcpInstructionsDeltaAttachment()` | `attachments.ts` |
| **计划模式指令** | `createPlanModeAttachmentIfNeeded()` | `compact.ts:1542` |

#### 文件附件恢复策略

`createPostCompactFileAttachments()` (第 1415 行) 的策略：

1. 从预压缩读文件状态获取最近访问的文件
2. 排除计划文件、所有类型的 `CLAUDE.md` 文件
3. 排除已在保留消息中出现过的读文件结果（`collectReadToolFilePaths()`，第 1610 行）
   - 识别 `FILE_UNCHANGED_STUB` 标记以正确处理去重存根
4. 按时间戳降序排列，取前 `POST_COMPACT_MAX_FILES_TO_RESTORE = 5` 个
5. 使用 `FileReadTool` 重新读取文件获取最新内容（限制: `POST_COMPACT_MAX_TOKENS_PER_FILE = 5,000`）
6. 按 `POST_COMPACT_TOKEN_BUDGET = 50,000` 的预算过滤

技能附件策略（`createSkillAttachmentIfNeeded()`, 第 1494 行）:
- 按调用时间降序排列技能（最近调用优先）
- 每个技能截断到 `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5,000`
- 总预算 `POST_COMPACT_SKILLS_TOKEN_BUDGET = 25,000`（约 5 个技能）
- 截断标记告知模型可通过 Read 获取完整内容

---

## 5. 会话记忆压缩 (Session Memory Compact)

**文件**: `src/services/compact/sessionMemoryCompact.ts`
**函数**: `trySessionMemoryCompaction()` (第 514 行)

### 5.1 动机

会话记忆压缩是自动压缩的第一候选路径，目的**完全避免 LLM 摘要调用**。
它利用已有的会话记忆文件（通过 SessionMemory 服务异步生成的结构化记忆）
直接构建压缩后的上下文。

### 5.2 工作流程

```
trySessionMemoryCompaction()
  │
  ├── 检查特性标识 (tengu_session_memory + tengu_sm_compact)
  │
  ├── 初始化远程配置 (GrowthBook's tengu_sm_compact_config)
  │   默认: minTokens=10,000, minTextBlockMessages=5, maxTokens=40,000
  │
  ├── 等待进行中的会话记忆提取完成
  │
  ├── 获取 lastSummarizedMessageId (上次摘要到的消息)
  │
  ├── 读取会话记忆文件内容
  │
  ├── 计算保留消息的起始索引 (calculateMessagesToKeepIndex)
  │   ├── 从 lastSummarizedMessageId 之后开始
  │   ├── 向后扩展直到满足最小 token 和文本块消息数
  │   └── 调整以确保 tool_use/tool_result 配对不分裂
  │
  ├── 创建 CompactionResult (无 API 调用)
  │   ├── 边界标记
  │   ├── 基于会话记忆的摘要消息
  │   ├── 保留的消息 (messagesToKeep)
  │   └── 计划文件附件
  │
  └── 检查后压缩 token 计数是否低于自动压缩阈值
```

### 5.3 与自动压缩的集成

在 `autoCompact.ts:287-310` 中，会话记忆压缩优先于完整压缩：

```typescript
const sessionMemoryResult = await trySessionMemoryCompaction(
  messages, toolUseContext.agentId, recompactionInfo.autoCompactThreshold,
)
if (sessionMemoryResult) {
  setLastSummarizedMessageId(undefined)
  runPostCompactCleanup(querySource)
  // ...
  return { wasCompacted: true, compactionResult: sessionMemoryResult }
}
```

### 5.4 关键算法: calculateMessagesToKeepIndex

`adjustIndexToPreserveAPIInvariants()` (第 232 行) 确保压缩不会分裂
`tool_use`/`tool_result` 配对：

```
场景: 流式输出产生的不同 message.id 但相同 content.id 的消息

  索引 N:   assistant, message.id=X, content: [thinking]
  索引 N+1: assistant, message.id=X, content: [tool_use: ORPHAN_ID]
  索引 N+2: assistant, message.id=X, content: [tool_use: VALID_ID]
  索引 N+3: user, content: [tool_result: ORPHAN_ID, tool_result: VALID_ID]

如果 startIndex = N+2:
  - N+2 保留但 N 被丢弃 → thinking 块丢失
  - normalizeMessagesForAPI 合并后 → 孤立 tool_result ORPHAN_ID
  - API 错误!

修正: 检测 N+2 与 N 共享 message.id，将起始索引前移到 N
```

同样处理思考块合并问题：如果某条 assistant 消息的 `message.id` 与保留范围内
的消息相同（流式拆分的 thinking 块），则向前扩展以包含所有相关块。

### 5.5 会话记忆压缩 vs memdir 系统

会话记忆压缩与 memdir（记忆目录）系统是**互补关系**：

| 系统 | 作用域 | 生成方式 | 保留内容 |
|------|--------|----------|----------|
| **SessionMemory** | 单个会话 | 异步提取 (每轮自动) | 用户意图、关键决策、代码模式 |
| **memdir** | 跨会话持久知识 | autoDream 定期整理 | 长期记忆、项目知识、用户偏好 |

会话记忆压缩读取的是 `SessionMemory` 服务的输出文件，
而非 memdir 中的长期记忆。

---

## 6. 压缩状态的恢复

### 6.1 压缩边界标记

每次压缩后插入一个 `SystemCompactBoundaryMessage` (创建于 `compact.ts:598-611`）。
这是下游恢复的锚点：

```typescript
const boundaryMarker = createCompactBoundaryMessage(
  isAutoCompact ? 'auto' : 'manual',
  preCompactTokenCount ?? 0,
  messages.at(-1)?.uuid,
)
```

边界标记携带元数据：
- `preCompactDiscoveredTools`: 压缩前发现的延迟工具名称列表
- `preservedSegment` (部分压缩): 保留的 `messagesToKeep` 的头/锚/尾 UUID
  - 用于 `annotateBoundaryWithPreservedSegment()` (第 349 行) 在后压缩加载时
    将保留段重新链接回摘要链

### 6.2 历史导航 (/history) 与压缩的协同

`/history` 命令利用压缩边界标记来导航。
`getMessagesAfterCompactBoundary()` 从最近的边界标记之后加载消息，
跳过已被摘要覆盖的历史部分。这使得用户可以通过边界标记快速跳转到
压缩前的活动工作区。

### 6.3 计划/skill/代理状态的保持

| 状态类型 | 保持方式 | 关键代码 |
|----------|----------|----------|
| **Plan (计划)** | 创建 `plan_file_reference` 附件 | `compact.ts:1470-1486` |
| **Plan Mode** | 创建 `plan_mode` 附件（含 reminderType: 'full'） | `compact.ts:1542-1560` |
| **已调用技能** | 创建 `invoked_skills` 附件（含截断内容） | `compact.ts:1494-1534` |
| **Async Agents** | 创建 `task_status` 附件（含进度/结果） | `compact.ts:1568-1599` |
| **Deferred Tools** | 增量声明当前工具集（diff 模式） | `attachments.ts` |
| **已发现的工具** | 在边界标记中保存名称列表 | `compact.ts:607-611` |

### 6.4 预压缩状态缓存清理

压缩后需要清理多个缓存以反映上下文变化：

```typescript
// postCompactCleanup.ts
context.readFileState.clear()           // 清理读文件状态
context.loadedNestedMemoryPaths?.clear() // 清理内存文件路径缓存
getUserContext.cache.clear?.()           // 清理用户上下文缓存
resetGetMemoryFilesCache('compact')      // 清理记忆文件缓存
clearSystemPromptSections()              // 清理系统提示词节
clearClassifierApprovals()               // 清理分类器审批状态
clearSpeculativeChecks()                 // 清理推测性检查
clearBetaTracingState()                  // 清理追踪状态
clearSessionMessagesCache()              // 清理消息缓存
```

**注意**: 技能内容（`sentSkillNames`）故意不清除——重新注入完整的 `skill_listing`
（约 4K token）纯属浪费。模型仍然有 `SkillTool` 在 schema 中，
`invoked_skills` 附件保留了已使用的技能内容。

---

## 7. Codev 中的具体实现

### 7.1 与官方 Claude Code 的差异

Codev 的压缩实现相比于 Anthropic 官方 Claude Code 有以下主要差异和保留：

#### 保留的核心能力

1. **五层管道完整保留**: 预算削减 → Snip → Micro-compact → Context Collapse → Auto-compact
   的全部结构保持与官方版一致。

2. **缓存共享路径**: `tengu_compact_cache_prefix` 特性通过 forkedAgent 复用主线程
   prompt cache，在外部构建中同样生效。

3. **会话记忆压缩**: 完整的 `trySessionMemoryCompaction` 实现，
   包括 `calculateMessagesToKeepIndex` 和 API 不变性保护。

4. **Cached Microcompact**: 使用 API `cache_edits` 删除旧工具结果的机制完整保留，
   包括状态管理和 pinnedEdits 机制。

#### 差异点

1. **Feature Gate 差异**:
   - `feature('HISTORY_SNIP')` → 外部构建中 Snip 是空操作（`snipCompact.ts` 返回空结果）
   - `feature('CONTEXT_COLLAPSE')` → 外部构建中 Context Collapse 是空操作桩
     （`contextCollapse/index.ts` 全部返回空/默认值）
   - `feature('REACTIVE_COMPACT')` → 外部构建中是占位符桩
     （`reactiveCompact.ts` 导出一个 noop 代理）
   - `feature('CACHED_MICROCOMPACT')` → 外部构建中启用，Cached MC 正常运行
   - `feature('KAIROS')` → 会话记录分段写入，外部构建中禁用
   - `feature('PROACTIVE')` → 自主模式压缩提示词适配，外部构建中禁用

2. **外部构建中的 Cached MC**:
   外部构建使用 `getCachedMCConfig()` 的默认配置（`enabled: false`），
   因此完整 Cached MC 路径在外部构建中默认不激活。
   微压缩退回到时间触发 MC 路径或直接返回未修改的消息。

3. **反应式压缩桩**:
   `reactiveCompact.ts`（第 1-35 行）是完全的生成桩，
   所有命名导出通过 Proxy 代理返回空操作。这是为满足 `bun build` 的
   引用解析要求而存在的占位符。

4. **API 微压缩策略**:
   `apiMicrocompact.ts` 中的 `getAPIContextManagement()` 仅在
   `process.env.USER_TYPE === 'ant'` 时包含工具清除策略。
   外部构建仅包含思考块保留策略。

### 7.2 核心文件引用速查

| 功能 | 文件 | 关键函数/导出 |
|------|------|---------------|
| **预算削减** | `src/utils/toolResultStorage.ts` | `enforceToolResultBudget()` (L769) |
| **剪切** | `src/services/compact/snipCompact.ts` | `snipCompactIfNeeded()` (L25, 桩) |
| **微压缩** | `src/services/compact/microCompact.ts` | `microcompactMessages()` (L253) |
| **缓存微压缩** | `src/services/compact/cachedMicrocompact.ts` | `createCachedMCState()`, `registerToolResult()` |
| **时间触发 MC** | `src/services/compact/timeBasedMCConfig.ts` | `getTimeBasedMCConfig()` (L36) |
| **Cached MC 配置** | `src/services/compact/cachedMCConfig.ts` | `getCachedMCConfig()` (L17) |
| **API MC 策略** | `src/services/compact/apiMicrocompact.ts` | `getAPIContextManagement()` (L64) |
| **上下文折叠** | `src/services/contextCollapse/index.ts` | `applyCollapsesIfNeeded()` (L43, 桩) |
| **自动压缩编排** | `src/services/compact/autoCompact.ts` | `autoCompactIfNeeded()` (L241), `shouldAutoCompact()` (L160) |
| **完整压缩执行** | `src/services/compact/compact.ts` | `compactConversation()` (L387), `partialCompactConversation()` (L772) |
| **摘要提示词** | `src/services/compact/prompt.ts` | `getCompactPrompt()` (L293), `getPartialCompactPrompt()` (L274), `formatCompactSummary()` (L311) |
| **消息分组** | `src/services/compact/grouping.ts` | `groupMessagesByApiRound()` (L22) |
| **后压缩清理** | `src/services/compact/postCompactCleanup.ts` | `runPostCompactCleanup()` (L31) |
| **手动压缩命令** | `src/commands/compact/compact.ts` | `call` (L40) |
| **管道编排** | `src/query.ts` | L369-543: 五层管道的完整编排 |
| **会话记忆压缩** | `src/services/compact/sessionMemoryCompact.ts` | `trySessionMemoryCompaction()` (L514), `calculateMessagesToKeepIndex()` (L324) |

### 7.3 关键常量一览

| 常量 | 值 | 定义位置 |
|------|-----|----------|
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | `compact.ts:122` |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | `compact.ts:123` |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | `compact.ts:124` |
| `POST_COMPACT_MAX_TOKENS_PER_SKILL` | 5,000 | `compact.ts:129` |
| `POST_COMPACT_SKILLS_TOKEN_BUDGET` | 25,000 | `compact.ts:130` |
| `MAX_COMPACT_STREAMING_RETRIES` | 2 | `compact.ts:131` |
| `MAX_PTL_RETRIES` | 3 | `compact.ts:228` |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | `autoCompact.ts:30` |
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | `autoCompact.ts:62` |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | `autoCompact.ts:63` |
| `ERROR_THRESHOLD_BUFFER_TOKENS` | 20,000 | `autoCompact.ts:64` |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | `autoCompact.ts:65` |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | `autoCompact.ts:70` |
| SM 压缩 `minTokens` | 10,000 | `sessionMemoryCompact.ts:58` |
| SM 压缩 `minTextBlockMessages` | 5 | `sessionMemoryCompact.ts:59` |
| SM 压缩 `maxTokens` | 40,000 | `sessionMemoryCompact.ts:60` |
| Cached MC `triggerThreshold` | 12 | `cachedMCConfig.ts:11` |
| Cached MC `keepRecent` | 3 | `cachedMCConfig.ts:12` |
| 时间触发 MC `gapThresholdMinutes` | 60 | `timeBasedMCConfig.ts:32` |

---

## A. 附录：事件遥测

压缩管道在各关键节点发出遥测事件，用于性能监控和调试：

| 事件名称 | 触发时机 | 定义位置 |
|----------|----------|----------|
| `tengu_compact` | 完整压缩完成 | `compact.ts:650` |
| `tengu_compact_failed` | 完整压缩失败 | `compact.ts:470/498/508/1379` |
| `tengu_compact_ptl_retry` | 压缩请求命中 PTL，重试丢弃消息 | `compact.ts:479` |
| `tengu_compact_cache_sharing_success` | 缓存共享路径成功 | `compact.ts:1214` |
| `tengu_compact_cache_sharing_fallback` | 缓存共享失败，退回流式 | `compact.ts:1235/1242` |
| `tengu_compact_streaming_retry` | 流式路径重试 | `compact.ts:1364` |
| `tengu_partial_compact` | 部分压缩完成 | `compact.ts:990` |
| `tengu_partial_compact_failed` | 部分压缩失败 | `compact.ts:880/901` |
| `tengu_auto_compact_succeeded` | 自动压缩成功 | `query.ts:478` |
| `tengu_cached_microcompact` | 缓存微压缩删除工具 | `microCompact.ts:346` |
| `tengu_time_based_microcompact` | 时间触发 MC 清除工具结果 | `microCompact.ts:498` |
| `tengu_sm_compact` | 会话记忆压缩尝试结果 | `sessionMemoryCompact.ts` 内多个事件 |
| `tengu_sm_compact_no_session_memory` | 无会话记忆文件 | `sessionMemoryCompact.ts:534` |
| `tengu_sm_compact_empty_template` | 会话记忆为空（模板文件） | `sessionMemoryCompact.ts:541` |
| `tengu_sm_compact_threshold_exceeded` | 压缩后仍超阈值，回退 | `sessionMemoryCompact.ts:609` |

---

> 文档版本: 基于 Codev `cdb3bdd` 提交分析
> 最后更新: 2026-06-22

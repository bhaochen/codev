# 面试准备指南 — Codev / Claude Code 架构知识体系

> 适用场景: 系统设计面试、技术深挖面试、架构师/高级工程师面试
> 目标: 覆盖 AI CLI 代理的核心设计决策、权衡、以及可以引申到通用分布式系统的知识点

---

## 1. 项目概述 (30-second pitch)

**Codev 是什么?**

Codev 是从 Anthropic Claude Code fork 出来的 AI CLI 代理 (Agentic Coding Assistant)，运行在终端中，核心能力是理解自然语言开发指令并自动执行多步骤编码任务。

**三个核心差异化:**

1. **多 Provider 支持** — 不锁定 Anthropic API，可接入 OpenAI、NVIDIA NIM、opencode、vLLM 等第三方 LLM Provider
2. **VRM 桌面伴侣 (Friend)** — 带 3D 虚拟角色 (VRM 模型)、情感表情、语音对话能力的同进程桌宠系统
3. **语音对话** — 实时语音输入 (WASM VAD) + STT/TTS，支持端到端语音编程交互

**一句话概括:**

> "一个带 3D 桌宠的 AI 编程助手 CLI"

---

## 2. 核心架构问答 (Q&A format)

---

### Q: 解释 Agent Loop (代理主循环) 的工作原理

Agent Loop 是整个系统的核心, 实现在 `src/agent/agent-loop.ts`, 约 88 行核心逻辑, 是一个 async generator。

**5 阶段循环:**

```
[Pre-model Shaping] → [Model Invocation] → [Tool Execution] → [Stop Hooks] → [Continuation Decision]
                                                                                    │
                                                                              ┌─────┘
                                                                              ▼
                                                                        回到 [Pre-model Shaping]
```

1. **Pre-model Shaping** — 处理 Hook, 注入系统提示词, 计算预算, 决定是否触发压缩 (compact)
2. **Model Invocation** — 调用 LLM, 处理 API 错误和重试逻辑
3. **Tool Execution** — 执行 LLM 返回的工具调用, 收集结果
4. **Stop Hooks** — 处理 Stop 状态 (token 耗尽、tool_use、end_turn、max_tokens)
5. **Continuation Decision** — 决定是否继续循环

**关键数字:**

- `queryLoop()` 核心逻辑 ~88 行
- 周边基础设施 (工具注册、权限检查、压缩管道、预算跟踪等) 构成 98.4% 的代码量
- 仅 1.6% 是 AI 决策逻辑 (LLM 调用)

**关键特征:**

- **追加式状态 (Append-only JSONL)** — 所有消息追加到消息列表, 永不修改历史, 保证可恢复性
- **恢复机制 (Resilience)** — `max_output_tokens` 耗尽时自动重试 3 次, token 限额从 8K 自动升级到 64K
- **预算跟踪 (Budget Tracking)** — 每次迭代跟踪输入/输出 token, 超出预算时触发 Reactive Compact

---

### Q: 描述权限系统的 7 种模式和防御纵深

**7 种权限模式 (安全光谱从严格到宽松):**

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `default` | 每次工具调用都询问用户 | 默认/安全模式 |
| `acceptEdits` | 自动批准编辑类工具, 其余询问 | 开发日常 |
| `plan` | 仅允许读操作, 拒绝写操作 | 探索/设计阶段 |
| `auto` | ML 分类器自动决策 | 有经验的开发者 |
| `bypassPermissions` | 完全绕过权限检查 | 调试/开发 |
| `dontAsk` | 静默拒绝所有非白名单工具 | 受限环境 |
| `bubble` | 权限检查冒泡到父进程 | CI/CD 集成 |

**4 层防御纵深:**

```
Layer 1: Pre-filtering (Deny Rules)
  → 在权限系统外先做 deny 规则匹配, 如 `--dangerously-skip-permissions`
    会直接跳过某些工具的白名单检查

Layer 2: Hooks
  → 用户自定义 hook, 在权限检查前后注入逻辑
  → 可实现自定义审批流程 (如通知 Slack)

Layer 3: Rule Evaluation
  → 工具级别的 allow/deny 规则
  → 基于工具名称、参数、文件路径的正则匹配

Layer 4: Permission Handler
  → 最终决策层, 根据 mode 决定是否向用户显示提示
```

**Auto Mode 的 ML 分类器:**

- 两阶段分类: 先判断工具类别 (Read vs Action), 再决定自动批准/询问
- 官方报告的 FNR (假阴性率) 约 17% — 即 17% 本该自动批准的操作被错误地询问用户
- 渐进信任机制: 系统跟踪用户的 auto-approve rate, 从初期 ~20% 增长到熟练用户的 40%+

**核心设计原则:**

- **Deny-first**: 任何未明确允许的操作都被拒绝
- **渐进信任**: 用户必须主动证明可靠性才能获得更多自主权

---

### Q: 上下文压缩的 5 层管道是什么?

上下文窗口有限, 每次消息增长都需要压缩。压缩管道在 `src/agent/compact.ts` 实现。

**5 层压缩管道 (按触发顺序):**

```
Layer 1: Budget Reduction (预算削减)
  → 截断超出预算的历史消息
  → 优先丢弃旧消息, 保留最近的工具调用结果
  → 触发条件: 总 token 超过 budget

Layer 2: Snip (低价值裁剪)
  → 移除低价值消息
  → 判断标准: 工具输出是否为错误/空/重复
  → 保留工具调用本身但删除冗余输出

Layer 3: Micro-compact (微压缩)
  → 对单条消息做摘要
  → 使用 "Condense" 工具让 LLM 对长输出做一句话总结
  → 保留原始消息的语义但大幅缩减 token

Layer 4: Context Collapse (上下文折叠)
  → 折叠多轮交互
  → 将多轮 tool_use + tool_result 对合并为一段摘要
  → 保留最终状态但丢失中间过程

Layer 5: Auto-compact (自动摘要)
  → 完整语义摘要
  → 使用 LLM 对整个对话历史执行摘要
  → 最激进, 丢失信息最多, 但 token 节省最大
```

**核心权衡:**

```
Context Efficiency (节省 token, 降低成本, 减少超预算风险)
    vs
Transparency (丢失细节, LLM 可能遗忘关键上下文)
```

**补充机制:**

- **Reactive Compact**: 当 LLM 回复 `max_tokens` 截断时自动触发压缩重试
- **JSONL 持久化**: 压缩只影响发送给 LLM 的上下文, 原始 JSONL 日志完整保留

---

### Q: 单轨 Native LLM Runtime 如何实现？（Phase 1-12 渐进式正交解耦，P0-P6 为旧编号）

> **1-12 ↔ P0-P6 映射**: `P0`清Client分支=`Phase1 Registry声明`/`P1`内联protocol=`Phase2 Responses拆分`/`P2`最小Route=`Phase4 Route抽象`/`P3`显式auth=`Phase7 Auth Strategy`/`P4` registry=`Phase11 ModelRegistry`/`P5`测试锁死=`Phase5 Transport`/`P6` Facade剿灭=`Phase5-6`直连+free兜底。当前以 `Phase 1-12` 为准，`ProtocolRegistry≡ClientRegistry` (`protocols/index.ts` 唯一源)

Codev 已从"双路由+Fetch Override"收敛为单轨 Native 直连（`src/services/llm/`，`89 tests`）：

```text
Agent → queryModel Facade(src/services/api/queryModel.ts:17) → ModelRuntime.generate(src/services/llm/runtime/ModelRuntime.ts:11)
      → resolveRoute(src/services/llm/router/resolveRoute.ts:14) → LLMRoute{provider,protocol,model,endpoint}(src/services/llm/types.ts:26 + route/Route.ts:27)
      → ProtocolRegistry.getHandler(protocol)(src/services/llm/protocols/index.ts:23) → handler.query → Transport.httpRequest + Framing.parseSSERaw → Adapter → Native fetch
        ↕ ModelResolver canonical               ↕ ModelRegistry has/get
   AuthStrategy bearer/api-key/none(src/services/llm/auth/strategies.ts:10)  ModelRegistry local>models.dev>default(src/services/llm/models/registry.ts:40)
```

**核心设计决策：**

| 决策 | 说明 | 为什么 |
|------|------|--------|
| `LLMRoute` 最小 4 字段 | `{provider,protocol,model,endpoint}` 不含 Auth/Capability/Transport | Auth/Capability 生命周期与路由不同；Route 只表达"一次可执行请求"的最小事实 |
| `Provider ≠ Protocol` | Provider 仅提供 `{endpoint,protocol,model mapping,auth identity}` 元数据，Protocol 为 Provider 静态属性 | 避免"每个 Provider 一套 Client"膨胀；新增 Provider 只增 `providers/<id>.ts` 元数据，不新增 Client |
| `Client = Protocol` | `openai-chat→queryOpenAIChat` 承载 OpenAI/OpenCode/DeepSeek，`anthropic-messages→queryAnthropicMessages` 承载 Anthropic/Bedrock/Vertex/Foundry/NVIDIA | 同一协议语义相同，差异仅在 endpoint/header；`Client` 内无 Provider 分支（P0 已清理），满足开闭原则 |
| `Auth 分离` | `resolveAuth(provider)→Credential{bearer|none}` 独立于 Route，汇合于 Client | 避免 Route 携带敏感 token 扩散；`opencode` 无 key 时 `public` + billing 暗桩，`openai/nvidia` 无 key 时 `none` |
| `ModelRegistry 分离` | `getModelMetadata(model)→{capabilities: tools/vision/reasoning/streaming}` | Capabilities 用于后续限流/重试决策，不进入 Route，避免 Route 膨胀；P4 从 Route 剥离 |
| `queryModel.ts` 稳定 Facade | 薄封装 `modelRuntime.generate()`，旧调用方无感 | P6 `claude.ts` 已彻底剿灭（`ff00aaf`），职责归位 `runtime/router/clients/auth/models`，门面稳定降低迁移成本 |
| `免费模型健壮性` | `model.includes('free'/'contributor')` 或 `models.dev:isFree` 判定 → `tools>8`截断/`system>8000`截断/`500→big-pickle`重试 | `f141d7c` 兜底免费模型瞬态 500，`5f944f0` 已验证原生直连无 `fetch-override fallback` 亦 ok |
| `Tier2 删除` | `13c204e` 移除 `cc-haha` 预设系统，仅 Tier1 TUI `~/.claude.json:authProvider` | 单一事实源，避免双路由语义冲突；默认 `f1aa3bb` 回落 `opencode` |
| `ProtocolRegistry 唯一源` | `protocols/index.ts:23` `ProtocolRegistry{handler}` 4协议 `openai-chat/responses/compatible/anthropic-messages` + `gemini/bedrock` 无 handler→`unsupported` | `Phase8 91b8fc9` 前 `clients/index` 私有 map 与 `protocols` 分裂，`getClientForRoute→getProtocolHandler` 统一 |
| `Provider≠Protocol (defaultProtocol)` | `providers/*:5` `defaultProtocol/defaultEndpoint` + `protocol/endpoint` 别名, `resolveRoute({protocol?,endpoint?})` 覆盖 | `Phase9 d752e69` 前 Provider 独占 Protocol, 现同一 Provider 可 `openai→chat/responses/compatible` 三选 |
| `ModelResolver 独立` | `models/modelResolver.ts:11` `openai→resolveOpenAIModel / opencode→getOpenCodeModelName / others→passthrough` | `Phase10 4225283` 前 `ProviderDef.resolveModel` 独占, 现 `Route` 直调独立 Resolver |
| `Transport/Framing 最小` | `transport/http.ts:7` `httpRequest` + `transport/sse.ts:24` `parseSSERaw` 跨 chunk + `[DONE]` | `Phase5 a939f5a` 抽离后 3 OpenAI 协议共用, `Phase6` 修复 Responses 误用 Chat parser |
| `ModelRegistry 合并` | `models/registry.ts:40` `local {big-pickle,default} > models.dev (provider/model) > default`, `registerModelsDev` Via `fromModelsDev` | `Phase11 c5901ae` 仅本地, `12B df13a0f` 纯函数, `12C b9503eb` 合并, `12D e1fa95a` XDG 24h 缓存 + 后台 `sync` |

**追问：为什么删 Transport 抽象？**
`Phase5` 前曾抽象 `fetch-override/SDK/native HTTP`, 现仅保留最小 `httpRequest + parseSSERaw` (`a939f5a`), `Client=Protocol` 已足以复用；`openaiChat.ts` 不再 `fetch(chatCompletionsUrl)` 直调而经 `Transport`, `nvidia` 已从 `legacy→native` 完成。

**追问：协议转换核心？**
`@ant/model-provider` 统一管线：`convertAnthropicMessagesToOpenAI/Tools`（system→system message, image→image_url, tool_result→tool, tool_use→tool_calls, thinking→reasoning_content）→ `buildOpenAIRequestBody` → `fetch` → `parseOpenAIStream→adaptOpenAIStreamToAnthropic`（delta.content→text_delta, reasoning_content→thinking_delta, tool_calls→tool_use, finish_reason→stop_reason）。

---

### Q: Friend VRM 系统为什么设计为同进程 + SSE?

Friend 是 Codev 的 3D 桌面伴侣系统, 使用 VRM 模型 (3D 虚拟角色), 具备表情、动作、语音对话能力。

**架构选择:**

```
同进程 (In-process)
  └── Agent 直接调用 messageQueueManager.enqueue()
  └── VRM 渲染在独立窗口 (WebKitGTK)
  └── SSE 从 Agent 进程推到 VRM 窗口

vs 微服务 (Microservices)
  └── 需要 IPC/进程间通信
  └── 额外的 HTTP Server 部署
  └── 开发、调试复杂度高
```

**选择同进程的原因:**

1. **不需要 IPC/进程间通信** — 直接调用 `messageQueueManager.enqueue()` 即可推送消息
2. **低延迟** — 同进程调用延迟 <1ms, IPC 至少 1-10ms
3. **简化部署** — 用户只需要启动一个二进制文件
4. **状态共享** — Agent 的上下文、配置、日志直接可访问

**选择 SSE (Server-Sent Events) 而不是 WebSocket 的原因:**

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 通信方向 | Server → Client 单向 | 双向 |
| 协议 | HTTP (简单) | WS (复杂, 需要握手机制) |
| 适用场景 | LLM → VRM 广播 (推送表情/动作指令) | 双向实时通信 |
| 浏览器支持 | EventSource API | WebSocket API |
| 自动重连 | 原生支持 | 需手动实现 |

- **核心原因**: VRM 系统的主要通信模式是 Agent → VRM 的单向推送 (LLM 决定表情 → 推送到 VRM 渲染), 不存在 VRM → Agent 的实时控制需求, 因此 SSE 完全足够, 且比 WebSocket 更轻量

**WASM VAD 的选择:**

- 使用 Silero VAD 的 WASM 编译版本
- 原因: 避免 `onnxruntime-node` 在 Bun 运行时下的 segfault (Bun 的 napi 兼容性问题)
- WASM 运行在 WebView 沙箱中, 更稳定

**服务端采音 (Server-side Audio Capture):**

- 不依赖浏览器 `getUserMedia` API
- 避免 WebKitGTK 的权限弹窗问题
- 使用 PulseAudio/ALSA 直接在服务端录制麦克风

---

### Q: Feature Flag 系统如何实现死代码消除?

Codev 使用编译时 Feature Flag 系统, 实现 `#ifdef` 风格的死代码消除。

**实现位置:** `src/feature/feature.ts` / `feature()` 函数

**工作原理:**

```
编译时: Bun build --define 注入常量值

if (feature("VOICE_MODE")) {
    // 注册语音工具
    registerVoiceTools();
} else {
    // 这段代码在编译时被消除
    // 不产生任何字节码
}
```

**Bun 编译器的支持:**

- Bun 的 `feature()` 函数在编译时做 if/ternary 位置的静态分析
- 当 feature 为 false 时, 整个分支被 DCE (Dead Code Elimination)
- 最终二进制中完全不包含被禁用的功能代码

**编译标志:**

- 命令行: `--feature=VOICE_MODE` (编译时启用)
- 环境变量: `FEATURE_VOICE_MODE=1` (开发时启用)
- 两者效果等价

**Feature 统计:**

- 总共 48 个实验性 feature
- 默认仅 `VOICE_MODE` 启用
- 其他 feature 如: `ANTHROPIC_BRAZIL`, `BYPASS_PERMISSIONS`, `ORGANIZATION_CODE`, `TOOLTIP` 等

**用户类型门控:**

- `USER_TYPE='ant'` → Anthropic 内部员工, 解锁内部工具和功能
- `USER_TYPE='external'` → 外部用户, 仅暴露稳定的公共功能
- 在编译时通过 `feature()` 检查, 用户类型相关的内部代码完全不会出现在外部构建中

---

### Q: 投机工具执行（Speculative Execution）是怎么工作的?

灵感来自 CPU 分支预测：把"模型生成 tool 参数"与"工具执行"两段串行阶段重叠。
实现分两层（spec-ptc 项目移植）：

**Layer 1 — SpecStore 缓存回放**（`src/services/tools/speculation.ts`）

- `SpecKey = (toolName, sha256(args)[0..16])` 唯一标识一次调用
- 工具完成后结果入 FIFO store；后续相同参数的调用在 `addTool()` 时
  `claim()` 直接领走缓存，跳过执行
- 多重度安全：同 key N 次调用 → N 个队列条目，每个只能被 claim 一次
- 预算封顶：`maxInflight=5`、`maxDispatchesPerTurn=20`（BudgetTracker）

**Layer 2 — 流式投机 dispatch**（`StreamingSpecDispatcher.ts`）

- LLM 以 `input_json_delta` 分片流出 tool input；
  用增量 brace-depth 扫描（字符串/转义感知）检测 JSON 何时闭合
- JSON 完整即异步投机执行，等真正 `content_block_stop` 到达时
  `claim()` 命中 → 0ms yield
- 只对 `speculatable && pure` 的工具启用（Read/Grep/Glob）—
  **pure 是硬门槛**：投机调用可能永远不被正式使用，有副作用的工具会出事故

**核心权衡:**

```
延迟收益（省掉等待+重复执行） vs 浪费算力（押注失败的投机）
正确性永不受损：claim miss 只是回退正常路径，最坏情况多花预算内的一次执行
```

**追问: 为什么用 FIFO 队列而不是 Map<key, result>?**
多重度语义。两次相同 Read 各自消耗一个条目，避免共享同一结果的竞态。

---

### Q: REPL 沙箱是如何设计的?（P6.6 契约：ToolResult + ContextAggregator + isVirtual）

REPL Tool 让模型在 Bun `node:vm` 沙箱里写 JS，通过 `await callTool("Grep", {...})`
批量调用 primitive tools（详见 [repl-tool 文档](tools/repl-tool.md)，`src/tools/REPLTool/engine.ts:35`）。

**三层沙箱防御:**

```
1. 白名单 context 注入   — 只绑定 JSON/Math/Promise 等 30+ 安全全局，
                             未列出的（process/require）根本不存在
2. Proxy get 拦截        — eval/Function/import/globalThis 显式抛 ReferenceError
3. codeGeneration 关闭    — strings:false 禁 new Function 动态编译, wasm:false
```

**Bun node:vm 的坑（实战细节加分项）:**

async IIFE 包装内的 `var` 声明不会持久化到 vm context（函数作用域问题），
但 REPL 的核心诉求恰恰是跨调用变量持久化。解法是双路径执行：

- 检测无 top-level await → 同步直接执行，var 自然持久化
- 有 top-level await → async 包装 + 正则提取 var 名手动注入 context

**3 层契约（a1325f2，面试必答）:**

```
Tool → ToolResult{tool,ok,isError,exitCode,stdout/stderr,data,truncated,outputPath,noOutputExpected}
     → ExecutionStore(innerMessages isVirtual:true → UI/history, normalizeMessagesForAPI 过滤不进 LLM)
     → ContextAggregator.buildContextResult() → ContextResult{ok,tool_calls,calls:[{tool,ok,preview,summary,truncated,outputPath}],logs} JSON → LLM
```

- `ToolResult` 为统一事实模型（Bash 的 `stdout/stderr/exitCode/persistedOutputPath` 与 Read/Glob 的 `data` 同一结构）
- `isVirtual` 的 `assistant(tool_use)+user(tool_result)` 仅 UI/history/audit/collapse 可见，真正进 LLM 的只有 `ContextResult`
- `ContextAggregator`：Bash 合并 `stdout+stderr` 4000 截断（`head2000+tail500`），`mkdir` 标 `summary="no output expected"`；Read 取 `JSON.stringify(data)` `head2000+tail500`、`truncated=true`，超大走 `outputPath` 按需二次 `Read`；`console.log` 降为可选 `logs` 字段
- 不变量：`callTool成功→ToolResult必捕获→ContextAggregator决定暴露`，与是否 `console.log` 无关；`toolCalls==0` 的纯 JS 仍保持 `output||"(no output)"` 兼容 `1+1`

**REPL ≠ SubAgent:**
一句话：REPL 是主 Agent 的批量工具执行器（`主 Agent→REPL{Read,Grep,Bash}→ContextResult→主 Agent`，无二次 LLM）；SubAgent（`AgentTool/task`）是独立会话另起 LLM。普通批量走 REPL，需独立推理再走 SubAgent。

**为什么不用 worker/子进程隔离?**
callTool 需要直接访问 ToolUseContext 与已注册的工具对象；跨进程要序列化
一切且丢失同步 timeout 能力。node:vm 是"防呆"级而非安全边界级 — 真正的
防线是 primitive 工具白名单 + 外层权限系统仍管控 REPL 整体。

**与投机执行的联动:**
REPL 天然减少投机需求（一段代码内 N 次 callTool 无需等模型逐个生成）；
同时它是 Layer 3 Shadow Execution 的目标宿主 — 流式输出代码时在语句边界
fork 影子 VM 提前执行。

---

### Q: 错误恢复策略有哪些?

一个多层级、渐进式的错误恢复系统:

```
1. max_output_tokens 恢复
   └── LLM 输出被截断 (max_tokens 耗尽)
   └── 自动升级 token 限额: 8K → 16K → 32K → 64K
   └── 最多重试 3 次, 之后不再尝试

2. 流式回退 (Streaming Fallback)
   └── SSE 流式连接中断
   └── 自动回退到非流式 (non-streaming) 模式
   └── 用户感知: 延迟增加但可用

3. Reactive Compact (响应式压缩)
   └── LLM 回复被 max_tokens 截断
   └── 触发自动压缩管道, 压缩上下文
   └── 然后重试请求

4. 工具执行重试
   └── 工具调用失败 (网络错误、文件权限等)
   └── 最多重试 3 次
   └── 指数退避 (100ms, 200ms, 400ms)

5. API Fallback Provider
   └── 当前 Provider 不可用 (429/5xx)
   └── 自动切换到下一个配置的 Provider
   └── 配置在 environment.json 中
```

**核心原则:** 3 次重试后不再尝试 — 避免无限重试的资源浪费和用户等待。

---

## 3. 系统设计面试题

---

### 设计一个 AI 编程助手的权限系统

**需求分析:**

- AI Agent 可以执行文件读写、命令执行、网络请求等敏感操作
- 用户需要控制 Agent 的能力范围
- 不同用户有不同的风险和信任水平
- 需要有审计和回溯能力

**方案设计 (参考 Codev):**

```
权限光谱: default → acceptEdits → plan → auto → bypassPermissions → dontAsk → bubble

防御纵深:
  Layer 1: Deny Rules (静态规则)
    └── 基于文件名/路径/工具名的正则匹配
    └── 如: 拒绝所有 /etc/shadow 的读写

  Layer 2: Permission Hooks (自定义逻辑)
    └── 用户可注入 $HOME/.claude/settings.json 中的钩子
    └── 如: 检查 git status 后才允许 git commit

  Layer 3: Mode-based Decision (模式决策)
    └── 根据当前 mode 决定审批流程
    └── auto mode 走 ML 分类器, default mode 询问用户

  Layer 4: ML Classifier (自动分类)
    └── 两阶段: Read vs Action
    └── 特征: 工具名、参数路径、文件类型、操作频率
    └── 输出: allow / ask / deny

  Layer 5: Execution Sandbox (执行沙箱)
    └── 工具执行在受限环境
    └── 不允许绕过操作系统权限
```

**面试讨论要点:**

1. **17% FNR 意味着什么?** 每 6 个操作就有 1 个被错误询问用户, 累积使用会造成显著的摩擦。改进方向: 用户反馈闭环、个性化模型微调、规则叠加 ML 的混合系统。

2. **安全 vs 体验的平衡:** 太严格的权限系统用户会绕过 (直接终端操作), 太宽松的系统有安全风险。渐进信任是核心思路。

3. **审计与追溯:** 所有权限决策写 JSONL 日志, 支持后续分析。

---

### 设计一个实时语音聊天系统 (类似 Friend F2)

**需求分析:**

- 用户通过语音与 AI Agent 对话
- AI 回复也通过语音播放
- 需要低延迟 (实时感)
- 3D 虚拟角色根据对话内容做表情和动作

**架构选择: 同进程 vs 微服务**

```
方案 A: 同进程 (Codev 的选择)
  ┌─────────────────────────────┐
  │  Agent Process              │
  │  ┌──────┐  ┌──────────────┐ │
  │  │ LLM  │  │ Audio Engine │ │
  │  │ Call │→│ STT → VAD    │ │
  │  └──────┘  │ TTS → Mixer │ │
  │            └──────────────┘ │
  │  ┌────────────────────────┐ │
  │  │ VRM (3D Avatar)       │ │
  │  │ SSE ← Emotion Queue   │ │
  │  └────────────────────────┘ │
  └─────────────────────────────┘

方案 B: 微服务
  ┌─────────┐   ┌─────────┐   ┌─────────┐
  │  Agent  │──▶│  Audio  │──▶│   VRM   │
  │ Service │   │ Service │   │ Service │
  └─────────┘   └─────────┘   └─────────┘
```

**VAD (Voice Activity Detection) 策略:**

- **Silero ML VAD** (WASM): 深度学习模型, 准确率高, 能区分人声和环境噪音
- **Energy-based VAD** (备选): 基于音量的简单检测, 适合信噪比高的环境
- **回声消除**: 播放 AI 回复时关闭 VAD/采音, 避免识别到 AI 自己的声音

**静音策略:**

- AI 处理期间: 全程阻断采音 (Press-to-mute)
- 用户说完后: VAD 检测到静音 → 触发 LLM 调用
- LLM 回复时: 音频输出独占, 不接收新输入

**Provider 切换:**

- STT: Whisper (本地) / Azure Speech / Google STT
- TTS: Piper TTS (本地) / ElevenLabs / Azure TTS
- 可热切换, 无需重启 Agent

**面试追问:**

1. **为什么不用 WebSocket 而是 SSE?** — 因为 VRM 的主要通信是单向推送 (Agent → Avatar), SSE 更轻量, 原生支持自动重连。WebSocket 的额外开销 (握手机制、帧协议) 在单向场景下是过度设计。

2. **为什么不用 onnxruntime-node?** — Bun 运行时对 napi 的兼容性问题, 导致 segfault。WASM 在 WebView 沙箱中运行更稳定。

---

### 设计多 Provider LLM 代理（单轨 Native，P0-P6 后）

**需求分析:**

- 支持多种 LLM Provider (Anthropic, OpenAI, NVIDIA, opencode, vLLM)
- 统一的接口, 对用户透明
- Provider 切换不影响 Agent 状态
- 优雅降级 (Provider 不可用时自动切换)

**方案对比:**

```
方案 A: 单轨 Native Client=Protocol（Codev P6 选型）
  优点:
    - Route 最小 4 字段，Provider 元数据与 Protocol 解耦，新增 Provider 只增 providers/<id>.ts
    - Client 按协议共享，OpenAI/OpenCode/DeepSeek 同一 Client，无分支，易测试
    - Auth/ModelRegistry 分离，职责清晰，free 模型 500→big-pickle 可在 Client 层统一兜底
    - 无 SDK/fetch-override 双路径心智负担，直连可观测
  缺点:
    - 需自维护流式适配（adaptOpenAIStreamToAnthropic）

方案 B: Fetch Override（已退化为 legacy）
  优点: 无侵入 SDK
  缺点: 依赖 fetch 钩子，x-anthropic-billing-header 版本漂移易致 500，调试链长

方案 C: Proxy 模式（服务端 server/proxy/handler.ts 备用）
  优点: 可加缓存/限流/日志
  缺点: 额外跳数，延迟+部署成本
```

**协议转换 (Anthropic ↔ OpenAI，@ant/model-provider 统一管线):**

```
Anthropic Messages → OpenAI Chat Completions
  system:          → role:system 消息
  messages:        → messages（image→image_url, tool_result→tool, tool_use→tool_calls, thinking→reasoning_content）
  tools:           → {type:'function', function:{name,description,parameters}}
  max_tokens:      → max_tokens（DeepSeek 需省略，见 provider-auth.md 10.2）
  stop_sequences:  → stop

OpenAI → Anthropic 逆映射：adaptOpenAIStreamToAnthropic 处理 SSE 事件对照（含 thinking_delta/tool_use_delta/message_delta）
```

**模型列表管理:**

- `src/services/llm/models/registry.ts:16 getModelMetadata()` + `src/utils/model/providers.ts:getAPIProvider()` 单一事实源
- `opencode` 动态 `models.dev/api.json` → `cachedModels` + `isFree` 判定，`openai/nvidia/local` 各自 `/v1/models` 拉取
- Provider 切换需 `clearModelStrings()`（旧）/ `resolveRoute` 重新解析（新）

**面试追问:**

1. **为什么 Route 仅 4 字段？** — Auth/Capability 生命周期与路由不同，Transport 是 Client 内部实现；Route 只表达"一次可执行请求"的最小完备事实，避免敏感 token 随 Route 扩散。

2. **为什么 Client=Protocol 而非 Client=Provider？** — 同一协议语义相同，差异仅 endpoint/header；按协议收敛符合开闭原则，P0 清理 Client 内 Provider 分支后新增 Provider 零 Client 改动。

3. **免费模型 500 如何兜底？** — `src/services/llm/clients/openaiChat.ts:169` 检测 `isFree && status===500` 自动 `fallback to big-pickle` 重试，另截断 `tools>8`/`system>8000` 降低触发率。

---

## 4. 架构权衡 (Trade-offs)

---

### Safety vs. Autonomy (安全 vs 自主性)

```
安全优先                   自主性优先
  │                          │
  │                          │
  └── default ─ auto ─ bypassPermissions ──┐
                                           │
  更多权限提示              更少摩擦, 更多风险
  更安全                    更高效
```

- **37signals 二分法**: 权限提示是摩擦, 但也是安全护栏
- **Codev 的答案**: 渐进信任 + 4 层防御 + ML 辅助
- **面试价值**: 展示对安全架构和 UX 权衡的深度理解

---

### Context Efficiency vs. Transparency (上下文效率 vs 透明度)

```
节省 token, 降低成本           保留完整上下文
  │                              │
  │                              │
  └── budget reduction ─ auto-compact ──┐
                                       │
  更便宜的调用                  LLM "记住" 更多细节
  更快响应                     更高质量的推理
  但可能丢失关键信息           但 token 成本更高
```

- **Codev 的答案**: 5 层压缩管道 + JSONL 持久化 + Append-only 日志
- **关键洞察**: 压缩丢弃的是"发送给 LLM 的内容", 不是"系统记录的内容"
- **面试价值**: 展示对 LLM 上下文窗口限制的实际工程理解

---

### Simplicity vs. Extensibility (简单性 vs 可扩展性)

```
Agent Loop 简单 (~88 行)    扩展机制丰富
  │                              │
  │                              │
  └── MCP ─ Plugin ─ Skill ─ Hook ──┐
                                    │
  核心逻辑易于理解             4 种不同的扩展点
  但扩展需要理解多套机制       灵活但复杂度分散
```

- **4 种扩展机制:**
  1. **MCP** (Model Context Protocol): 外部工具和资源, 标准化协议
  2. **Plugin**: 内部插件系统, 可注册新工具和事件监听
  3. **Skill**: 可组合的预定义工作流 (如 `/review-pr`, `/commit`)
  4. **Hook**: settings.json 配置, 在事件前后注入用户定义逻辑

- **面试价值**: 展示对"保持核心简单, 外围可扩展"架构哲学的理解

---

### 同进程 vs 微服务 (Friend 系统的选择)

```
同进程                          微服务
  │                              │
  │                              │
  └── 低延迟 ─ 简单部署 ─ 状态共享 ──┐
                                    │
  适合单用户桌面应用           适合多租户/云端
  不需要分布式能力             但部署复杂
  开发效率高                   但调试困难
```

- **Codev 的答案**: 同进程, 因为这是一个单用户终端工具, 不是分布式系统
- **何时应该选微服务?** 多用户 Web 服务、需要独立扩缩容、团队分工明确
- **面试价值**: 展示架构选型不是技术炫耀, 而是根据实际场景做合理决策

---

## 5. 关键数据

| 指标 | 数值 | 说明 |
|------|------|------|
| 代码量 | ~512K 行 TypeScript | 比 Claude Code 原始 fork 增加约 30% |
| 文件数 | ~1,900 | 模块化程度高 |
| 测试 | 55 文件, ~22K 行 | 覆盖率低, 无 CI/CD |
| 构建产物 | 192-202MB 编译二进制 | 包含 Bun runtime + JS bundle |
| JS Bundle | ~20MB | 除去 Bun runtime 后的纯 JS |
| Feature Flags | 48 个实验性 feature | 默认仅 VOICE_MODE 启用 |
| 权限模式 | 7 种 | default → bubble |
| 压缩管道 | 5 层 | Budget Reduction → Auto-compact |
| 扩展机制 | 4 种 | MCP / Plugin / Skill / Hook |
| AI 工具 | ~60+ | 文件操作、Shell 执行、搜索等 |
| Slash 命令 | ~75+ | /commit, /review-pr, /clear 等 |
| OpenTelemetry | ~5K 行基础设施 | OSS 构建中全部 stub |
| VAD 模型 | WASM Silero VAD | 在 WebView 沙箱中运行 |
| 3D 渲染 | WebKitGTK + Three.js | VRM 模型渲染 |

---

## 6. 常见面试追问

### "为什么不直接用 Vector DB 做记忆?"

**答案:** Memdir 文件系统优先, LLM 选择检索。

- Vector DB 引入额外的运维复杂度 (需要部署、索引、备份)
- 文件系统 (Memdir) 更简单、可审计、可编辑
- LLM 自己决定检索什么: 不是系统自动做 RAG, 而是通过 `Read` 工具让 LLM 按需读取 memdir 文件
- 适用场景: 单用户桌面工具, 不需要多租户的向量检索

### "为什么 Agent Loop 这么短?"

**答案:** 确定性基础设施在周围, 不是在里面。

- 88 行核心循环只做"编排" (orchestration), 不做"实现"
- 工具注册、权限检查、压缩、预算跟踪等逻辑被拆到各自的模块
- 这是**策略模式 (Strategy Pattern)** 的体现: 主循环是稳定的骨架, 各个阶段的行为通过依赖注入可配置

### "SSE 和 WebSocket 怎么选?"

**答案:** 看通信方向。

| 场景 | 推荐 | 原因 |
|------|------|------|
| Server → Client 单向推送 | SSE | 更轻量, 原生重连, HTTP 友好 |
| 双向实时通信 | WebSocket | 全双工, 低延迟 |
| 浏览器 → Server 流式上传 | WebSocket | SSE 只支持下行 |

Friend VRM 的场景是 Agent → Avatar 的单向广播, SSE 是最优解。如果未来需要 Avatar → Agent 的控制 (如用户点击 VRM 触发动作), 那才需要 WebSocket。

### "为什么不用 onnxruntime-node?"

**答案:** Bun 的 napi 兼容性问题。

- `onnxruntime-node` 依赖 Node.js 的 napi (Native API), Bun 的实现在某些版本存在 segfault
- WASM 版本在 WebView 沙箱中运行, 稳定性更好
- 这不是架构决策, 是运行时兼容性的务实现实

### "Compaction 丢失信息怎么办?"

**答案:** JSONL 持久化, append-only 日志。

- 压缩只影响"发送给 LLM 的上下文", 不影响"系统记录的数据"
- 所有原始消息追加到 JSONL 文件, 永不删除
- 如果 LLM 需要回看被压缩的内容, 可以通过 `Read` 工具读取 JSONL 日志
- 这也是为什么压缩管道有 5 层: 渐进式压缩, 先丢最不重要的, 最后才做语义摘要

### "如何测试一个 AI Agent 系统?"

**答案:** 测试 AI Agent 的挑战和策略。

- **黄金数据集**: 录制真实的 Agent 交互 (JSONL), 用作回归测试
- **Tool 模拟**: Mock 工具执行结果, 测试 LLM 的决策逻辑
- **快照测试**: 对比压缩/权限决策的输出快照
- **E2E 测试**: 实际调用 LLM (成本高, 运行慢), 只在关键路径使用
- **当前状态**: 55 个测试文件, ~22K 行, 但无 CI/CD — 这是需要改进的地方

### "这个系统的最大弱点是什么?"

**诚实回答 (面试加分项):**

1. **测试覆盖不足** — 无 CI/CD, 55 个测试文件对 ~512K 行代码几乎不可靠
2. **Monorepo 膨胀** — ~1,900 文件, 构建产物 200MB, 模块边界模糊
3. **ML 分类器的 17% FNR** — 虽然可以接受, 但累积使用会造成显著摩擦
4. **同进程限制扩展** — Friend 系统无法独立部署, 难以支持多实例
5. **依赖 Bun 生态** — Bun 的稳定性影响整个系统 (napi 问题, undici fetch 兼容性等)

---

## 附录: 面试应答策略

### 当被问到不熟悉的问题时

- "这个问题我没有直接经验, 但基于我对系统的理解, 我会这样分析..."
- **STAR 法则**: Situation → Task → Action → Result
- 始终展示**架构思维**: 不管多小的功能, 都能讨论 trade-off

### 描述项目的三种粒度

```
30 秒: "一个带 3D 桌宠的 AI 编程助手 CLI"
 2 分钟: "Codev 是从 Claude Code fork 的 AI CLI 代理,
          核心增强是多 Provider 支持和 VRM 桌面伴侣,
          采用同进程 + SSE 架构实现低延迟语音对话"
10 分钟: 深入 Agent Loop、权限系统、压缩管道、Friend 架构
```

### 把 Codev 经验映射到通用系统设计

| Codev 概念 | 通用系统设计概念 |
|------------------|-------------------|
| Agent Loop | Event-driven orchestration |
| 4 层防御纵深 | Defense in depth |
| 5 层压缩管道 | Multi-stage data processing pipeline |
| Append-only JSONL | Event sourcing / Write-ahead log |
| Feature Flag 死代码消除 | Compile-time configuration |
| Fetch Override | API Gateway / Proxy pattern |
| Provider 切换 | Circuit breaker / Fallback |
| 渐进信任 | Zero-trust architecture (gradual) |
| 同进程 Friend | Embedded system / Co-located deployment |
| SSE 推送 | Publisher-Subscriber pattern (one-way) |

---

## 7. LLM Runtime 单轨 Native 深度问答（新增）

### Q: Route 为什么最小 4 字段？

`LLMRoute {provider,protocol,model,endpoint}`（`src/services/llm/types.ts:22`）不含 `Auth/Capability/Transport`。Route 只需表达"一次可执行请求"的最小完备事实：Who/Who's model/How to speak/Where to send；Auth 是"凭什么访问"（`resolveAuth→Credential`），Capability 是"模型能做什么"（`ModelRegistry→ModelMetadata`），Transport 是 Client 内部实现细节。分离避免敏感 token 随 Route 扩散、避免模型能力变更污染路由缓存、降低心智负担。P2 固定最小 Route。

### Q: Provider ≠ Protocol 的含义？

Provider 是"身份+元数据"（`src/services/llm/providers/opencode.ts:14`：`endpoint/protocol/model mapping/auth identity/isFreeModel`），Protocol 是"怎么说话"（`openai-chat` vs `anthropic-messages`）。同一 Protocol 可承载多 Provider（`openai-chat` 承载 OpenAI/OpenCode/DeepSeek），故 `Client=Protocol` 最大化复用；新增 Provider 只需增 `providers/<id>.ts`，不新增 Client。

### Q: openai/opencode 为什么走原生 OpenAI Chat 直连而不用 shim？

`8cad9df` 前曾用 `Anthropic→OpenAI` shim 经 `Anthropic SDK` 的 `fetch-override`，但 `x-anthropic-billing-header` 版本漂移与 `effort/beta` 透传易致免费模型 `500`；`muse-spark` 等非 Claude 模型的 `tool_choice:auto` 亦需直连语义。`P6` 后 `ModelRuntime→openaiChat.ts` 直接 `POST /v1/chat/completions` → `adaptOpenAIStreamToAnthropic`，规避 shim 漂移，`5f944f0` 后原生直连已验证 ok 可删 fallback。

### Q: Tier2 为什么删除？

`cc-haha` Tier2 预设系统引入第二套 Provider 配置与路由，与单轨 `LLMRoute` 语义冲突、增加分发与权限心智负担；`13c204e` 后仅保留 Tier1 TUI（`~/.claude.json:authProvider`，`src/utils/model/providers.ts`），单一事实源，默认 `f1aa3bb` 回落 `opencode`，满足单用户桌面 CLI 场景。

### Q: 免费模型 500 与上下文截断如何处理？

`src/services/llm/clients/openaiChat.ts:102` 按 `model.includes('free'/'contributor')` 或 `getCachedOpencodeModels().isFree` 判定；`tools.length>8` 截至 8、`system>8000` 截断并注 `...[truncated for free model]`；无有效 key 时注入 `x-anthropic-billing-header` 暗桩；瞬态 `500` 时 `f141d7c` 自动 `fallback to big-pickle` 重试，确保 `hi` 可用。

---

## 8. REPL 批量引擎深度问答（新增）

### Q: 3 层契约是什么？为什么 `isVirtual` 不进 LLM？

`Tool→ToolResult(统一事实)→ExecutionStore(innerMessages isVirtual)→ContextAggregator→ContextResult(JSON)→LLM`。`isVirtual` 的 `assistant(tool_use)+user(tool_result)` 在 `src/utils/messages.ts:1999 normalizeMessagesForAPI` 被过滤，仅 UI/history/collapse/audit 可见；若直接把 innerMessages 进 LLM，会与外层 `tool_result` 配对校验冲突且无法控制 token。`ContextResult` 的 `preview/summary/truncated/outputPath` 才是受控的进 LLM 载体。

### Q: 为什么需要 ContextAggregator？

旧 `engine.ts:131 output||"(no output)"` 使 `gh auth status` 空 stdout 成功被判无输出、`Read` 全量又致上下文臃肿。Aggregator 将 `ToolResult` 转 `ContextCall`：Bash 合并 `stdout+stderr` 4000 截断、`noOutputExpected` 标 `summary`；Read 取 `JSON.stringify(data)` `head2000+tail500`、`truncated` 标记；超大走 `outputPath` 按需二次 `Read`。不变量 `callTool成功必捕获→Aggregator决定暴露`，与 `console.log` 无关。

### Q: REPL 与 SubAgent 选型边界？

REPL 是主 Agent 的批量工具执行器，无二次 LLM，适合 `Read/Grep/Glob/Bash/Edit` 批量；SubAgent（`AgentTool/task`）是另起 LLM 会话的独立推理单元，适合探索/并行/需隔离的任务。面试答法：先 REPL 批量、需独立思考再 SubAgent。

---

> 最后更新: 2026-09-02
> 基于 Codev P6-final `ff00aaf/5f944f0/f141d7c` 单轨 Native LLM Runtime + REPL 3 层契约 + Tier2 已删

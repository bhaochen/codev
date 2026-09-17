# ADR: Agent Message as the Canonical Semantic Representation

**状态**: Phase 1 Complete
**日期**: 2026-09-16
**关联**: [System Prompt 组装逻辑](system-prompt-assembly.md)

**核心原则**: Agent Core MUST NOT depend on any provider-specific message format.

**关键约束**: Provider-specific semantics MUST be preserved through explicit adapter/metadata escape hatches rather than leaking into AgentMessage.

---

## 背景

Codev 当前的 LLM 消息处理采用 **Anthropic 原生格式**作为内部表示。所有 LLM 协议客户端（OpenAI Chat、OpenAI Responses、OpenAI Compatible Chat）都需要从 Anthropic 格式**双向转换**：

```text
Agent Core
    ↓
Anthropic Message (内部存储)
    ↓
normalizeMessagesForAPI() → convertAnthropicMessagesToOpenAI()
    ↓
OpenAI API

OpenAI Stream → adaptOpenAIStreamToAnthropic()
    ↓
Anthropic Stream (内部处理)
```

---

## 问题

### 1. Agent 语义被 Anthropic API 绑死

Anthropic 的 tool_use 格式：

```ts
{
  role: "assistant",
  content: [{
    type: "tool_use",
    id: "...",
    name: "bash",
    input: {}
  }]
}
```

OpenAI 的 tool_calls 格式：

```ts
{
  role: "assistant",
  tool_calls: [{
    id: "...",
    type: "function",
    function: {
      name: "bash",
      arguments: "{}"
    }
  }]
}
```

Gemini 又是完全不同的结构。

**当 Core 直接存储 Anthropic 格式时**，Agent 的内部语义实际上等于 Anthropic API 的语义。

### 2. `normalizeMessagesForAPI` 逐渐膨胀

当前的转换逻辑已包含：

- 图像降级（对不支持图像的模型用占位符替换）
- tool call ID 标准化（OpenAI Responses API 生成的 ID 可能 450+ 字符）
- thinking blocks 处理
- virtual messages 过滤
- 附件重排
- 错误消息剥离

每新增一种协议（Responses、Gemini、Bedrock），就需要增加新的转换分支，最终成为"大转换器"。

### 3. OpenAI Responses API 的已知限制

```typescript
// src/services/llm/protocols/openaiResponses.ts:58
// Only text generation is guaranteed; tool/reasoning events are safely ignored.
```

某些高级功能（tool events、reasoning events）在转换过程中被丢弃。

---

## 对比分析

### 三种方案

| 方案 | 优点 | 缺点 | 适合场景 |
|------|------|------|----------|
| **Codev 当前: Anthropic 原生格式** | 实现简单，Anthropic 兼容性最好 | 内部模型被 Anthropic API 污染；OpenAI/Gemini 要来回转换 | 单一 Anthropic 生态 |
| **Pi: 自定义通用格式** | Agent Core 与 Provider 解耦；tool/image/reasoning 都能统一表达 | 类型体系需要自己维护；边界转换逻辑较多 | 通用 Agent Runtime |
| **OpenCode: 强类型 Schema + ModelMessage** | 类型安全、验证强、Provider 扩展清晰 | 架构较重；理解和维护成本更高 | 大型、多 Provider 产品 |

### 结论

**Pi 的思想最好作为 Codev 的核心方向：内部使用与 Provider 无关的统一消息格式。**

同时吸收 OpenCode 的强类型验证思想。

**但注意关键误区**: Pi 并不是只有一层 Message。准确地说，Pi 是 `pi-agent-core`（用 AgentMessage 描述 Agent 语义）与 `pi-ai`（用通用 Message 描述 LLM 边界）分层，中间通过 `convertToLlm()` 转换。**Pi 真正值得借鉴的，是 Agent Core 不直接绑定 provider API，并且在 LLM boundary 做转换**——而不是简单的"自定义 Message → API"。

---

## 推荐架构

**最重要的不是"换消息格式"，而是把这个边界真正建立起来。**

```text
❌ 当前

Agent
  ↓
Anthropic Message
  ↓
normalizeMessagesForAPI()
  ↓
各种 API

✅ 目标

Agent Core
  ↓
AgentMessage
  ↓
LLM Boundary
  ↓
Provider / Protocol Adapter
  ↓
API
```

Agent Core 以后增加 OpenAI Responses、Gemini、Bedrock、未来新的 API，**Agent Core 都不需要知道它们的存在**。

---

### 目标架构

```text
                    Codev Agent Core
                         │
                         ▼
                  AgentMessage
              (Agent 语义表示层)
              ┌──────────┼──────────┐
              │          │          │
            user      assistant    tool
              │          │          │
              └──────────┼──────────┘
                         │
                         ▼
                  LLM Message IR
              (= ModelMessage)
              (LLM 边界层，非常克制)
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         Anthropic     OpenAI     Gemini
          Adapter      Adapter    Adapter
              │          │          │
              ▼          ▼          ▼
          Messages    Responses   Contents
```

### AgentMessage (Agent 世界)

```ts
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolCallMessage
  | ToolResultMessage
  | SystemMessage
```

负责 Agent 的内部语义：任务、轨迹、工具调用、结果等。

**Agent Core 只使用 AgentMessage**，不需要知道 Provider 的存在。

### ModelMessage / LLM Message IR (LLM 边界层)

```ts
type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: ...
  providerOptions?: Record<string, unknown>  // Provider 特定选项的 escape hatch
}
```

**注意**: `ModelMessage` 应该定义得**非常克制**。它不是要和 AgentMessage 成为两个完全独立的类型体系，而是：

- 描述"如何把这些 Agent 语义交给 LLM"
- Provider 特定语义（Anthropic thinking、cache control 等）通过 `providerOptions` 保留，**不泄露到 AgentMessage**

### Provider Adapter (协议适配层)

每个 Provider 一个 Adapter，负责：

```text
ModelMessage → Anthropic Messages API
ModelMessage → OpenAI Chat/Responses API
ModelMessage → Gemini Contents API
```

**关键**: Provider-specific semantics MUST be preserved through explicit adapter/metadata escape hatches rather than leaking into AgentMessage。

这意味着 Anthropic 的 thinking blocks、OpenAI Responses 的 reasoning、Gemini 的 thought signature 等，都通过 `providerOptions` 传递，而不是在 AgentMessage 里建模。

---

## 与现有架构的兼容性

这个方向与已确定的四层设计完全兼容：

| 层 | 当前 | 推荐方向 |
|----|------|----------|
| **Provider** | `provider: 'anthropic' \| 'openai' \| ...` | 不变 |
| **Model** | `model: 'claude-opus-4-6'` | 不变 |
| **Protocol** | `protocol: 'anthropic-messages' \| 'openai-chat'` | 不变 |
| **Client** | `clients/{openaiChat,anthropicMessages}.ts` | 通过 Adapter 接入 |

只需在 Agent Core 和 Protocol Client 之间增加 AgentMessage → ModelMessage 层。

---

## 相关项目参考

### Pi (pi-ai)

Pi 的架构实际上有两层，不是只有一层 Message：

```text
pi-agent-core
    │
    │ AgentMessage
    ▼
Agent Loop
    │
    │ convertToLlm()
    ▼
pi-ai Message
    │
    ▼
Anthropic / OpenAI / Google...
```

- **`pi-agent-core`**: 使用 AgentMessage 描述 Agent 语义，Agent Core 不直接绑定 Provider API
- **`pi-ai`**: 使用通用 Message 描述 LLM 边界，通过 `convertToLlm()` 转换
- 显式处理跨 provider 兼容性（tool call ID、thinking blocks、图像支持检测）
- 有明确的降级策略（图像替换为占位符）
- 支持更多 provider（包括 Google Generative AI、Mistral、Bedrock 等）

**Pi 真正值得借鉴之处**: Agent Core 不直接绑定 provider API，在 LLM boundary 做转换——而不是简单的"自定义 Message → API"。

### OpenCode

```text
Session / Agent
    ↓
Domain Message (MessageV2 + Parts)
    ↓
ModelMessage (AI SDK format)
    ↓
Provider Transform
    ↓
Concrete Protocol
```

- 使用 Effect Schema 定义强类型消息格式
- Schema-first 设计，类型安全
- 每个协议独立，便于扩展

---

## 迁移路径

### Phase 1: 定义 AgentMessage 类型 ✅

在 `src/types/` 中定义与 Provider 无关的 AgentMessage 类型。

**已完成实现**:
- `src/types/agentMessage.ts` — Provider-agnostic 类型体系（AgentTextBlock / AgentImageBlock / AgentToolUseBlock / AgentToolResultBlock / AgentThinkingBlock / AgentMessage 联合类型）+ 创建函数 + 类型守卫
- `src/types/anthropicAdapter.ts` — Anthropic ↔ AgentMessage 双向转换，providerOptions escape hatch 保留 cache_control / citations / caller 等 Provider 特定语义
- 44 个单元测试全部通过（24 agentMessage + 20 anthropicAdapter）

### Phase 2: 在 Agent Core 中使用 AgentMessage

修改 Agent 循环、工具执行等模块，使用新的 AgentMessage 类型。

### Phase 3: 实现 ModelMessage 转换

在 `src/services/llm/` 中实现 AgentMessage → ModelMessage 的转换。

### Phase 4: 实现 Provider Adapters

逐步替换现有的 `normalizeMessagesForAPI()`，用 Provider Adapters 替代。

### Phase 5: 清理旧代码

移除 `convertAnthropicMessagesToOpenAI()`、`adaptOpenAIStreamToAnthropic()` 等转换函数。

---

## 影响评估

### 正面影响

- Agent Core 与 Provider 解耦，更容易支持新 Provider
- 统一的语义层，便于 Exev 等上层模块使用
- 类型安全，减少运行时错误
- 更好的可测试性

### 负面影响

- 需要重构 Agent Core 的消息处理逻辑
- 增加一层抽象，可能引入少量性能开销
- 需要维护 AgentMessage 和 ModelMessage 两套类型

### 工作量估计

- **Phase 1-2**: 中等（定义类型 + 适配 Agent Core）
- **Phase 3-4**: 较大（实现转换 + Provider Adapters）
- **Phase 5**: 较小（清理旧代码）

---

## 决策

**最重要的不是"换消息格式"，而是把这个边界真正建立起来：**

```text
❌ 当前：Agent → Anthropic Message → normalizeMessagesForAPI() → 各种 API
✅ 目标：Agent Core → AgentMessage → LLM Boundary → Provider/Protocol Adapter → API
```

**建议采用** Pi 的"Agent Core 不绑定 Provider API"思想 + OpenCode 的"强类型/LLM 边界层"思想，形成 AgentMessage → ModelMessage → Provider Adapter 的架构。

其中 ModelMessage 定义要**非常克制**——不是两个完全独立的类型体系，而是：
- 描述"如何把这些 Agent 语义交给 LLM"
- Provider 特定语义通过 `providerOptions` escape hatches 保留，**不泄露到 AgentMessage**

这比当前的 Anthropic-native 架构更适合作为 Codev 的长期基础。以后增加 OpenAI Responses、Gemini、Bedrock、未来新的 API，Agent Core 都不需要知道它们的存在。

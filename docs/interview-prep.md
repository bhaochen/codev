# 面试准备指南 — VersperClaw / Claude Code 架构知识体系

> 适用场景: 系统设计面试、技术深挖面试、架构师/高级工程师面试
> 目标: 覆盖 AI CLI 代理的核心设计决策、权衡、以及可以引申到通用分布式系统的知识点

---

## 1. 项目概述 (30-second pitch)

**VersperClaw 是什么?**

VersperClaw 是从 Anthropic Claude Code fork 出来的 AI CLI 代理 (Agentic Coding Assistant)，运行在终端中，核心能力是理解自然语言开发指令并自动执行多步骤编码任务。

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

### Q: 多 Provider 架构如何实现?

VersperClaw 支持多种 LLM Provider, 架构分为两层:

**Tier 1: Anthropic 原生通道**

- 直接使用 Anthropic SDK
- 支持 Bedrock、Vertex AI、Foundry 三种部署方式
- 不需要协议转换, 性能最优

**Tier 2: 第三方 Provider 通道**

- 使用 **Fetch Override 模式**: 拦截 `globalThis.fetch` 方法
- 将 Anthropic Messages API 请求重写到目标 Provider 的 API 格式
- 协议转换: Anthropic Messages ↔ OpenAI Chat/Responses API

**Fetch Override 的工作原理:**

```
原始调用: client.messages.create({model, messages, tools})
    → SDK 内部调用 fetch("https://api.anthropic.com/v1/messages", body)
    → 被 override 拦截
    → 转换 body 格式 (Anthropic → OpenAI)
    → 发送到目标 Provider (如 https://api.openai.com/v1/chat/completions)
    → 转换 response 格式 (OpenAI → Anthropic)
    → 返回给 SDK
```

**模型列表管理:**

- `modelStrings()` 缓存所有可用模型
- Provider 切换后必须调用 `clearModelStrings()` 清除缓存
- 模型信息包括: Provider 名、模型 ID、上下文窗口、价格、速率限制

**为什么用 Fetch Override 而不是独立 SDK?**

1. 保持统一的 Anthropic Messages 接口, 不需要为每个 Provider 写独立适配
2. Fetch Override 是无侵入的: 所有依赖 Anthropic SDK 的代码无需修改
3. 对用户透明: 用户配置 Provider 后, 体验完全一致

---

### Q: Friend VRM 系统为什么设计为同进程 + SSE?

Friend 是 VersperClaw 的 3D 桌面伴侣系统, 使用 VRM 模型 (3D 虚拟角色), 具备表情、动作、语音对话能力。

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

VersperClaw 使用编译时 Feature Flag 系统, 实现 `#ifdef` 风格的死代码消除。

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

**方案设计 (参考 VersperClaw):**

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
方案 A: 同进程 (VersperClaw 的选择)
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

### 设计多 Provider LLM 代理

**需求分析:**

- 支持多种 LLM Provider (Anthropic, OpenAI, NVIDIA, opencode, vLLM)
- 统一的接口, 对用户透明
- Provider 切换不影响 Agent 状态
- 优雅降级 (Provider 不可用时自动切换)

**方案对比:**

```
方案 A: Fetch Override (VersperClaw 选型)
  优点:
    - 无侵入: 不修改 SDK, 不修改 Agent 核心逻辑
    - 统一接口: 所有代码只认识 Anthropic Messages 格式
    - 易于扩展: 新增 Provider 只需要写协议转换层
  缺点:
    - 依赖 fetch API 的完整性
    - 调试复杂 (请求经过转换层)
    - 无法利用 SDK 原生功能 (如 streaming 的细节)

方案 B: Proxy 模式
  优点:
    - 请求在中间层转换, 客户端 SDK 无需修改
    - 可以添加缓存、限流、日志
  缺点:
    - 需要额外部署 Proxy 服务
    - 增加网络延迟
```

**协议转换 (Anthropic ↔ OpenAI):**

```
Anthropic Messages → OpenAI Chat/Responses API

关键映射:
  system:          system_message
  messages:        messages (角色映射: assistant/assistant, user/user)
  tools:           tools (function calling 格式)
  tool_use:        tool_calls
  tool_result:     tool (function response)
  max_tokens:      max_tokens
  stop_sequences:  stop

OpenAI → Anthropic 逆映射同理
```

**模型列表管理:**

- `modelStrings()` 函数缓存所有可用模型的元数据
- 缓存包括: Provider、模型 ID、上下文窗口、价格信息
- Provider 切换时必须调用 `clearModelStrings()` 清除缓存
- 缓存预热: 启动时异步加载所有 Provider 的模型列表

**面试追问:**

1. **为什么用 Fetch Override 而不是独立 SDK?** — 对现有代码的侵入最小化。所有依赖 Anthropic SDK 的代码 (包括第三方库) 无需任何修改即可支持新 Provider。

2. **如何处理 Provider 特有的能力?** — 有些 Provider 不支持 tool use 或 streaming, Fetch Override 层需要做降级处理。

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
- **VersperClaw 的答案**: 渐进信任 + 4 层防御 + ML 辅助
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

- **VersperClaw 的答案**: 5 层压缩管道 + JSONL 持久化 + Append-only 日志
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

- **VersperClaw 的答案**: 同进程, 因为这是一个单用户终端工具, 不是分布式系统
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
 2 分钟: "VersperClaw 是从 Claude Code fork 的 AI CLI 代理,
          核心增强是多 Provider 支持和 VRM 桌面伴侣,
          采用同进程 + SSE 架构实现低延迟语音对话"
10 分钟: 深入 Agent Loop、权限系统、压缩管道、Friend 架构
```

### 把 VersperClaw 经验映射到通用系统设计

| VersperClaw 概念 | 通用系统设计概念 |
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

> 最后更新: 2026-06-22
> 基于 VersperClaw main branch (commit 835ff5a)

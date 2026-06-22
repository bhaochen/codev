# 设计哲学与架构原则

> 本文档综合自 Dive into Claude Code (arXiv:2604.14228v1) 的架构分析以及 VersperClaw
> 源代码的实际实现模式，旨在为面试准备和系统设计讨论提供参考。
>
> Claude Code 的设计哲学源于五个核心人类价值，通过十三条设计原则转化为具体的架构决策。
> VersperClaw 在此基础上进行了多 Provider 和 Friend VRM 等扩展。

---

## 1. 五大核心价值 (Core Values)

Claude Code 的系统架构由五个根本性的人类价值驱动。这些价值不是事后总结，而是在架构设计
之初就被确立为优先级排序的依据。

### 1.1 人类决策权威 (Human Decision Authority)

人类保留对所有系统行为的最终决定权。这一价值通过 **主体层级结构 (principal hierarchy)**
来实现：Anthropic（作为模型开发者）→ operators（组织管理员）→ users（终端用户）。

架构含义：
- 人类可以**实时观察**系统行为、**批准或拒绝**提议的操作、**中断**进行中的操作、并在
  事后**审计**所有操作记录。
- 当 Anthropic 发现用户批准 93% 的权限提示时，他们的反应不是增加更多警告，而是重新
  构建问题：通过在明确定义的边界（沙箱、auto-mode 分类器）内让代理自由工作，而非
  依赖用户逐操作审批（因为一旦习惯化，用户就会不加审查地批准）。
- 对应源文件：`src/utils/permissions/permissions.ts`、`src/utils/permissions/PermissionMode.ts`

### 1.2 安全、安全与隐私 (Safety, Security, and Privacy)

系统有义务保护人类、代码、数据和基础设施，**即使人类疏忽或犯错**。这与人类决策权威
有本质区别：权威是关于人类的**选择权**，而安全是关于系统的**保护义务**。

架构含义：
- 威胁模型涵盖四种风险：过度热心行为、诚实错误、提示注入和模型失准。
- 实现为**多层重叠安全机制**（拒绝优先、分类器、沙箱、钩子），任何一层都能独立阻止
  危险操作。
- 对应源文件：`src/utils/permissions/yoloClassifier.ts`、`src/tools/BashTool/shouldUseSandbox.ts`

### 1.3 可靠执行 (Reliable Execution)

代理正确执行用户的实际意图，在长时间内保持一致性，并支持在执行完成前验证工作。

架构含义：
- 涵盖单轮正确性和长周期可靠性（跨上下文窗口边界、会话恢复、多代理委派）。
- 实现了 5 层压缩管道、优雅恢复机制（max_output_tokens 升级重试、auto-compact、
  reactive compact）和自动断路器。
- 对应源文件：`src/query.ts`（queryLoop）、`src/services/compact/autoCompact.ts`

### 1.4 能力放大 (Capability Amplification)

系统显著提升开发者单位时间/成本的产出效率。Anthropic 内部调查显示约 27% 的任务属于
"如果没有工具就不会尝试的工作"——架构使**全新的工作流**成为可能，而不仅仅是加速
现有流程。

架构含义：
- 系统的创造者将其描述为 "Unix 工具而非传统产品"——由最小、有用、可理解和可扩展的
  构建块组成。
- 投资于**确定性基础设施**（上下文管理、工具路由、恢复机制）而非决策框架（显式
  规划器或状态图），前提是日益强大的模型更受益于丰富的操作环境而非约束性框架。
- 对应源文件：`src/tools/tools.ts`（assembleToolPool）、`src/query.ts`（~88 行主循环）

### 1.5 上下文适应性 (Contextual Adaptability)

系统适配用户的特定上下文（项目、工具、约定、技能水平），并且关系随时间改善。

架构含义：
- 扩展架构（CLAUDE.md、skills、MCP、hooks、plugins）提供多层级可配置性，每层具有
  不同的上下文成本。
- 纵向数据显示人机关系是演化的：自动批准率从 <50 会话的 ~20% 增长到 750+ 会话的
  >40%。信任是"由模型、用户和产品共同构建的"。
- 对应源文件：`src/context.ts`、`src/services/mcp/`、`src/utils/hooks/`

---

## 2. 十三条设计原则 (Design Principles)

五大价值通过十三条设计原则可操作化。每条原则回答一个生产级编码代理必须解决的
重复性问题。下表总结了每条原则、其服务的价值、设计问题以及关键实现文件。

| # | 原则 | 服务价值 | 设计问题 | 关键实现 |
|---|------|---------|---------|---------|
| 1 | **拒绝优先，人类升级** (Deny-first with human escalation) | Authority, Safety | 未识别的操作应被允许、阻止还是升级给人类？ | `permissions.ts` (deny 规则优先于 allow 规则) |
| 2 | **渐进信任光谱** (Graduated trust spectrum) | Authority, Adaptability | 固定权限层级还是随时间演进的光谱？ | `PermissionMode.ts` (7 个模式: plan → default → acceptEdits → auto → dontAsk → bypassPermissions → bubble) |
| 3 | **深度防御，分层机制** (Defense in depth with layered mechanisms) | Safety, Authority, Reliability | 单一安全边界还是多个重叠的？ | 7 层独立机制 (pre-filter + deny-first + modes + classifier + sandbox + no-restore + hooks) |
| 4 | **外化可编程策略** (Externalized programmable policy) | Safety, Authority, Adaptability | 硬编码策略还是外化配置？ | `CLAUDE.md` 层级, `hooks` 生命周期, `PermissionRule` |
| 5 | **上下文作为稀缺资源，渐进管理** (Context as scarce resource with progressive management) | Reliability, Capability | 绑定资源约束是什么？如何分级管理？ | 5 层压缩管道 (budget → snip → microcompact → collapse → auto-compact), `query.ts:365-453` |
| 6 | **追加式持久状态** (Append-only durable state) | Reliability, Authority | 可变状态、快照还是追加日志？ | JSONL 会话转录 (`sessionStorage.ts`), 侧链文件 |
| 7 | **最小脚手架，最大操作平台** (Minimal scaffolding, maximal operational harness) | Capability, Reliability | 投资于推理侧框架还是操作基础设施？ | ~88 行 queryLoop; ~98.4% 的代码为确定性基础设施 |
| 8 | **价值观优于规则** (Values over rules) | Capability, Authority | 僵化的决策程序还是上下文的判断？ | 系统提示设计基于原则而非穷举规则 |
| 9 | **可组合的多机制扩展** (Composable multi-mechanism extensibility) | Capability, Adaptability | 统一扩展 API 还是分层机制？ | MCP + Plugins + Skills + Hooks 四种机制，上下文成本递增 |
| 10 | **可逆性加权风险评估** (Reversibility-weighted risk assessment) | Capability, Safety | 所有操作相同监督还是更轻的只读/可逆操作？ | read-only 工具并行执行, 写操作串行化 |
| 11 | **透明的基于文件的配置与记忆** (Transparent file-based configuration and memory) | Adaptability, Authority | 不透明数据库、嵌入检索还是用户可见的文件？ | `CLAUDE.md` 层级, auto-memory 文件, git 版本可控 |
| 12 | **隔离的子代理边界** (Isolated subagent boundaries) | Reliability, Safety, Capability | 子代理共享父上下文还是隔离运行？ | `AgentTool.tsx`, `runAgent.ts`, 侧链转录, 独立上下文窗口 |
| 13 | **优雅恢复与韧性** (Graceful recovery and resilience) | Reliability, Capability | 错误时硬失败还是静默恢复？ | max_output_tokens 升级 (3次)、reactive compact、fallback model、断路器 |

### 2.1 原则的可选设计家族

这些原则可以通过对比三种主流替代设计家族来理解：

- **基于规则的编排**：LangGraph 等框架将决策逻辑编码为显式状态图（typed edges），选择
  脚手架而非最小平台。
- **容器隔离执行**：SWE-Agent 和 OpenHands 依赖 Docker 隔离而非分层策略执行。
- **版本控制即安全**：Aider 使用 Git 回滚作为主要安全机制而非拒绝优先评估。

Claude Code 的原则组合的独特之处在于：最小决策脚手架 + 分层策略执行 + 基于价值观的
判断 + 拒绝优先默认 + 渐进上下文管理 + 可组合扩展。

### 2.2 值-原则-架构 映射

每条价值通过其原则追踪到特定的架构决策：

| 价值 | 驱动的原则 | 架构体现 |
|------|-----------|---------|
| 人类决策权威 | 拒绝优先、渐进信任、追加状态、外部化策略、价值观优于规则 | 权限系统、审计日志、CLAUDE.md |
| 安全与隐私 | 深度防御、拒绝优先、可逆性加权、外部化策略、隔离子代理 | 7 层安全、沙箱、分类器 |
| 可靠执行 | 稀缺上下文、追加状态、优雅恢复、隔离子代理、深度防御 | 压缩管道、JSONL 转录、断路器 |
| 能力放大 | 最小脚手架、可组合扩展、可逆性加权、上下文管理、优雅恢复 | queryLoop、MCP、speculative 执行 |
| 上下文适应性 | 透明文件记忆、可组合扩展、渐进信任、外部化策略 | CLAUDE.md 层级、skills、hooks |

---

## 3. 架构权衡 (Architectural Trade-offs)

### 3.1 安全 vs 自主权 (Safety vs. Autonomy)

系统中最核心的张力：更高的自主权意味着更少的人类干预，但也意味着更大的风险。

- **Claude Code 的选择**：通过渐进信任光谱来管理这种张力。用户从 `plan` 或 `default`
  模式开始，随着时间向 `acceptEdits` → `auto` → `bypassPermissions` 演进。
- **权衡的体现**：当命令超过 50 个子命令时，权限系统退回到通用审批提示而非逐子命令
  检查，因为逐子命令解析会导致 UI 冻结。这是安全与性能之间结构性张力的实例。
- **相关代码**：`src/utils/permissions/getNextPermissionMode.ts`、
  `src/utils/permissions/PermissionMode.ts`

### 3.2 上下文效率 vs 透明度 (Context Efficiency vs. Transparency)

压缩节省上下文但降低人类可读性。

- **Claude Code 的选择**：5 层压缩管道，从轻量级（budget reduction、snip）到重量级
  （auto-compact），每层在成本和效果之间做出不同权衡。
- **权衡的体现**：auto-compact 使用模型生成摘要来替代原始对话，但摘要丢失了原始
  细节。上下文折叠 (context collapse) 作为只读投影避免了这个问题，但增加了实现
  复杂度。追加式 JSONL 日志虽然保留完整可审计历史，但在恢复时不还原权限状态，
  牺牲了便利性以换取安全性。
- **相关代码**：`src/services/compact/`（整个目录）、`src/utils/sessionStorage.ts`

### 3.3 简单 vs 可扩展 (Simplicity vs. Extensibility)

核心循环应该简单，但系统需要适应各种用例。

- **Claude Code 的选择**：`queryLoop()` 是 ~88 行的 while-true 循环。~98.4% 的代码
  存在于周围的子系统中：安全、扩展、上下文管理、委派和持久化。
- **权衡的体现**：为什么有四种扩展机制（MCP、plugins、skills、hooks）而不是一种？
  因为每种机制服务于不同的抽象级别和上下文成本。MCP 提供外部工具集成，plugins 打包
  组件，skills 注入领域指令，hooks 拦截生命周期。这种分层增加了概念复杂性，但允许
  在不同场景下使用适当的工具。
- **相关代码**：`src/query.ts`、`src/services/mcp/`、`src/plugins/`、`src/skills/`、
  `src/utils/hooks/`

### 3.4 对抗条件下的权限模型 (Permission Model Under Adversarial Conditions)

当用户（或劫持用户的提示注入）主动尝试规避安全措施时。

- **Claude Code 的应对**：拒绝优先 + 深度防御的组合否认了单点失效。即使一个安全层
  被绕过（例如用户批准了恶意命令），其他层（沙箱、分类器、钩子）仍然可以拦截。
- **关键弱点**：共享实现约束导致安全层之间存在共性失效模式。例如，权限系统和 UI
  渲染共享主线程，当规则评估导致 UI 冻结时，两者同时失效。
- **相关代码**：`src/utils/permissions/permissions.ts`、
  `src/utils/permissions/yoloClassifier.ts`

---

## 4. VersperClaw 与 Claude Code 的差异

VersperClaw 以 Claude Code 为上游基础，进行了以下主要变更和扩展：

### 4.1 多 Provider 支持

- Claude Code 内置仅支持 Anthropic API，而 VersperClaw 通过 Provider 代理架构
  支持 OpenAI、Groq、DeepSeek 以及所有兼容 OpenAI 的 API。
- **实现模式**：`src/server/proxy/handler.ts` 实现双路由决策——
    - 1P Anthropic 路径：直接调用 Anthropic SDK
    - 3P Provider 路径：通过协议转换器（`anthropicToOpenaiChat.ts` → upstream API →
      `openaiChatToAnthropic.ts`）
- **架构影响**：代理层引入额外的延迟和错误处理复杂度，但使得系统不受单一供应商限制。

### 4.2 Friend VRM 系统

- 同进程 VRM 伴侣服务，使用 3D 虚拟角色（VRM 格式）作为交互界面。
- **实现模式**：`src/friend/FriendService.ts` 是单例服务，与 React 组件通过
  `subscribe()` / `subscribeToInbound()` 模式同步。使用 SSE 广播将表情/TTS 推送到
  VRM 前端。
- **关键组件**：
  - Silero VAD：WASM 推理（`src/friend/voice/vad-service.ts`），通过 onnxruntime-web
    实现机器学习级语音活动检测
  - 进程内音频捕获：cpal Rust 库（替代传统的 arecord/parecord 子进程）
  - TTS 引擎：Edge TTS（默认）和 Qwen TTS（DashScope API）
- **架构意义**：展示了如何将 Claude Code 的扩展机制（钩子 + 工具）用于非开发场景，
  将编码代理转变为通用对话代理。

### 4.3 移除 ant-internal 模块

- 移除了 Anthropic 内部使用的模块（feature flags、内部 API），使代码对社区完全可用。
- `src/query/transitions.ts` 等文件使用代理桩 (proxy stub) 替代缺少的内部模块，
  通过 `bun:bundle` 的 DCE 在构建时消除。

### 4.4 社区贡献

- **onnxruntime-web WASM VAD**：首个在生产级 CLI 工具中集成基于 ML 的语音活动检测。
- **同进程 Friend 服务**：无需独立后台服务器子进程，简化了部署架构。

---

## 5. 关键架构模式 (Key Architecture Patterns)

### 5.1 单一主循环模式 (Single Main Loop)

**实现**：`queryLoop()` 是 `src/query.ts` 中的 AsyncGenerator，约 88 行核心控制逻辑
（while-true），周围 ~98.4% 的代码是确定性基础设施。

**循环结构**（简化的伪代码）：

```
while (true) {
  1. 解构状态 (destructure state)
  2. 压缩管道 (5 shapers: budget → snip → microcompact → collapse → auto-compact)
  3. 调用模型 (for await over deps.callModel)
  4. 工具派发 (StreamingToolExecutor 或 runTools)
  5. 收集结果 → 更新状态 → 继续或终止
}
```

**架构意义**：
- 生成器模式实现了流式输出，同时保持单一同步控制流。
- 七个"继续点"（continue sites）各自通过一次整体对象赋值（而不是逐个字段变更）
  来更新状态，保持了不变性的简单性。
- 所有入口（交互式 CLI、headless CLI、SDK、IDE 集成）汇聚到同一个 queryLoop，
  只有 UI/渲染层不同。

### 5.2 追加日志模式 (Append-Only Log Pattern)

**实现**：`src/utils/sessionStorage.ts` 将会话转录存储为 JSONL 文件（每行一个 JSON
事件）。

**核心选择**：
- 状态变更使用**追加写入**而非原地修改
- 子代理对话存储在单独的**侧链文件**中（`sessionStorage.ts:247`），避免膨胀父上下文
- 恢复/复刻操作从事务重建会话状态（`conversationRecovery.ts`）

**架构意义**：
- 写前日志 (Write-Ahead Log) 风格使得审计、调试和恢复成为一等公民。
- 但不在恢复时还原会话级权限——这是一个有意的设计选择，牺牲便利以换取安全
  （防止权限状态被意外恢复）。

### 5.3 分层安全模式 (Layered Security Pattern)

**实现**：7 层独立安全机制：

| 层 | 机制 | 源文件 | 作用时机 |
|----|------|--------|---------|
| 1 | 工具预过滤 | `tools.ts` (filterToolsByDenyRules) | 模型调用前 |
| 2 | 拒绝优先规则 | `permissions.ts` (toolMatchesRule) | 工具派发时 |
| 3 | 权限模式约束 | `PermissionMode.ts` | 模式切换时 |
| 4 | Auto-mode 分类器 | `yoloClassifier.ts` | auto 模式下 |
| 5 | Shell 沙箱 | `shouldUseSandbox.ts` | Bash 执行前 |
| 6 | 恢复时不恢复权限 | `conversationRecovery.ts` | 会话恢复时 |
| 7 | Hook 拦截 | `types/hooks.ts` | 工具生命周期各点 |

**架构意义**：
- 任何单层都不能完全信任——深度防御假设每层都可能失效，但多层同时失效的概率降低。
- 层之间共享实现约束（例如，超过 50 个子命令的命令退回到通用审批，因为逐子命令
  解析导致 UI 冻结）。

### 5.4 渐进式上下文管理 (Progressive Context Management)

**实现**：5 层压缩管道，每层有不同成本效益比：

```
Budget Reduction (工具结果大小限制)
  → Snip (轻量级历史修剪)
    → Microcompact (细粒度缓存感知压缩)
      → Context Collapse (只读投影，不改变存储)
        → Auto-compact (模型生成的语义摘要，最后手段)
```

**决策顺序**：更早、更轻量的层先运行。只有当前置层不足以将上下文降到阈值以下时，
才触发更重的层。

**架构意义**：
- 没有单一压缩策略能应对所有类型的上下文压力。
- Budget 针对单个工具输出溢出；Snip 处理时间深度；Microcompact 应对缓存开销；
  Context Collapse 管理超长历史；Auto-compact 执行语义压缩。
- 同样的稀缺性思维体现在其他子系统：CLAUDE.md 懒加载、延迟工具模式、子代理仅返回
  摘要。

### 5.5 流式工具执行 (Streaming Tool Execution)

**实现**：`src/services/tools/StreamingToolExecutor.ts`

- 工具在模型流式响应时就开始执行（不是等待完整响应）
- 只读操作可以并行执行；写操作（如 Bash 命令）串行化
- 兄弟终止控制器：当任何 Bash 工具出错时立即终止其他进行中的子进程
- 结果按工具发出顺序缓冲和发射，即使并行执行也保持顺序一致性

**架构意义**：
- 介于完全串行派发和激进推测执行（如 PASTE）之间的中间方案
- 在延迟降低和实现简单性之间取得平衡

---

## 6. 延伸阅读

- **Dive into Claude Code** (arXiv:2604.14228v1): 对本文档所基于的原始架构分析论文
- **Anthropic Safe Agents Framework**: 安全代理设计的原则文档
- **Claude Code 官方文档**: [https://code.claude.com/docs/](https://code.claude.com/docs/)
- **VersperClaw 源代码**: `/home/yuki/Code/Agent/VersperClaw/src/`
  - 核心循环: `src/query.ts`
  - 权限系统: `src/utils/permissions/`
  - 压缩管道: `src/services/compact/`
  - 扩展机制: `src/services/mcp/`, `src/utils/hooks/`
  - 状态持久化: `src/utils/sessionStorage.ts`
  - 多 Provider: `src/server/proxy/`
  - Friend VRM: `src/friend/`

---

> **文档版本**: v1.0 — 2026-06-22
> **作者**: 基于 Claude Code 设计哲学论文和 VersperClaw 源代码综合分析

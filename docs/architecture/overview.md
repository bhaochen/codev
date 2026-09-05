# 项目架构概览

## 项目定位

Codev 是一个 AI CLI 智能代理，基于 Anthropic Claude Code 源代码构建，增强了对以下场景的支持：

- **VRM 桌面伴侣**（Friend）：在同一进程中运行 HTTP/SSE 服务，驱动 3D VRM 角色的表情、语音和文本气泡
- **多模型提供者**：单轨 Native LLM Runtime，Protocol Client 直连上游（OpenAI Chat / Anthropic Messages），支持数十种第三方模型
- **语音对话**：基于 cpal（Rust 原生音频库）的进程内音频捕获，结合 Silero VAD（ONNX 实时语音活动检测）和多种 STT/TTS 引擎
- **自动化模式**：目标系统（Goals）、后台任务（Background Tasks）、MCP 工具集成、Feishu/Telegram Bot 桥接
- **REPL 批量引擎**：Bun `node:vm` 沙箱 + ToolResult/ContextAggregator 契约，一次调用批量执行多工具

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | **Bun 1.3+**（JavaScript/TypeScript 运行时与打包器） |
| 语言 | **TypeScript**（全仓库使用 strict 模式） |
| 终端 UI | **Ink v6**（React 终端渲染框架）+ **React 19** |
| 3D 渲染 | **Three.js**（VRM 前端使用，通过 {React} Three Fiber） |
| 语音活动检测 | **onnxruntime-web (WASM)** — Silero VAD ONNX 模型（非 onnxruntime-node，避免 Bun 段错误） |
| 桌面窗口 | **Tauri**（可选桌面窗口模式） |
| 包管理 | **Bun** workspace（monorepo），`packageManager: bun@1.3.11` |
| 构建 | Bun 内建打包 `scripts/build.ts`，支持 `feature()` 死代码消除 |

## 入口流程

```
cli.tsx (bootstrap)
    │
    ▼
main.tsx (Commander CLI 定义)
    │  ├── 注册 ~180+ 命令（commands.ts → command modules）
    │  └── 注册 ~60+ AI 工具（tools.ts → tool modules）
    │
    ▼
replLauncher.tsx
    │
    ▼
Ink REPL (screens/REPL.tsx)
    ├── PromptInput（文本输入组件）
    ├── messageQueueManager（统一命令队列）
    ├── query.ts（AI 请求分发）
    └── useMergedTools（工具池装配）
```

### 启动阶段详解

1. **`src/entrypoints/cli.tsx`** — 最外层入口。先扫描 `--version`/`-v`、`--dump-system-prompt`、`--bridge`、`--daemon`、`--tmux` 等快速路径标志。若无匹配则动态导入 `main.tsx` 并调用 `cliMain()`。
2. **`src/main.tsx`** — 构建 Commander CLI 定义（约 180+ 命令）。执行配置加载、策略检查、遥测初始化、会话恢复等。最后调用 `launchRepl()` 渲染终端 UI。
3. **`src/replLauncher.tsx`** — 负责动态加载 `<App>` 和 `<REPL>` 组件并调用 `renderAndRun()`。
4. **`src/screens/REPL.tsx`** — 主 REPL 屏幕，包含消息历史、PromptInput、工具调用渲染等。

## 架构亮点

### 1. 同进程架构

Friend VRM 服务与 CLI 运行在**同一 Bun 进程**中：

- `friend/server.ts` 通过 `Bun.serve()` 监听 `127.0.0.1:3456`
- SSE（Server-Sent Events）用于服务端到 VRM 前端的实时推送（表情、音频、文本气泡）
- HTTP POST 用于 VRM 前端向 FriendService 发送消息
- 消除了独立的子进程管理和 CLI SDK 会话的开销

### 2. 模块化工具系统

60+ AI 可调用工具通过 `buildTool()` 框架注册。核心工具包括：

- **文件操作**: `BashTool`, `FileReadTool`, `FileEditTool`, `FileWriteTool`, `GlobTool`, `GrepTool`
- **Web/搜索**: `WebFetchTool`, `WebSearchTool`
- **任务管理**: `TaskCreateTool`, `TaskGetTool`, `TaskUpdateTool`, `TaskListTool`, `TaskStopTool`
- **MCP**: `ListMcpResourcesTool`, `ReadMcpResourceTool`
- **Friend 特有**: `FriendEmotionTool`（VRM 表情 + 心情管理）, `FriendScreenObserveTool`
- **目标系统**: `GoalCreateTool`, `GoalGetTool`, `GoalUpdateTool`
- **工作流**: `WorkflowTool`（通过 WORKFLOW_SCRIPTS feature flag）
- **REPL 批量**: `REPLTool`（Bun `node:vm` 沙箱，`callTool()` 批量执行，见 `src/tools/REPLTool/engine.ts:35` ToolResult/ ContextAggregator）
- **其他**: `AgentTool`, `SkillTool`, `TodoWriteTool`, `ToolSearchTool`, `ConfigTool` 等

工具通过 `assembleToolPool()` 与 MCP 工具合并去重，统一提供给 AI 模型。

### 3. 单轨 Native LLM Runtime（Phase 1-12 渐进式解耦，Tier2 已删除）

> **术语统一**：`ProtocolRegistry ≡ ClientRegistry`（`src/services/llm/protocols/index.ts` 为唯一运行时源, `src/services/llm/clients/index.ts` 为薄 facade `getClientForRoute → getProtocolHandler`）。`Phase 1-12` = 架构演进主线，`P0-P6` 为早期内部编号（见下表映射）。

```
Agent → queryModel.ts:17 Facade → ModelRuntime.generate() → resolveRoute() → LLMRoute{provider,protocol,model,endpoint}
                                                      ↕                         ↕
                              ModelResolver → canonical  +  ModelRegistry   ProtocolRegistry → handler
                                                     ↕                         ↓
                              Auth Strategy → Credential                 Transport → Framing → Adapter → Native Endpoint
```

- **LLMRoute 最小 4 字段** (`src/services/llm/types.ts:26`): `{provider, protocol, model, endpoint}`，不含 Auth/Capability/Transport。`Phase 4` 引入 `src/services/llm/route/Route.ts` (`buildRoute/normalizeRouteInput`) 支持 `protocol/endpoint` 显式覆盖，`Phase 9` 后 Provider 仅提供 `defaultProtocol/defaultEndpoint` (兼容别名 `protocol/endpoint`)，最终 Route 由 `resolveRoute({model,protocol?,endpoint?})` 组合。
- **Provider ≠ Protocol ≠ Model** (`src/services/llm/providers/*`): Provider 只提供 `{id, defaultProtocol, defaultEndpoint, displayName}` 默认值；`ModelResolver` (`src/services/llm/models/modelResolver.ts:11` 独立边界) 负责 `openai→resolveOpenAIModel / opencode→getOpenCodeModelName / others→passthrough`；`ProtocolRegistry` 负责通信契约，三者在 `Route` 汇合。
- **ProtocolRegistry 唯一源** (`src/services/llm/protocols/index.ts:23` `ProtocolRegistry:Record<ProtocolId,ProtocolDef{handler}>`): `openai-chat→queryOpenAIChat (clients/openaiChat.ts:52)`, `openai-responses→queryOpenAIResponses (protocols/openaiResponses.ts:59, 独立 Responses SSE adapter)`, `openai-compatible-chat→queryOpenAICompatibleChat (protocols/openaiCompatibleChat.ts:54, 任意 baseURL→/chat/completions)`, `anthropic-messages→queryAnthropicMessages (clients/anthropicMessages.ts:958)`。`gemini/bedrock-converse` 已注册 metadata 但 `handler=undefined` → `getClientForRoute→null` 显式 `unsupported`。`Client=Protocol` 无 Provider 分支（P0 已清理）。
- **Transport/Framing 最小抽象** (`src/services/llm/transport/http.ts:7` `httpRequest`, `src/services/llm/transport/sse.ts:24` `parseSSERaw` 处理跨 chunk + `[DONE]`, `parseOpenAIChunksFromSSE`): `Phase 5` 抽离后 `openaiChat/Responses/Compatible` 共用 `httpRequest + parseSSERaw`，`anthropic-messages` 仍走 SDK。`Phase 6` 修复 `Responses` 误用 Chat parser (`adaptOpenAIResponsesSSEToAnthropic` 处理 `response.output_text.delta/completed`)。
- **Auth Strategy** (`src/services/llm/auth/strategies.ts:10` `AuthStrategy{id,resolve}`): `bearer (openai/opencode/nvidia 复用, opencode fallback public)` / `api-key (x-api-key)` / `none (firstParty/bedrock/vertex/foundry/local)`，`src/services/llm/auth/resolveAuth.ts:22` `strategyByProvider` 映射，`Route → Auth → headers → Transport` (Protocol 不直接选 Auth)。
- **ModelRegistry 独立** (`src/services/llm/models/registry.ts:40` `ModelRegistry{has,get,getOrDefault,list,registerModelsDev,clearModelsDev}`): `ModelDefinition{ id, capabilities:{tools,vision,reasoning,streaming} }`，`Phase 11` 纯本地 `big-pickle/default`，`Phase 12B` `fromModelsDev` 纯函数 (`provider/model` 保留, `reasoning→reasoning, tool_call→tools, attachment+image/pdf→vision`)，`Phase 12C` `local > models.dev > default` 合并，`Phase 12D` `modelsDevCache.ts:57` `XDG_CACHE_HOME/ ~/.cache/codev/models.json` TTL 24h 原子写 + `main.tsx:420` `startDeferredPrefetches` 后台非阻塞同步。
- **ModelRuntime 薄编排** (`src/services/llm/runtime/ModelRuntime.ts:11`): `resolveRoute → getModelMetadata → getClientForRoute(ProtocolRegistry) → handler.query`，`capabilities` 不进 Route，仅限流/重试预留。
- **稳定 Facade** (`src/services/api/queryModel.ts:17`): `queryModel() → modelRuntime.generate()` 兼容；新代码 `import { modelRuntime }`。

**Phase 演进映射 (1-12 ↔ P0-P6)**:

| Phase | 主题 | 关键 commit | 旧编号 |
|-------|------|-------------|--------|
| 1 | ProtocolRegistry 声明 | `532f738` | — |
| 2 | OpenAI Responses 拆分 (`/responses`) | `f837706` | P1 |
| 3 | OpenAI-Compatible Chat (任意 baseURL) | `ac2f680` | — |
| 4 | Route 抽象 `{provider,protocol,model,endpoint}` | `7d0bc7c` | P2 |
| 5 | Transport `httpRequest` + Framing `parseSSERaw` | `a939f5a` | — |
| 6 | Responses Stream Adapter (`output_text.delta`) | `6dfdd51` | — |
| 7 | Auth Strategy (`bearer/api-key/none`) | `d59db90` | P3 |
| 8 | ProtocolRegistry 运行时唯一源 | `91b8fc9` | — |
| 9 | Provider≠Protocol (`defaultProtocol`) | `d752e69` | — |
| 10 | ModelResolver 独立 | `4225283` | P4 |
| 11 | ModelRegistry (`has/get/list`) | `c5901ae` | — |
| 12B | models.dev Adapter (纯函数) | `df13a0f` | — |
| 12C | Registry Merge `local>dev` | `b9503eb` | — |
| 12D | Cache Sync `XDG 24h` | `e1fa95a` | — |
| 12E | Audit + Startup wire + Race guard | `5518b94` | — |

**免费模型健壮性** (`src/services/llm/clients/openaiChat.ts:101`): `model.includes('free'||'contributor')` 或 `models.dev isFree` 判定（请求体不裁剪，全量发送）；`opencode` 无 key 注入 `x-anthropic-billing-header`; 瞬态 `500→big-pickle` 重试 (`f141d7c`)。

**为什么删 Tier2 / Transport 取舍:**
- Tier2 `cc-haha` (`13c204e`) 第二套 Provider 路由与单轨 `Route` 冲突，仅留 Tier1 `~/.claude.json:authProvider`。
- Transport 曾抽象 `fetch-override/SDK/native`，`Phase 5` 后仅保留最小 `httpRequest/parseSSERaw`，`Client=Protocol` 已足够；`5f944f0` 删 `fetch-override` 回退，原生直连验证。

**测试策略** (`89 tests, src/services/llm/**`): `resolveRoute` 8+5 用例 (`provider×protocol×endpoint` 组合), `ProtocolRegistry` 7 用例, `Transport` 7 (跨 chunk/`[DONE]`), `ResponsesAdapter` 6 (delta/completed/unknown), `Auth` 9 (bearer/api-key/none 复用), `ModelResolver` 6, `ModelRegistry` 8, `Merge` 9, `Cache` 6 — 详见 [Provider 多厂商认证](provider-auth.md) §11 与 `docs/architecture/testing-strategy.md` (待建)。

详见 [Provider 多厂商认证](provider-auth.md) 与 [核心数据流](data-flow.md)。

### 4. REPL 3 层批量执行（P6.6 契约）

```
Tool → ToolResult{ok,exitCode,stdout/stderr/data,outputPath,truncated} → ExecutionStore(innerMessages,isVirtual) → ContextAggregator → ContextResult{ok,tool_calls,calls:[{preview,summary,truncated,outputPath}],logs} → LLM API
         ↑ 统一事实模型           ↑ UI/history 可视        ↑ 进 LLM 的唯一载体          （isVirtual 被 normalizeMessagesForAPI 过滤，不进 LLM）
```

- `isVirtual` 的 `innerMessages` 仅 UI/history 可见（`src/utils/messages.ts:1999 normalizeMessagesForAPI` 过滤），真正进 LLM 的只有 `ContextResult` JSON。
- `REPL != SubAgent`：REPL 是主 Agent 调用的**批量工具执行器**，无二次 LLM 调用；SubAgent 是独立会话（`AgentTool/task`）。

### 5. Feature Flag 系统

通过 `bun:bundle` 的 `feature()` 函数实现编译期死代码消除：

```typescript
import { feature } from 'bun:bundle'

// 以下代码在非 KAIROS 构建中被完全消除
const assistantModule = feature('KAIROS')
  ? require('./assistant/index.js')
  : null
```

已定义的 feature flags（部分）：`VOICE_MODE`, `KAIROS`, `DAEMON`, `BRIDGE_MODE`, `COORDINATOR_MODE`, `PROACTIVE`, `AGENT_TRIGGERS`, `MCP_SKILLS`, `WORKFLOW_SCRIPTS`, `BUDDY`, `FORK_SUBAGENT`, `MONITOR_TOOL`, `WEB_BROWSER_TOOL`, `TERMINAL_PANEL` 等。

## 核心模块一览

| 目录 | 职责 |
|------|------|
| `src/entrypoints/` | 程序入口点（cli.tsx bootstrap, init.ts 初始化） |
| `src/main.tsx` | Commander CLI 定义、启动流程编排 |
| `src/commands/` | 180+ 斜杠命令（`/clear`, `/commit`, `/config`, `/friend` 等） |
| `src/commands.ts` | 命令注册中心，从各模块加载并导出命令列表 |
| `src/tools/` | 60+ AI 工具实现（Bash, Read, Edit, WebSearch, FriendEmotion 等） |
| `src/tools.ts` | 工具注册中心，`getAllBaseTools()` 与 `assembleToolPool()` |
| `src/tools/REPLTool/` | REPL 批量引擎（`engine.ts:35 ToolResult`, `engine.ts:299 ContextAggregator`, `REPLTool.ts` 透明包装） |
| `src/services/llm/` | **单轨 Native LLM Runtime**（`types.ts:22 LLMRoute`, `router/resolveRoute.ts:11`, `runtime/ModelRuntime.ts:10`, `clients/{openaiChat,anthropicMessages}.ts`, `auth/resolveAuth.ts:8`, `models/registry.ts:16`） |
| `src/services/api/queryModel.ts` | LLM 稳定 Facade（`queryModel() → modelRuntime.generate()`） |
| `src/ink/` | Ink 终端渲染引擎（自定义 fork，包含 reconciler、layout、renderer 等） |
| `src/screens/` | 主要 UI 屏幕（REPL 主屏幕、设置向导等） |
| `src/components/` | React 组件（App, PromptInput, 权限请求等） |
| `src/hooks/` | React hooks（useMergedTools, useCommandQueue, useReplBridge 等） |
| `src/friend/` | VRM 桌面伴侣服务（FriendService, SSE, TTS, VAD, STT） |
| `src/server/` | HTTP/WebSocket 服务器（API 路由、MCP、H5 访问） |
| `src/server/proxy/` | 服务端反向代理（Anthropic ↔ OpenAI 协议翻译，H5/远程备用路径） |
| `src/bridge/` | 远程桥接（WebSocket ↔ claude.ai 远程会话） |
| `src/query/` | AI 请求查询引擎（`query.ts`、`QueryEngine.ts`） |
| `src/context/` | 系统上下文构建（`context.ts`，生成系统提示词） |
| `src/services/` | 后端服务（MCP, PolicyLimits, Compact, vcr 等；LLM 相关已收敛至 `services/llm/`） |
| `src/utils/` | 工具函数（配置、认证、消息队列、权限、MCP 插件、设置等） |
| `src/state/` | 应用状态管理（AppStateStore） |
| `src/types/` | TypeScript 类型定义 |
| `src/constants/` | 常量（OAuth、产品名、提示词、工具定义等） |
| `src/voice/` | 语音模式入口（`voiceModeEnabled.ts`） |
| `src/assistant/` | 助手模式（KAIROS feature flag 守护） |
| `src/coordinator/` | 协调器模式（多 agent 协作） |
| `src/buddy/` | Buddy 子 agent 系统（BUDDY feature flag） |
| `src/daemon/` | 守护进程模式（长期运行的后台服务） |
| `src/plugins/` | 插件系统（插件发现、加载、生命周期） |
| `src/skills/` | 技能系统（用户自定义 prompt 式命令） |
| `src/tasks/` | 任务系统（LocalAgentTask, LocalShellTask, RemoteAgentTask 等） |
| `src/cli/` | CLI 工具（bg.ts 后台会话管理、templateJobs 模板任务） |
| `src/bootstrap/` | 启动状态（state.ts 导入前状态设置） |
| `src/config/` | 配置处理 |
| `src/vim/` | Vim 模式支持 |
| `src/migrations/` | 数据迁移 |
| `src/memdir/` | 记忆目录支持 |
| `src/upstreamproxy/` | 上游代理支持 |
| `src/remote/` | 远程控制支持 |
| `native-modules/` | Rust/C++ 原生模块（cpal 音频捕获等） |

## 数据流总览

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLI 进程 (Bun)                                │
│                                                                      │
│  ┌──────────┐    ┌───────────┐    ┌───────────┐    ┌──────────────┐  │
│  │ cli.tsx  │───▶│  main.tsx │───▶│  REPL.tsx │───▶│ PromptInput  │  │
│  └──────────┘    └───────────┘    └─────┬─────┘    └──────┬───────┘  │
│                                        │                  │          │
│                                        │     ┌────────────▼─────┐   │
│                                        │     │ messageQueue     │   │
│                                        │     │ Manager.enqueue  │   │
│                                        │     └────────┬─────────┘   │
│                                        │              │              │
│                                        │     ┌────────▼─────────┐   │
│                                        │     │  query() /       │   │
│                                        │     │  QueryEngine     │   │
│                                        │     └──┬────┬──────────┘   │
│                                        │        │    │               │
│                   ┌────────────────────┼────────┘    │               │
│                   │                    │             │               │
│                   ▼                    │    ┌────────▼────────┐     │
│  ┌─────────────────────────────────────┼───▶│ Tool Execution   │     │
│  │  Native LLM Runtime                 │    │ (Bash/Read/Edit   │     │
│  │  Agent → queryModel.ts → ModelRuntime    │  .../REPL 60+ tools)│  │
│  │         → resolveRoute{provider,    │    └──────────────────┘     │
│  │           protocol,model,endpoint}  │                              │
│  │         → ClientRegistry[protocol]  │                              │
│  │           ├─ openai-chat: OpenAI/   │                              │
│  │           │  OpenCode/DeepSeek 直连 │                              │
│  │           └─ anthropic-messages:    │                              │
│  │              Anthropic/NVIDIA       │                              │
│  │         + Auth(Credential) separate │                              │
│  │         + ModelRegistry(capabilities)│                             │
│  └─────────────────────────────────────┘                              │
│                                                                      │
│  ┌─────────────────────────────────────────────────┐                 │
│  │  REPL 批量引擎 (src/tools/REPLTool/engine.ts)    │                 │
│  │  callTool → ToolResult → innerMessages(isVirtual) │                 │
│  │           → ContextAggregator → ContextResult JSON → LLM API       │
│  └─────────────────────────────────────────────────┘                 │
│                                                                      │
│  ┌──────────────────────────────────────┐                            │
│  │  FriendService (同进程)              │                            │
│  │  ┌─────────┐  ┌──────────┐  ┌──────────────┐                     │
│  │  │ Silero  │  │ STT      │  │  SSE Server  │                     │
│  │  │ VAD     │──│ (Doubao/ │  │  :3456       │                     │
│  │  │ (ONNX)  │  │ Whisper) │  └──────┬───────┘                     │
│  │  └─────────┘  └──────────┘         │                             │
│  └────────────────────────────────────┼─────────────────────────────┘
│                                       │                              │
└───────────────────────────────────────┼──────────────────────────────┘
                                        │
                                        ▼
                   ┌─────────────────────────────────────┐
                   │  VRM 前端 (Web/Desktop)              │
                   │  ┌─────────────────────────────────┐ │
                   │  │  SSE → VRMScene → TextBubble    │ │
                   │  │        → EmoteController        │ │
                   │  │        → MotionController       │ │
                   │  │        → AudioPlayback          │ │
                   │  └─────────────────────────────────┘ │
                   │  HTTP POST → FriendService.sendText │ │
                   └─────────────────────────────────────┘
```

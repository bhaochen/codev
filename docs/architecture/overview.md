# 项目架构概览

## 项目定位

VersperClaw 是一个 AI CLI 智能代理，基于 Anthropic Claude Code 源代码构建，增强了对以下场景的支持：

- **VRM 桌面伴侣**（Friend）：在同一进程中运行 HTTP/SSE 服务，驱动 3D VRM 角色的表情、语音和文本气泡
- **多模型提供者**：通过反向代理层将 Anthropic Messages API 协议翻译为 OpenAI Chat/Responses API 协议，支持数十种第三方模型
- **语音对话**：基于 cpal（Rust 原生音频库）的进程内音频捕获，结合 Silero VAD（ONNX 实时语音活动检测）和多种 STT/TTS 引擎
- **自动化模式**：目标系统（Goals）、后台任务（Background Tasks）、MCP 工具集成、Feishu/Telegram Bot 桥接

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
- **其他**: `AgentTool`, `SkillTool`, `TodoWriteTool`, `ToolSearchTool`, `ConfigTool` 等

工具通过 `assembleToolPool()` 与 MCP 工具合并去重，统一提供给 AI 模型。

### 3. 多 Provider 代理

`src/server/proxy/handler.ts` 实现协议翻译反向代理：

- **输入**: CLI 以 Anthropic Messages API 格式发送请求到 `POST /proxy/v1/messages` 或 `POST /proxy/providers/:id/v1/messages`
- **转换**: `anthropicToOpenaiChat.ts` / `anthropicToOpenaiResponses.ts` 将请求体翻译为 OpenAI 格式
- **转发**: 发送到上游第三方提供商的 API
- **回传**: `openaiChatToAnthropic.ts` / `openaiResponsesToAnthropic.ts` 将响应翻译回 Anthropic 格式
- **流式**: 支持 SSE 流式响应的双向转换（`openaiChatStreamToAnthropic.ts` / `openaiResponsesStreamToAnthropic.ts`）

### 4. Feature Flag 系统

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
| `src/ink/` | Ink 终端渲染引擎（自定义 fork，包含 reconciler、layout、renderer 等） |
| `src/screens/` | 主要 UI 屏幕（REPL 主屏幕、设置向导等） |
| `src/components/` | React 组件（App, PromptInput, 权限请求等） |
| `src/hooks/` | React hooks（useMergedTools, useCommandQueue, useReplBridge 等） |
| `src/friend/` | VRM 桌面伴侣服务（FriendService, SSE, TTS, VAD, STT） |
| `src/server/` | HTTP/WebSocket 服务器（API 路由、Provider 代理、MCP、H5 访问） |
| `src/server/proxy/` | 多 Provider 反向代理（协议翻译：Anthropic ↔ OpenAI） |
| `src/bridge/` | 远程桥接（WebSocket ↔ claude.ai 远程会话） |
| `src/query/` | AI 请求查询引擎（`query.ts`、`QueryEngine.ts`） |
| `src/context/` | 系统上下文构建（`context.ts`，生成系统提示词） |
| `src/services/` | 后端服务（API client, Analytics, MCP, PolicyLimits, Compact 等） |
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
┌─────────────────────────────────────────────────────────────────────┐
│                         CLI 进程 (Bun)                               │
│                                                                     │
│  ┌──────────┐    ┌───────────┐    ┌───────────┐    ┌─────────────┐  │
│  │ cli.tsx  │───▶│  main.tsx │───▶│  REPL.tsx │───▶│ PromptInput │  │
│  │ (bootstrap)  │ (Commander)    │ (Ink UI)  │    │ (输入框)    │  │
│  └──────────┘    └───────────┘    └─────┬─────┘    └──────┬──────┘  │
│                                         │                  │        │
│                                         │     ┌────────────▼────┐  │
│                                         │     │ messageQueue    │  │
│                                         │     │ Manager.enqueue │  │
│                                         │     └────────┬────────┘  │
│                                         │              │           │
│                                         │     ┌────────▼────────┐  │
│                                         │     │   query()       │  │
│                                         │     │ (AI 请求)      │  │
│                                         │     └──┬────┬────────┘  │
│                                         │        │    │            │
│                    ┌────────────────────┼────────┘    │            │
│                    │                    │             │            │
│                    ▼                    │    ┌────────▼────────┐  │
│  ┌─────────────────────────┐           │    │  Tool Execution  │  │
│  │ Anthropic SDK (1P)      │           │    │ (Bash/Read/Edit  │  │
│  │ POST /v1/messages       │           │    │  ...等 ~60 工具) │  │
│  └─────────────────────────┘           │    └─────────────────┘  │
│                    │                    │                          │
│         ┌──────────▼──────────┐        │                          │
│         │  server/proxy/      │        │                          │
│         │  handler.ts         │        │                          │
│         │  (3P Provider 代理) │        │                          │
│         └──────────┬──────────┘        │                          │
│                    │                   │                          │
│                    ▼                   │                          │
│  ┌──────────────────────────────┐      │                          │
│  │ OpenAI Chat/Responses API    │      │                          │
│  │ (OpenAI/Groq/DeepSeek 等)    │      │                          │
│  └──────────────────────────────┘      │                          │
│                                         │                          │
│  ┌──────────────────────────────────────┼──────────────┐           │
│  │  FriendService (同进程)              │              │           │
│  │  ┌─────────┐  ┌──────────┐  ┌───────▼──────┐      │           │
│  │  │ Silero  │  │ STT      │  │  SSE Server  │      │           │
│  │  │ VAD     │──│ (Doubao/ │  │  :3456       │      │           │
│  │  │ (ONNX)  │  │ Whisper) │  └──────┬───────┘      │           │
│  │  └─────────┘  └──────────┘         │              │           │
│  │  ┌─────────┐  ┌──────────┐         │              │           │
│  │  │ TTS     │  │ EdgeTTS/ │         │              │           │
│  │  │ Audio   │──│ QwenTTS  │         │              │           │
│  │  └─────────┘  └──────────┘         │              │           │
│  └────────────────────────────────────┼──────────────┘           │
└───────────────────────────────────────┼──────────────────────────┘
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

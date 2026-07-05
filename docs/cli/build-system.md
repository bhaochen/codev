# 构建系统与功能标记架构

## 1. 构建管道

构建入口位于 `scripts/build.ts`，基于 Bun 的原生打包工具 `bun build`。整个构建流程由 `package.json` 中的 npm scripts 驱动。

### 1.1 构建模式

| 命令 | 对应脚本参数 | 输出格式 | 说明 |
| --- | --- | --- | --- |
| `bun run build` | 无 | 源码产物 (`./cli`) | 默认构建，不编译为二进制 |
| `bun run build:dev` | `--dev` | 源码产物 (`./Codev`) | 开发版本，自动附加 git SHA 和构建时间作为开发版本号 |
| `bun run build:dev:full` | `--dev --feature-set=dev-full` | 源码产物 (`./Codev`) | 开发版本，启用全部实验性功能标记 |
| `bun run compile` | `--compile` | 二进制可执行文件 (`./dist/cli`) | 生产构建，编译为 Bun 原生二进制 |
| `bun run dev` | — | 直接运行 | 通过 `bun run ./src/entrypoints/cli.tsx` 直接执行，跳过构建步骤 |

### 1.2 构建流程步骤

1. **Friend 前端构建检查**：检查 `src/components/friend/frontend/dist/index.html` 是否存在，若不存在则调用 `npm run build` 构建 VRM 头像前端（该前端基于 Vite + React + Three.js，位于 `src/components/friend/frontend/`）。
2. **版本号计算**：
   - 开发模式（`--dev`）：使用 `git rev-parse --short=8 HEAD` 获取当前 commit SHA，生成格式为 `{baseVersion}-dev.{YYYYMMDD}.t{HHmmss}.sha{commit}` 的版本号。
   - 生产模式：直接使用 `package.json` 中的版本字段 `2.1.0`。
   - 同时获取最近的 20 条 git log 作为 changelog（仅开发模式）。
3. **编译时宏定义注入**：通过 `--define` 注入 `MACRO.*` 常量（见下文 2.1 节）。
4. **Bun 打包**：调用 `bun build`，以 `./src/entrypoints/cli.tsx` 为入口，使用以下关键参数：
   - `--compile`：仅在 `compile` 模式下启用
   - `--target bun`：目标运行时为 Bun
   - `--format esm`：输出 ESM 格式
   - `--minify`：启用代码压缩
   - `--bytecode`：启用字节码缓存
   - `--packages bundle`：将所有依赖打包进产物
   - `--conditions bun`：使用 Bun 条件导出
5. **vendors 复制**：非编译模式下，将 `vendor/` 目录（包含 `audio-capture`、`opus-encdec` 等原生二进制库）复制到输出目录的 `vendor/` 子目录下。
6. **权限设置**：产物文件设置 `0o755` 可执行权限。

### 1.3 Friend VRM 前端构建集成

Friend 是桌面宠物 VRM 伴侣功能，其前端是一个独立的 Vite + React + Three.js 应用，位于 `src/components/friend/frontend/`。构建系统在主构建前检查其 `dist/` 目录是否已存在：

- 若已存在（如之前构建过），跳过前端构建步骤。
- 若不存在，自动执行 `npm run build`（调用 Vite 进行生产构建）。
- 构建产出包含 VRM 模型文件（`.vrm`）、FBX 动画文件、WASM 运行时（onnxruntime-web）、VAD 模型（silero_vad）和音效文件等静态资源。

此步骤是构建流程的**前置必要条件**——若 Friend 前端构建失败，整个构建过程退出并返回错误码 1。

### 1.4 外部依赖排除

以下 native 模块在构建时被声明为 `--external`，不会打包进最终产物，需在运行时由 Bun 动态解析：

- `@ant/*`（Anthropic 内部包）
- `audio-capture-napi`
- `image-processor-napi`
- `modifiers-napi`
- `url-handler-napi`

这些模块通过 workspace 管理或直接从 vendor 目录加载。

---

## 2. Feature Flag 系统

### 2.1 `bun:bundle` 编译时 Feature 标记

系统使用 Bun 内置的 `import { feature } from 'bun:bundle'` 实现编译时条件编译。`feature('NAME')` 是一个**编译时布尔常量**，在 `bun build` 阶段根据 `--feature=NAME` 参数确定值：

- 如果 `NAME` 在传递给 `bun build` 的 feature 集合中，`feature('NAME')` 求值为 `true`
- 否则求值为 `false`
- Bun 的打包器会对 `feature('NAME')` 条件分支进行**死代码消除**（Dead Code Elimination, DCE）

代码中典型的使用模式：

```typescript
import { feature } from 'bun:bundle'

// 编译时条件导入——false 分支在产物中完全不存在
const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default
  : null

// 编译时条件执行
if (feature('VOICE_MODE')) {
  // 启用语音模式的代码
}
```

### 2.2 Feature 传递机制

Feature 标记通过三种方式传递给构建系统：

1. **编译参数**：`bun run ./scripts/build.ts --feature=NAME`
2. **批量设置**：`--feature-set=dev-full` 启用 `fullExperimentalFeatures` 数组中的所有标记
3. **默认集合**：`defaultFeatures = ['VOICE_MODE']` 始终包含在构建中

构建脚本中的优先级逻辑：

```typescript
const defaultFeatures = ['VOICE_MODE']
const featureSet = new Set(defaultFeatures)
// 解析 --feature-set=dev-full
// 解析 --feature NAME
// 解析 --feature=NAME
```

最终所有选中的 feature 通过 `--feature=${feature}` 逐条传递给 `bun build` 命令。

### 2.3 编译时宏注入

除 `feature()` 系统外，构建脚本还通过 `--define` 注入一系列编译时常量（`MACRO.*`）。这些常量在 TypeScript 环境中通过 `env.d.ts` 声明类型：

| 宏 | 含义 | 值来源 |
| --- | --- | --- |
| `MACRO.VERSION` | 当前版本号 | `package.json` version 或开发版 git 版本 |
| `MACRO.BUILD_TIME` | 构建时间 | `new Date().toISOString()` |
| `MACRO.PACKAGE_URL` | 包 URL | `package.json` name |
| `MACRO.NATIVE_PACKAGE_URL` | 原生包 URL | 始终为 `undefined`（外部构建） |
| `MACRO.FEEDBACK_CHANNEL` | 反馈渠道 | 固定为 `'github'` |
| `MACRO.ISSUES_EXPLAINER` | Issue 说明文本 | 固定字符串 |
| `MACRO.VERSION_CHANGELOG` | 版本变更日志 | 开发模式取 git log；生产模式固定 URL |

除 `MACRO.*` 外，以下 `process.env` 变量也在构建时注入：

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `process.env.USER_TYPE` | `'external'` | 标记为外部构建（非 Anthropic 内部） |
| `process.env.CLAUDE_CODE_FORCE_FULL_LOGO` | `'true'` | 强制显示完整 logo |
| `process.env.NODE_ENV` | `'development'`（仅 dev 模式） | 运行时环境标识 |
| `process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD` | `'true'`（仅 dev 模式） | 标记为实验性构建 |
| `process.env.CLAUDE_CODE_VERIFY_PLAN` | `'false'` | 禁用计划验证 |
| `process.env.CCR_FORCE_BUNDLE` | `'true'` | 强制打包 CCR 相关代码 |

### 2.4 运行时环境变量动态配置

开发环境中，`preload.ts` 在运行时会覆盖 `MACRO` 的值，使用环境变量进行本地开发配置：

```typescript
const version = process.env.CLAUDE_CODE_LOCAL_VERSION ?? '999.0.0-local'
// ...
Object.assign(globalThis, {
  MACRO: {
    VERSION: version,
    PACKAGE_URL: packageUrl,
    NATIVE_PACKAGE_URL: packageUrl,
    BUILD_TIME: buildTime,
    FEEDBACK_CHANNEL: 'local',
    // ...
  },
})
```

### 2.5 Feature 死代码消除机制详解

`feature()` 的死代码消除分为两种形态：

**形态 A — 条件导入（模块级 DCE）**：

```typescript
const remoteControlServerCommand =
  feature('DAEMON') && feature('BRIDGE_MODE')
    ? require('./commands/remoteControlServer/index.js').default
    : null
```

当 `DAEMON` 或 `BRIDGE_MODE` 未启用时，`require()` 调用和整个依赖图（包括被导入模块的所有递归依赖）均被消除。这是最有效的 DCE 形式，可大幅减小产物体积。

**形态 B — 条件执行（语句级 DCE）**：

```typescript
if (feature('VOICE_MODE')) {
  // 语音相关逻辑
}
```

当 `VOICE_MODE` 未启用时，整个 `if` 块被消除。但被调用的模块如果已在前面的代码中被无条件导入，则仍会保留在产物中。

### 2.6 完整 Feature Flag 列表

以下是从代码库中提取的所有 `feature('NAME')` 调用，按类别分组：

#### 语音与输入

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `VOICE_MODE` | 语音模式：语音录制、流式 STT（语音转文字）、语音状态指示器、VAD（语音活动检测）；默认启用 | ~60+ 处调用 |
| `NATIVE_CLIPBOARD_IMAGE` | 原生剪贴板图片支持 | 1 |

#### 助手/Kairos 会话模式

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `KAIROS` | Kairos 助手模式：会话管理、--session-id、--continue 参数、assistant 命令/模块、团队上下文、消息队列管理、daily-log 提示词 | ~100+ 处调用（最广泛） |
| `KAIROS_BRIEF` | Brief 摘要模式：简化版助手界面、brief 命令、SendUserMessage 替代 | ~25 处调用 |
| `KAIROS_CHANNELS` | Kairos 频道/通道系统：消息通道路由 | ~8 处调用 |
| `KAIROS_PUSH_NOTIFICATION` | 推送通知功能 | ~4 处调用 |
| `KAIROS_GITHUB_WEBHOOKS` | GitHub Webhook 订阅功能（subscribe-pr 命令） | ~3 处调用 |
| `KAIROS_BRIEF` | 同上（独立用途） | — |

#### 桥接/远程控制

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `BRIDGE_MODE` | 桥接模式：CLI 与 mobile/web 客户端通信、remote-control 子命令 | ~30 处调用 |
| `CCR_AUTO_CONNECT` | CCR（Claude Code Remote）自动连接 | 2 |
| `CCR_MIRROR` | CCR 镜像模式 | ~5 处调用 |
| `CCR_REMOTE_SETUP` | 远程设置向导（web 命令） | 2 |
| `DAEMON` | 守护进程模式：daemon worker、后台长期运行 | 4 |
| `DIRECT_CONNECT` | 直接连接模式（URL/二维码直接连接） | ~8 处调用 |
| `SSH_REMOTE` | SSH 远程模式：通过 SSH 连接远程会话 | ~6 处调用 |
| `UDS_INBOX` | Unix Domain Socket 收件箱：对等节点发现、跨进程消息传递 | ~30 处调用 |

#### 协作与团队

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `COORDINATOR_MODE` | 协调者模式：多 agent 协作、任务分配、worker 管理 | ~20 处调用 |
| `TEAMMEM` | 团队记忆系统：共享记忆文件、团队上下文读取/搜索/写入 | ~25 处调用 |
| `BUDDY` | 桌面宠物伴侣：CompanionSprite 渲染、提示词注入、通知 | ~15 处调用 |
| `FORK_SUBAGENT` | 子 agent 分支：fork 命令、agent 分支执行 | ~3 处调用 |
| `AGENT_TRIGGERS` | Agent 触发器：cron 定时任务（Create/Delete/List） | ~8 处调用 |
| `AGENT_TRIGGERS_REMOTE` | 远程触发器 | ~3 处调用 |
| `AGENT_MEMORY_SNAPSHOT` | Agent 记忆快照：自定义 agent 记忆持久化 | 2 |
| `COWORKER_TYPE_TELEMETRY` | 同事类型遥测 | 1 |

#### 权限与安全

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `TRANSCRIPT_CLASSIFIER` | 转录分类器：自动模式（auto mode）、权限模式扩展、YOLO 分类器 | ~60 处调用 |
| `BASH_CLASSIFIER` | Bash 命令分类器：对 bash 命令进行安全分类、自动批准 | ~20 处调用 |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动模式 | ~3 处调用 |
| `PROACTIVE` | 主动模式：模型主动发起交互、背景任务提示 | ~25 处调用 |
| `BYOC_ENVIRONMENT_RUNNER` | BYOC 环境运行器 | 1 |
| `SELF_HOSTED_RUNNER` | 自托管运行器 | 1 |

#### 上下文管理

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `CONTEXT_COLLAPSE` | 上下文折叠：长上下文管理、413 错误处理 | ~15 处调用 |
| `CACHED_MICROCOMPACT` | 缓存微压缩：在对话流中增量压缩上下文 | ~15 处调用 |
| `COMPACTION_REMINDERS` | 压缩提醒 | 1 |
| `HISTORY_SNIP` | 历史摘要截取：SnipTool、会话上下文裁剪 | ~10 处调用 |
| `HISTORY_PICKER` | 历史选择器：对话历史浏览 | ~5 处调用 |
| `REACTIVE_COMPACT` | 响应式压缩 | 3 |
| `PROMPT_CACHE_BREAK_DETECTION` | 提示缓存断裂检测 | 3 |
| `BREAK_CACHE_COMMAND` | 缓存断裂命令 | 2 |
| `EXTRACT_MEMORIES` | 记忆提取：会话结束时的自动记忆提取 | ~10 处调用 |
| `MEMORY_SHAPE_TELEMETRY` | 记忆形状遥测 | 4 |

#### 工具

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `WORKFLOW_SCRIPTS` | 工作流脚本：WorkflowTool、workflows 命令、后台工作流任务 | ~15 处调用 |
| `MONITOR_TOOL` | 监控工具：MonitorMcpTask、后台监控 | ~8 处调用 |
| `WEB_BROWSER_TOOL` | Web 浏览器工具：基于 Bun WebView 的浏览器 | ~4 处调用 |
| `OVERFLOW_TEST_TOOL` | 溢出测试工具 | 3 |
| `TERMINAL_PANEL` | 终端面板工具 | 2 |
| `TORCH` | Torch 命令 | 2 |
| `ULTRAPLAN` | 超计划模式：增强规划能力 | ~10 处调用 |
| `ULTRATHINK` | 超思考模式 | 1 |
| `VERIFICATION_AGENT` | 验证 agent | 2 |
| `EXPERIMENTAL_SKILL_SEARCH` | 实验性技能搜索 | ~10 处调用 |
| `SKILL_IMPROVEMENT` | 技能改进反馈 | 1 |
| `TEMPLATES` | 模板系统：new/list/reply 命令 | ~6 处调用 |

#### 构建与发布

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `ABLATION_BASELINE` | 消融实验基线：设置多个环境变量 | 1 |
| `ALLOW_TEST_VERSIONS` | 允许测试版本（99.99.x） | 2 |
| `DUMP_SYSTEM_PROMPT` | 导出系统提示词（`--dump-system-prompt`） | 1 |
| `NEW_INIT` | 新的初始化流程 | 2 |

#### 用户界面

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `MESSAGE_ACTIONS` | 消息操作：消息级交互操作 | ~4 处调用 |
| `QUICK_SEARCH` | 快速搜索：PromptInput 内联搜索 | ~5 处调用 |
| `MCP_RICH_OUTPUT` | MCP 富文本输出 | 3 |
| `AUTO_THEME` | 自动主题：跟随终端主题变化 | 1 |
| `BUDDY` | 同上（见协作与团队分组） | — |

#### 内部与实验性

| Feature | 用途 | 涉及文件数 |
| --- | --- | --- |
| `ANTI_DISTILLATION_CC` | 反蒸馏保护 | 1 |
| `BG_SESSIONS` | 后台会话：ps/logs/attach/kill 命令 | ~8 处调用 |
| `BUILDING_CLAUDE_APPS` | 构建 Claude Apps 技能 | 1 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 内置探索/计划 agent | 1 |
| `CHICAGO_MCP` | Chicago MCP 协议：MCP 配置、computer-use-mcp 入口 | ~10 处调用 |
| `COMMIT_ATTRIBUTION` | 提交归属追踪 | ~4 处调用 |
| `CONNECTOR_TEXT` | Connector 文本块处理 | ~6 处调用 |
| `DOWNLOAD_USER_SETTINGS` | 下载用户设置 | 1 |
| `FILE_PERSISTENCE` | 文件持久化（public API / sessions） | 1 |
| `HARD_FAIL` | 硬失败模式 | 1 |
| `HOOK_PROMPTS` | Hook 提示词注入 | 1 |
| `IS_LIBC_GLIBC` | 检测是否使用 glibc | 1 |
| `IS_LIBC_MUSL` | 检测是否使用 musl libc | 1 |
| `LODESTONE` | LODESTONE 协议注册 | ~6 处调用 |
| `MCP_SKILLS` | MCP 技能 | 2 |
| `NATIVE_CLIENT_ATTESTATION` | 原生客户端认证 | 1 |
| `PERFETTO_TRACING` | Perfetto 性能追踪 | 1 |
| `REVIEW_ARTIFACT` | 审查构件技能 | 1 |
| `RUN_SKILL_GENERATOR` | 运行技能生成器 | 1 |
| `SHOT_STATS` | 射击统计（对话轮次分布） | 3 |
| `SLOW_OPERATION_LOGGING` | 慢操作日志 | 1 |
| `TOKEN_BUDGET` | Token 预算跟踪 | ~10 处调用 |
| `TREE_SITTER_BASH` | Tree-sitter Bash 解析器 | 1 |
| `TREE_SITTER_BASH_SHADOW` | Tree-sitter Bash 影子解析 | 1 |
| `UNATTENDED_RETRY` | 无人值守重试 | 1 |
| `UPLOAD_USER_SETTINGS` | 上传用户设置 | 1 |

### 2.7 实验性功能全集（`fullExperimentalFeatures`）

在 `scripts/build.ts` 中定义了一个`fullExperimentalFeatures` 常量数组，通过 `--feature-set=dev-full` 批量启用。完整列表：

```
AGENT_MEMORY_SNAPSHOT, AGENT_TRIGGERS, AGENT_TRIGGERS_REMOTE,
AWAY_SUMMARY, BASH_CLASSIFIER, BUDDY, BRIDGE_MODE,
BUILTIN_EXPLORE_PLAN_AGENTS, CACHED_MICROCOMPACT,
CCR_AUTO_CONNECT, CCR_MIRROR, CCR_REMOTE_SETUP,
COMPACTION_REMINDERS, CONNECTOR_TEXT, EXTRACT_MEMORIES,
HISTORY_PICKER, HOOK_PROMPTS, KAIROS_BRIEF, KAIROS_CHANNELS,
LODESTONE, MCP_RICH_OUTPUT, MESSAGE_ACTIONS, NATIVE_CLIPBOARD_IMAGE,
NEW_INIT, POWERSHELL_AUTO_MODE, PROMPT_CACHE_BREAK_DETECTION,
QUICK_SEARCH, SHOT_STATS, TEAMMEM, TOKEN_BUDGET, TREE_SITTER_BASH,
TREE_SITTER_BASH_SHADOW, TRANSCRIPT_CLASSIFIER, ULTRAPLAN, ULTRATHINK,
UNATTENDED_RETRY, VERIFICATION_AGENT, VOICE_MODE
```

注意：`VOICE_MODE` 同时出现在默认集合 `defaultFeatures` 和实验性集合中，此重复不会造成问题（Set 去重）。

---

## 3. 命令可用性门控

### 3.1 `availability` 声明

每个命令可以通过 `availability` 字段声明其适用的认证/供应商环境。`src/types/command.ts` 中定义了 `CommandAvailability` 类型：

```typescript
export type CommandAvailability =
  | 'claude-ai'   // claude.ai OAuth 订阅用户（Pro/Max/Team/Enterprise）
  | 'console'     // Console API key 用户（直接使用 api.anthropic.com）
```

可用性声明的命令示例：

```typescript
// src/commands/usage/index.ts
{ name: 'usage', availability: ['claude-ai'], ... }

// src/commands/fast/index.ts
{ name: 'fast', availability: ['claude-ai', 'console'], ... }
```

`availability` 与 `isEnabled()` 的职责分离：
- **`availability`** = 谁能使用（基于认证/供应商的静态检查）
- **`isEnabled()`** = 当前是否开启（基于 feature flags、GrowthBook、环境变量等动态条件）

不存在 `availability` 字段的命令被视为通用命令，在所有环境中可用。

### 3.2 `meetsAvailabilityRequirement()` 检查链

`src/commands.ts` 中实现了 `meetsAvailabilityRequirement()` 函数，负责检查命令是否满足可用性要求：

```typescript
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) return true  // 无限制
  for (const a of cmd.availability) {
    switch (a) {
      case 'claude-ai':
        if (isClaudeAISubscriber()) return true
        break
      case 'console':
        if (!isClaudeAISubscriber() && !isUsing3PServices() && isFirstPartyAnthropicBaseUrl())
          return true
        break
    }
  }
  return false
}
```

检查逻辑：
- **`claude-ai`**：用户通过 claude.ai OAuth 认证且为订阅用户（Pro/Max/Team/Enterprise）
- **`console`**：用户非 claude.ai 订阅用户、不使用第三方服务（Bedrock/Vertex/Foundry）、且使用官方 Anthropic API base URL

该检查在命令列表构建时执行，且**不缓存**——因为认证状态可在会话中变化（例如通过 `/login` 命令）。

### 3.3 `getCommands()` 中的过滤链

命令的最终可用性由 `getCommands()` 函数（`src/commands.ts`）计算，过滤链如下：

```typescript
const allCommands = await loadAllCommands(cwd)
const baseCommands = allCommands.filter(
  _ => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
)
```

每个命令需**同时满足**：
1. `meetsAvailabilityRequirement()` — 认证/供应商匹配
2. `isCommandEnabled()` — 命令级启用检查（可关连 feature flag 或动态条件）

### 3.4 命令级 `isEnabled()` / `isHidden()` 控制

除了全局的 feature flag 和 availability 机制，每个命令还可以单独定义 `isEnabled()` 和 `isHidden`：

**`isEnabled()` 使用示例**：

```typescript
// src/commands/voice/index.ts
{ isEnabled: () => isVoiceGrowthBookEnabled() }

// src/commands/review.ts
{ isEnabled: () => isUltrareviewEnabled() }

// src/commands/session/index.ts
{ isEnabled: () => getIsRemoteMode() }

// src/commands/extra-usage/index.ts
{ isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession() }
```

**`isHidden` 使用模式**：

```typescript
// 内部命令（外部构建中完全隐藏——这些命令的 stub 文件导出此配置）
// src/commands/share/index.js
export default { isEnabled: () => false, isHidden: true, name: 'stub' }

// 条件隐藏
// src/commands/cost/index.ts
{ get isHidden() { /* 动态条件 */ } }

// 始终隐藏
// src/commands/heapdump/index.ts
{ isHidden: true }
```

`isCommandEnabled()` 的默认值为 `true`（未定义时），`isHidden` 默认值为 `false`。

### 3.5 `USER_TYPE` 环境变量

构建时通过 `process.env.USER_TYPE` 控制内部/外部构建的差异：

- 外部构建：`USER_TYPE = 'external'`（当前版本如此设置）
- 内部构建：`USER_TYPE = 'ant'`（Anthropic 内部）

`USER_TYPE` 控制以下差异：

1. **内部命令注册**：`INTERNAL_ONLY_COMMANDS` 数组（包含 `backfillSessions`、`breakCache`、`bughunter`、`initVerifiers` 等 ~30 个内部命令）仅在 `USER_TYPE === 'ant'` 时注册。
2. **工具可用性**：`ConfigTool`、`TungstenTool`、`REPLTool` 仅在内部构建中可用。
3. **YOLO 分类器**：内部构建使用更详细的权限分类模板。

---

## 4. 工具过滤

### 4.1 `filterToolsByDenyRules()`

`src/tools.ts` 中的 `filterToolsByDenyRules()` 函数根据权限上下文中的拒绝规则过滤工具：

```typescript
export function filterToolsByDenyRules<T extends { name: string; mcpInfo?: ... }>(
  tools: readonly T[],
  permissionContext: ToolPermissionContext,
): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}
```

此过滤在工具列表最终组装前执行，确保被拒绝的工具（包括按 MCP 服务器前缀拒绝的）在模型看到之前就已移除。

### 4.2 完整工具组装流程

`getTools()` 函数（`src/tools.ts`）的组装流程：

1. **Simple 模式**（`CLAUDE_CODE_SIMPLE=1`）：仅返回 `BashTool`、`FileReadTool`、`FileEditTool`（或 REPL 模式下的 `REPLTool`），加上协调者模式所需的 `AgentTool` + `TaskStopTool`。
2. **完整模式**：通过 `getAllBaseTools()` 获取所有工具，移除特殊工具（`ListMcpResourcesTool`、`ReadMcpResourceTool`、`SYNTHETIC_OUTPUT_TOOL_NAME`）。
3. **应用拒绝规则**：`filterToolsByDenyRules()`。
4. **REPL 模式屏蔽**：当 REPL 启用时，隐藏 `REPL_ONLY_TOOLS` 集合中的原始工具。
5. **应用 `isEnabled()`**：每个工具自身的 `isEnabled()` 检查。

### 4.3 条件工具（`feature()` 门控导入）

`src/tools.ts` 中使用 `feature()` 进行条件导入的工具清单：

| Feature | 工具类 | 说明 |
| --- | --- | --- |
| `PROACTIVE` / `KAIROS` | `SleepTool` | 计划休眠工具 |
| `AGENT_TRIGGERS` | `CronCreateTool`, `CronDeleteTool`, `CronListTool` | 定时任务管理 |
| `AGENT_TRIGGERS_REMOTE` | `RemoteTriggerTool` | 远程触发器 |
| `MONITOR_TOOL` | `MonitorTool` | 监控工具 |
| `KAIROS` | `SendUserFileTool` | 发送用户文件 |
| `KAIROS` / `KAIROS_PUSH_NOTIFICATION` | `PushNotificationTool` | 推送通知 |
| `KAIROS_GITHUB_WEBHOOKS` | `SubscribePRTool` | PR 订阅 |
| `OVERFLOW_TEST_TOOL` | `OverflowTestTool` | 溢出测试 |
| `CONTEXT_COLLAPSE` | `CtxInspectTool` | 上下文检查 |
| `TERMINAL_PANEL` | `TerminalCaptureTool` | 终端捕获 |
| `WEB_BROWSER_TOOL` | `WebBrowserTool` | 浏览器工具 |
| `HISTORY_SNIP` | `SnipTool` | 历史摘要 |
| `UDS_INBOX` | `ListPeersTool` | 对等节点列表 |
| `WORKFLOW_SCRIPTS` | `WorkflowTool` | 工作流执行 |

内部构建特有的工具（不受 `feature()` 控制，受 `USER_TYPE === 'ant'` 控制）：

- `REPLTool`：REPL 交互式开发环境
- `SuggestBackgroundPRTool`：PR 建议工具
- `ConfigTool`、`TungstenTool`：内部配置工具

### 4.4 MCP 工具合并

`assembleToolPool()` 函数（`src/tools.ts`）合并内置工具和 MCP 工具：

1. 通过 `getTools()` 获取内置工具
2. 通过 `filterToolsByDenyRules()` 过滤 MCP 工具
3. 使用 `uniqBy()` 按名称去重（内置工具优先）
4. 按名称排序以保证提示缓存稳定性

---

## 5. 构建产物

### 5.1 输出目录结构

构建产物的 `dist/` 目录结构：

```
dist/
├── cli                     # 生产二进制（`--compile` 模式，~192MB）
├── cli.js                  # 生产源码产物（非编译模式，~20MB）
├── Codev             # 开发二进制（`--dev --compile` 模式，~202MB）
└── vendor/                 # 原生二进制库（仅非编译模式）
    ├── audio-capture/      # 音频捕获原生模块
    ├── audio-capture-src/  # 音频捕获源码
    └── opus-encdec/        # Opus 编码/解码
```

### 5.2 各模式产物对比

| 构建模式 | 入口文件 | 产物路径 | 大小 | 类型 |
| --- | --- | --- | --- | --- |
| `build`（默认） | `scripts/build.ts` | `./cli` | ~0（源码引用） | 源码（Bun bundle） |
| `build:dev` | `scripts/build.ts --dev` | `./Codev` | ~0（源码引用） | 源码 |
| `compile` | `scripts/build.ts --compile` | `./dist/cli` | ~192MB | Bun 编译二进制 |
| `compile + dev` | `scripts/build.ts --compile --dev` | `./dist/Codev` | ~202MB | Bun 编译二进制（调试） |

### 5.3 预加载脚本

`preload.ts` 是开发模式下的运行时预加载脚本，在执行入口文件前：
- 设置 `MACRO` 全局变量
- 设置 `CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH=1` 跳过远程预取
- 切换到调用目录（`process.chdir(CALLER_DIR)`）

### 5.4 Friend 前端静态资源

Friend VRM 前端构建产出包含大量静态资源（位于 `src/components/friend/frontend/dist/`）：

- **VRM 模型**：5 个 `.vrm` 文件（11MB-48MB 不等）
- **FBX 动画**：约 10 个动画文件（`angry.fbx`、`happy.fbx`、`greeting.fbx` 等）
- **VMD/VRMA 动作**：`jile.vmd`、`idle_loop.vrma`、`playFingers.vrma` 等
- **WASM 文件**：onnxruntime-web 运行时的多个 WASM 二进制（`ort-wasm-simd-threaded.wasm` 等，合计约 80MB）
- **VAD 模型**：`silero_vad_legacy.onnx`（1.8MB）、`silero_vad_v5.onnx`（2.3MB）
- **音效**：`jile.mp3`（4.2MB）、`love.mp3`（11MB）
- **音频工作集**：`vad.worklet.bundle.min.js`（2.5KB）
- **HTML 入口**：`index.html`

### 5.5 WASM 与原生库

项目依赖多个 WASM 和原生库：

- **onnxruntime-web**：用于语音活动检测（VAD）的推理引擎
- **audio-capture-napi**（workspace）：原生音频捕获库，通过 workspace `packages/audio-capture-napi` 管理
- **doubaoime-asr**：字节跳动豆包语音识别引擎（workspace symlink）

---

## 6. 开发工作流

### 6.1 开发模式启动

```bash
# 直接运行（无需构建，适合快速迭代）
bun run dev
# 等价于：bun run ./src/entrypoints/cli.tsx

# 开发构建 + 运行
bun run build:dev
./Codev

# 开发构建（全部实验特性）+ 运行
bun run build:dev:full
./Codev
```

### 6.2 生产构建

```bash
# 生产编译
bun run compile
# 输出：./dist/cli（~192MB 二进制）

# 测试构建
bun run build:dev:compile  # 注意：此命令需要额外添加 --compile 参数
```

### 6.3 包管理

项目使用 **Bun workspaces** 管理 monorepo：

```json
{
  "workspaces": ["packages/*"],
  "packageManager": "bun@1.3.11",
  "engines": { "bun": ">=1.3.11" }
}
```

workspace 包：

- `packages/audio-capture-napi/`：音频捕获原生 N-API 模块
- `packages/doubaoime-asr/`：豆包语音识别（symlink 到 .bun 缓存）

TypeScript 配置（`tsconfig.json`）：

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "jsx": "react-jsx",
    "types": ["bun"],
    "moduleResolution": "bundler",
    "noEmit": true,
    "strict": false,
    "skipLibCheck": true
  },
  "include": ["src", "scripts", "env.d.ts"]
}
```

### 6.4 依赖特性说明

- **运行时 UI**：基于 Ink（React for CLI）和 JSX 构建交互式终端界面
- **语音处理**：使用 `@ericedouard/vad-node-realtime`（VAD）、`node-edge-tts`（TTS）
- **AI 服务**：多供应商支持（Anthropic SDK、AWS Bedrock、Azure、Google Vertex、Groq）
- **MCP 协议**：`@modelcontextprotocol/sdk` 和 `@anthropic-ai/mcpb`
- **功能标记运行时**：`@growthbook/growthbook` 用于运行时功能开关（与编译时 `feature()` 互补）
- **WebView**：通过 Bun 内置的 `WebView` 支持 Web 浏览器工具
- **Feishu/Lark**：`@larksuiteoapi/node-sdk` 集成飞书机器人
- **Telegram**：telegram 命令集成

### 6.5 构建脚本快速参考

| 命令 | 完整脚本 |
| --- | --- |
| `bun run dev` | `bun run ./src/entrypoints/cli.tsx` |
| `bun run build` | `bun run ./scripts/build.ts` |
| `bun run build:dev` | `bun run ./scripts/build.ts --dev` |
| `bun run build:dev:full` | `bun run ./scripts/build.ts --dev --feature-set=dev-full` |
| `bun run compile` | `bun run ./scripts/build.ts --compile` |

自定义构建示例：
```bash
# 带自定义 feature 的开发构建
bun run ./scripts/build.ts --dev --feature=KAIROS --feature=BUDDY

# 编译 + 特定 feature
bun run ./scripts/build.ts --compile --feature=TRANSCRIPT_CLASSIFIER
```

# 横切关注点 — 错误处理、日志、遥测与性能

## 1. 错误处理架构

### 1.1 错误类型层次

代码库定义了一个多层级的错误类体系，所有自定义错误最终继承自 `Error`：

- **基类 `ClaudeError`** (`src/utils/errors.ts`) — 设置 `this.name = this.constructor.name`，是所有内部错误的根类。
- **中止错误** — `AbortError` 和 SDK 的 `APIUserAbortError` 通过 `isAbortError()` 统一检测；该函数也兼容 DOMException 的 `name === 'AbortError'` 模式。
- **Shell 错误** — `ShellError` 携带 `stdout`、`stderr`、`code`、`interrupted` 四个字段，用于统一处理子进程失败。
- **配置解析错误** — `ConfigParseError` 携带 `filePath` 和后备的 `defaultConfig`。
- **Axios 错误分类** — `classifyAxiosError()` 将 HTTP 客户端错误归类为 `auth`、`timeout`、`network`、`http`、`other` 五种类型。
- **遥测安全错误** — `TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 在构造时分离用户可见消息和遥测安全消息。

领域特定错误分布在各个模块中：

- `StopTaskError` (`src/tasks/stopTask.ts`) — 带有 `code` 字段区分 `not_found`、`not_running`、`unsupported_type`。
- `ToolExecutionError` — 工具执行过程中的运行时错误。
- `BridgeFatalError` / `BridgeHeadlessPermanentError` (`src/bridge/`) — Bridge 模式下的致命/永久错误。
- `CannotRetryError` / `FallbackTriggeredError` (`src/services/api/withRetry.ts`) — API 重试耗尽或模型降级时的错误。
- `McpAuthError` / `XaaTokenExchangeError` (`src/services/mcp/`) — MCP 协议认证相关错误。
- 辅助函数 `toError()`、`errorMessage()`、`shortErrorStack()`、`isFsInaccessible()` 提供了通用的错误处理基础设施。

### 1.2 工具执行错误

工具调用执行时产生的错误通过 Task 系统的 catch 边界捕获。每个 Task 类型（`LocalShellTask`、`LocalAgentTask`、`InProcessTeammateTask`）实现自己的错误处理逻辑：

- **`AbortError`** 在 agent 任务中被特殊处理 — 提取部分结果 (`extractPartialResult`) 后生成通知而非静默丢弃。Bash 任务中则静默抑制 "exit code 137" 通知以减少噪音。
- **`StopTaskError`** 区分任务不存在、未在运行和不支持的类型，让调用方可以根据 `error.code` 决定处理策略。
- **`MaxFileReadTokenExceededError`** (`src/tools/FileReadTool/`) — 文件读取超过 token 上限时抛出，触发调用方改用分块读取。
- **`SessionBranchingError`** (`src/utils/sessionBranching.ts`) — 会话分支操作失败时的特定错误。
- **`ConversationStartupError`** (`src/server/services/conversationService.ts`) — 服务器端会话恢复失败时的错误。
- 工具执行器在上层 catch 边界中将错误序列化为 `tool_result` 内容，确保 LLM 可以感知错误并调整行为。

### 1.3 模型调用错误与恢复策略

`withRetry()` (`src/services/api/withRetry.ts`) 实现了完整的 API 调用重试引擎：

- **默认最大重试次数** 为 10（可通过 `CLAUDE_CODE_MAX_RETRIES` 环境变量覆盖）。
- **错误分类**: 529 过载、429 速率限制（含 fast-mode overage）、401 认证过期、403 token 吊销、ECONNRESET/EPIPE 连接中断、400 max_tokens context overflow。
- **退避策略**: 指数退避 + 随机 jitter（`BASE_DELAY_MS * 2^(attempt-1) + jitter`），优先使用 `Retry-After` 响应头。
- **Fast Mode 降级**: 短延迟直接重试（保留 prompt cache），长延迟触发 cooldown 切换为标准速度。
- **模型降级**: 连续 3 次 529 错误后触发 `FallbackTriggeredError`，切换到 fallback 模型。
- **持久模式** (`CLAUDE_CODE_UNATTENDED_RETRY`): 无限重试 429/529，最大退避 5 分钟，6 小时上限，每 30 秒输出心跳防止会话超时。
- **背景请求不重试**: 非前台 `QuerySource`（如摘要、标题、建议）在 529 时直接放弃，避免容量级联放大。`FOREGROUND_529_RETRY_SOURCES` 集合中仅包含用户等待结果的查询源。
- **认证错误处理链**: 401/403 错误触发 OAuth token 刷新 (`handleOAuth401Error`)、AWS credential cache 清理 (`clearAwsCredentialsCache`)、GCP credential cache 清理 (`clearGcpCredentialsCache`)。CCR 模式下 401/403 被视为瞬态错误（网络抖动）而非坏凭证。
- **Context Overflow 恢复**: `parseMaxTokensContextOverflowError()` 解析 "input length and `max_tokens` exceed context limit" 错误消息，提取 `inputTokens`、`contextLimit`，自动计算调整后的 `max_tokens` 并重试。至少保留 1000 token 安全缓冲区和 3000 输出 token 下限。
- **连接池管理**: ECONNRESET/EPIPE 错误触发 `disableKeepAlive()`，在重试时创建新连接而非复用可能损坏的 keep-alive socket。
- **Mock 错误集成**: Ant 员工通过 `/mock-limits` 命令触发的模拟速率限制错误 (`checkMockRateLimitError`) 在重试引擎中受到特殊处理 — 不被视为可重试错误，确保测试场景不会进入无限重试循环。

### 1.4 致命错误 vs 可恢复错误

- **可恢复错误**: 网络抖动、速率限制、认证过期、token 吊销 — 通过重试、token 刷新、连接池禁用等机制自动恢复。
- **致命错误**: `BridgeFatalError`、`CannotRetryError`（重试耗尽后）、配置解析失败 — 需要用户干预或进程重启。

---

## 2. 日志系统

### 2.1 控制台日志与文件日志

- **`logForDebugging()`** (`src/utils/debug.ts`) — 双重输出到 stderr 和文件。支持日志级别过滤（`CLAUDE_CODE_DEBUG_LOG_LEVEL` 从 verbose 到 error），`CLAUDE_CODE_DEBUG` 环境变量启用输出。`CLAUDE_CODE_DEBUG_FILTER` 按模块名称过滤减少噪音。
- **缓冲写入**: `BufferedWriter` 模式将高频日志积累到内存缓冲区后批量写入磁盘，减少细粒度 I/O 的系统调用开销。日志文件位于 `{CLAUDE_CONFIG_HOME}/debug.log`，使用符号链接跟踪最新会话，便于快速定位当前 session 的日志。
- **`logError()`** (`src/utils/log.ts`) — 专用错误日志函数，捕获完整错误栈和结构化元数据，输出到标准错误流。
- **日志文件轮转**: 通过 `getClaudeConfigHomeDir()` 确定日志目录路径，`registerCleanup` 在进程退出时确保缓冲区排空。CLAUDE_CODE_FORCE_FULL_LOGO 等构建时常量控制日志展示格式。
- **调试过滤器**: `parseDebugFilter()` 和 `shouldShowDebugMessage()` 允许按来源模块名称精确控制哪些调试消息可见，在开发高噪音模块时可以只关注特定子系统的输出。

### 2.2 LogSelector UI 组件 (`src/components/LogSelector.tsx`)

一个功能完整的日志浏览器，提供：

- **模糊搜索** (Fuse.js) — 按会话标题、摘要、内容搜索。
- **标签分类** — 按 agent 名称、自定义标签、项目过滤。
- **树形浏览** — 按日期层级组织日志。
- **对话预览** — 在侧面板显示选中会话的摘要消息。
- **智能搜索** — 可以通过 AI 驱动的语义搜索查找相关日志。
- **分页加载** (`onLoadMore`) — 支持无限滚动。

### 2.3 诊断工具 (`/doctor` 命令 & DiagnosticsService)

- **`DiagnosticsService`** (`src/server/services/diagnosticsService.ts`) — 捕获 `console.error`、`console.warn`、`process.on('uncaughtException')`、`process.on('unhandledRejection')`，将诊断事件写入文件系统。7 天保留期，50MB 上限。
- **REST API** (`src/server/api/diagnostics.ts`) — 提供 `GET /api/diagnostics/status`、`GET /api/diagnostics/events`、`POST /api/diagnostics/export` 等端点。导出为压缩的 tar.gz，自动脱敏 API key、token 等敏感信息。
- **`DiagnosticsTrackingError`** (`src/services/diagnosticTracking.ts`) — 内部跟踪诊断事件类型的错误。

---

## 3. 遥测与分析

### 3.1 GrowthBook 集成 (`src/services/analytics/growthbook.ts`)

GrowthBook 提供 feature flags 和 A/B 测试能力：

- **远程评估**: `remoteEval: true` 模式下，服务器端评估 feature flag 值，客户端缓存到内存 (`remoteEvalFeatureValues`) 和磁盘 (`cachedGrowthBookFeatures` 在 `~/.claude.json`)。
- **用户属性**: 发送 `deviceID`、`platform`、`organizationUUID`、`accountUUID`、`subscriptionType`、`rateLimitTier` 等用于定向。
- **缓存策略**:
  - `getFeatureValue_CACHED_MAY_BE_STALE()` — 非阻塞，优先内存缓存，后备磁盘缓存，适用于启动关键路径。
  - `getDynamicConfig_BLOCKS_ON_INIT()` — 阻塞直到初始化完成（最多 5 秒超时）。
  - `checkSecurityRestrictionGate()` — 安全检查相关 gate，等待 re-init 完成以确保值新鲜。
  - `checkGate_CACHED_OR_BLOCKING()` — 磁盘缓存为 true 时快速返回，false 时等待服务器确认（避免 false 误阻止用户功能）。
- **实验曝光**: 每个 feature 在一个 session 内只记录一次曝光事件 (`loggedExposures` 去重)，通过 `logGrowthBookExperimentTo1P` 发送到第一方遥测。
- **周期刷新**: 非 Ant 构建每 6 小时刷新，Ant 构建每 20 分钟刷新。刷新时重建 `remoteEvalFeatureValues` 并同步到磁盘。
- **认证变更**: `refreshGrowthBookAfterAuthChange()` 销毁旧客户端并使用新认证头重建，防止 API key 变更后返回过期值。
- **环境变量覆盖**: Ant 员工可通过 `CLAUDE_INTERNAL_FC_OVERRIDES` 全局覆盖 feature flag（用于评估工具）。

### 3.2 遥测 Sink 架构 (`src/services/analytics/sink.ts`)

分析系统采用 sink 模式，支持热插拔遥测后端：

- **`AnalyticsSink` 接口** (`src/services/analytics/index.ts`) — 定义 `logEvent()` 同步和 `logEventAsync()` 异步方法，以及 `attachAnalyticsSink()` 注册函数。OSS 构建中所有实现体为空（no-op），降低二进制体积。
- **`initializeAnalyticsGates()` / `initializeAnalyticsSink()`** (`src/services/analytics/sink.ts`) — OSS 构建中为空函数。在完整构建中会初始化 GrowthBook 和 Datadog 后端。
- **`sinkKillswitch.ts`** — 通过 GrowthBook feature flag 在运行时动态禁用遥测发送，用于紧急情况下的数据收集开关。
- **元数据标记** — `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 类型确保只有在调用方显式声明"此元数据不包含敏感信息"时才能传递，编译期防止数据泄露。

### 3.3 第一方事件日志 (`src/services/analytics/firstPartyEventLogger.ts`)

Ant 内部构建使用第一方事件日志系统：

- **实验曝光日志**: `logGrowthBookExperimentTo1P()` 记录 A/B 实验的分组信息和用户属性。
- **批处理配置**: 通过 `tengu_1p_event_batch_config` 动态配置批量发送策略。使用 `onGrowthBookRefresh` 订阅配置变更，在运行时重建 LoggerProvider。
- **条件启用**: `is1PEventLoggingEnabled()` 检查隐私级别、用户认证状态等前置条件，只有满足所有条件时才启用。

### 3.4 Datadog (`src/services/analytics/datadog.ts`)

OSS 构建中 Datadog 遥测被禁用（`initializeDatadog` 返回 `false`，`trackDatadogEvent` 函数体为空）。接口保留以便启动代码不需要对 OSS 变体特殊处理。Datadog 用于生产环境的性能监控、错误追踪和自定义指标仪表板。

### 3.5 分析配置 (`src/services/analytics/config.ts`)

`isAnalyticsDisabled()` 在以下情况下禁用分析：NODE_ENV=test、Bedrock/Vertex/Foundry 第三方提供商、隐私级别为 no-telemetry 或 essential-traffic 模式。

### 3.6 成本与令牌用量追踪 (`src/cost-tracker.ts`)

- **全局状态**: `getTotalCostUSD()`、`getTotalInputTokens()`、`getTotalOutputTokens()`、`getTotalAPIDuration()` 等函数从 bootstrap state 读取聚合数据。
- **按模型统计**: `getUsageForModel()` 按模型名跟踪 `inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`costUSD`。
- **会话持久化**: `saveCurrentSessionCosts()` 将当前 session 的成本写入 project config；`restoreCostStateForSession()` 在恢复 session 时重建成本状态。
- **成本展示**: `formatTotalCost()` 输出格式化成本摘要（总成本、API 时长、代码变更行数、按模型的令牌使用量）。
- **exit 回调**: `useCostSummary()` (`src/costHook.ts`) 在 `process.on('exit')` 时自动输出成本摘要并保存 session 数据。

---

## 4. 性能工程

### 4.1 流式工具执行

工具执行采用流式架构（`QueryEngine` 中的 `AsyncGenerator`），LLM 输出 token 流式到达的同时，工具结果可以并行返回：

- **`QueryEngine`** 将 LLM 的流式响应解析为 `TextBlock`、`ToolUseBlock`、`ContentBlockStop` 等事件，边解析边交付给 UI 渲染。
- **工具并行**: 当 LLM 发起多个工具调用时，`tools.ts` 中的调度器可以并行执行无依赖的工具（如同时读取多个文件），减少总等待时间。流式响应持续接收新的工具调用请求。
- **前台 vs 背景**: 前台 `QuerySource`（如 `repl_main_thread`）使用完整的重试、提示缓存和速率限制逻辑；背景任务（摘要、标题生成）使用轻量级路径以减少延迟。
- **`QuerySource` 分类**: 定义在 `src/constants/querySource.ts`，包括 `repl_main_thread`、`repl_main_thread:outputStyle:custom`、`sdk`、`agent:custom`、`compact`、`hook_agent`、`auto_mode` 等 20+ 种类型，影响重试策略和日志记录。

### 4.2 提示缓存 (Prompt Caching)

- **缓存写入控制** (`skipCacheWrite`) — 某些场景（如快速诊断查询）跳过缓存写入以节省 cache creation token 成本。适用于可丢弃的中间查询，如标题生成、会话摘要等。
- **缓存读取追踪** — `cache_read_input_tokens` 和 `cache_creation_input_tokens` 通过 `cost-tracker.ts` 分模型追踪。API 响应中的 `usage.cache_read_input_tokens` 和 `usage.cache_creation_input_tokens` 字段在 `addToTotalSessionCost()` 中累加。
- **Fast Mode 缓存保留** — 在 fast mode 中，短延迟重试使用相同的模型名以保留 prompt cache（减少 cache creation 消耗）；长延迟触发 cooldown 切换到标准模型时，失去缓存被视为可接受成本。
- **Cache Break Detection** (`PROMPT_CACHE_BREAK_DETECTION` feature flag) — 监控和检测 prompt cache 命中率异常下降的场景，帮助诊断缓存失效原因。
- **成本核算**: `calculateUSDCost()` 函数根据模型单价、输入/输出/cache read/cache creation token 用量计算精确成本。未知模型通过 `hasUnknownModelCost()` 标记。

### 4.3 上下文预取

- **内存预取**: `memory` 系统在 agent 启动时主动从磁盘加载相关记忆片段。
- **技能预取**: `skills` 系统预加载已启用的技能描述和工具定义。
- **推测执行** (`SpeculationState`): 在用户输入到达之前，系统可以推测性地启动任务执行。

### 4.4 令牌估算

`getContextWindowForModel()` 和 `getModelMaxOutputTokens()` 提供按模型的上下文窗口和输出上限。`parseMaxTokensContextOverflowError()` 解析 API 返回的 context overflow 错误并自动调整 `max_tokens` 参数。

### 4.5 速率限制模拟 (`src/services/rateLimitMocking.ts`)

Ant 员工可以通过 `/mock-limits` 命令模拟各种速率限制场景（429、529、fast-mode cooldown），用于测试 UI 行为和恢复逻辑。与 `withRetry()` 集成，确保模拟错误不触发真实重试。

### 4.6 背景任务卸载

在 stop hooks 中使用 fire-and-forget 模式（`void` 前缀 + `.catch()`），确保关键路径不被背景任务阻塞。例如：`LogSelector.tsx` 中的日志写入、`onChangeAppState` 中的 side-effect 通知。

---

## 5. 跨组件通信模式

### 5.0 Signal 模式 (`src/utils/signal.ts`)

`createSignal<T>()` 提供轻量级的事件信号原语，与 Store 不同，Signal 不持有状态快照，仅用于通知"某事发生了"：

- **订阅/取消**: `subscribe(listener)` 返回取消函数，与 React useEffect 的 cleanup 模式天然兼容。
- **类型安全**: 通过泛型 `Args` 指定事件参数类型。
- **去重**: `clear()` 移除所有监听器，用于 dispose 和 reset 路径。
- **使用场景**: GrowthBook 刷新通知 (`refreshed` signal)、设置变更通知、`onChangeAppState` 中的事件广播。
- **与 Store 的区别**: Signal 无 `getState()`，不存储值，仅做事件通知。在代码库中替换了 ~15 处重复的 `new Set<Listener>()` + `subscribe/notify` 模式。

## 6. 状态管理性能

### 6.1 AppState 可观察存储 (`createStore` 模式)

`createStore<T>()` (`src/state/store.ts`) 是一个轻量级不可变状态存储，模式灵感来源于 Redux 但更简洁：

- `getState()` — O(1) 引用读取，无任何开销。
- `setState(updater)` — 接收 `(prev: T) => T` 更新函数。通过 `Object.is` 做引用相等性检查，避免无变更时通知监听器。`onChange` 回调在每次有效状态变更时同步触发，接收 `{ newState, oldState }` 上下文。
- `subscribe(listener)` — 基于 `Set<Listener>` 的发布-订阅，返回取消订阅函数。无额外分配。
- `AppStateStore` 类型 (`src/state/AppStateStore.ts`) 继承自 `Store<AppState>`，添加了 `AppState` 的默认值工厂函数 `getDefaultAppState()`。完整的 AppState 包含 `tasks`、`toolPermissionContext`、`settings`、`isUltraplanMode`、`viewingAgentTaskId` 等顶级字段。
- **不可变性保证**: `setState` 使用 updater 函数模式，每次变更产生新的状态对象。React 渲染层依赖引用相等性进行短路优化。

### 6.2 onChangeAppState 副作用处理器 (`src/state/onChangeAppState.ts`)

一个集中式 `onChange` 处理器，在 AppState 变更时协调跨系统的副作用：

- 权限模式同步（CCR/SDK）
- 会话元数据变更通知
- 设置变更应用 (`applySettingsChange`)
- API key 缓存清理

这种模式避免了 React 组件中散落的 `useEffect` 链，让状态变更的副作用可预测且可测试。

### 6.3 Selector 模式 (`src/state/selectors.ts`)

纯函数选择器从 AppState 派生计算状态：

- `getViewedTeammateTask()` — 提取当前查看的 teammate 任务
- `getActiveAgentForInput()` — 确定用户输入路由目标（leader / viewed / named_agent）

选择器保持轻量、无副作用，便于组合和测试。

### 6.4 React Context 订阅

`AppStateProvider` (`src/state/AppState.tsx`) 使用 React Context + `useSyncExternalStore` 将存储桥接到 React 渲染周期。`VoiceProvider` 通过 `feature('VOICE_MODE')` 进行死代码消除 — 外部构建中它是一个无操作的包裹器。`useSettingsChange` hook 监听设置文件变更并增量更新状态。

---

## 7. 构建优化

### 7.1 Feature Flag 死代码消除 (`bun:bundle feature()`)

Bun 的编译时 `feature()` 函数允许在构建阶段消除未使用的代码分支：

- `scripts/build.ts` 定义了完整的实验特性列表（如 `VOICE_MODE`、`AGENT_MEMORY_SNAPSHOT`、`BASH_CLASSIFIER` 等 50+ 个 flag）。
- 外部构建默认只启用 `VOICE_MODE`。
- 构建命令 `bun build --feature=<flag>` 将 feature flag 注入编译步骤，未启用的分支在 tree-shaking 中被完全移除。
- 这使得 ant-internal 代码可以直接嵌入仓库，而外部构建不携带任何内部逻辑。

### 7.2 React Compiler 输出 (`src/components/LogoV2/`)

`LogoV2/` 目录中的组件（`LogoV2.tsx`、`AnimatedClawd.tsx`、`Feed.tsx`、`WelcomeV2.tsx` 等）使用了 React Compiler (`react/compiler-runtime`) 自动记忆化输出。编译器将 `useMemo`/`useCallback` 模式自动化，减少手动优化的工作量。

### 7.3 WASM 二进制文件

VAD（Voice Activity Detection）服务 (`src/friend/voice/vad-service.ts`) 使用 `onnxruntime-web` 的 WASM 后端（而非 `onnxruntime-node` 原生插件），因为 Bun 不支持 Node-API 原生插件。WASM 二进制文件 (`onnxruntime-web`) 随 dist 打包。

### 7.4 Build 脚本 (`scripts/build.ts`)

构建管道使用 Bun 原生打包器，生成单一可执行文件：

1. **预构建 Friend VRM 前端**: 检查 `src/components/friend/frontend/dist/index.html` 是否存在，不存在时执行 `npm run build`。
2. **主构建**: 使用 `bun build --compile --target bun --minify --bytecode` 生成单个可执行文件。`--minify` 减小二进制体积，`--bytecode` 编译为 Bun 字节码提升启动速度。
3. **编译时常量注入**:
   - `MACRO.VERSION` — 语义版本号（开发版附加 git SHA 和时间戳）。
   - `MACRO.BUILD_TIME` — ISO 8601 构建时间戳。
   - `MACRO.FEEDBACK_CHANNEL` — 反馈渠道（OSS 构建为 `github`）。
   - `MACRO.VERSION_CHANGELOG` — 最近的 git commit 日志或指向 GitHub 的 URL。
4. **外部模块排除**: `@ant/*`、`audio-capture-napi`、`image-processor-napi`、`modifiers-napi`、`url-handler-napi` 通过 `--external` 排除捆绑，减小二进制体积并允许运行时加载原生模块。
5. **环境变量定义**: `process.env.USER_TYPE='external'`、`process.env.CLAUDE_CODE_FORCE_FULL_LOGO='true'`、`process.env.CCR_FORCE_BUNDLE='true'` 等定义确保构建产物运行于正确模式。
6. **完整特性集**: 使用 `--feature-set=dev-full` 启用全部实验特性（50+ feature flags），默认仅启用 `VOICE_MODE`。
7. **输出产物**: 开发版本输出到 `./Codev`，发布版本输出到 `./dist/cli`。

---

## 8. 资源管理

### 8.1 子进程管理

- **音频采集** (`arecord` / `sox`) — 通过 `child_process.spawn` 管理，采样率 16kHz，16-bit PCM。
- **Whisper STT** (`src/services/voice/whisperSTT.ts`) — 本地语音识别子进程，管理其生命周期并处理输出解析。
- **Tauri 子进程** — 在 Friend 桌面模式下启动和管理 Tauri shell 进程。
- **子进程超时** — `RipgrepTimeoutError`、`StallTimeoutError` 确保子进程不会无限期挂起。`cleanupRegistry.ts` 注册进程清理回调，在优雅关闭时统一终止。

### 8.2 定时器和超时

- **GrowthBook 周期刷新** — `setupPeriodicGrowthBookRefresh()` 使用 `setInterval`（非 Ant: 6h，Ant: 20min），`unref()` 保证不阻止进程退出。
- **API 重试退避** — `sleep()` + `AbortSignal` 组合，支持中途取消。
- **持久重试心跳** — 每 30 秒输出系统消息防止空闲超时。
- **优雅关闭** — `gracefulShutdown.ts` 中的 `CleanupTimeoutError` 确保关闭过程不会无限阻塞。

### 8.3 优雅关闭与清理注册表

`cleanupRegistry.ts` 和 `gracefulShutdown.ts` 实现了进程级资源清理系统：

- **`registerCleanup()`** (`src/utils/cleanupRegistry.ts`) — 全局 `Set<() => Promise<void>>` 注册表。任何模块可以注册异步清理函数，返回取消注册函数。`runCleanupFunctions()` 使用 `Promise.all` 并行执行所有清理任务。
- **`gracefulShutdown()`** (`src/utils/gracefulShutdown.ts`) — 主关闭流程，按顺序执行：
  1. `onExit('signal-exit')` 捕获 SIGTERM/SIGINT，设置 `isShuttingDown` 标志。
  2. 同步恢复终端模式（退出 alt screen、恢复光标、禁用 mouse tracking、恢复 Kitty 键盘模式）。
  3. `runCleanupFunctions()` 并行运行所有注册的异步清理。
  4. 关闭 Datadog（`shutdownDatadog()`）和第一方事件日志。
  5. 最终日志发送（会话成本、诊断事件）。`CleanupTimeoutError` 防止清理阶段无限阻塞。

### 8.4 文件句柄管理

- **SSE 客户端** — EventSource 连接在设置/清理生命周期中管理，使用 `AbortController` 确保断开。
- **音频文件** — 语音录制生成临时 WAV 文件，`FriendService` 负责生命周期管理。
- **调试日志** — `BufferedWriter` 管理文件写入，`registerCleanup` 注册关闭回调。
- **诊断事件** — `DiagnosticsService` 使用文件系统存储诊断事件，7 天保留期和 50MB 上限防止磁盘膨胀。

### 8.5 VAD 内存状态管理

`SileroVad` (`src/friend/voice/vad-service.ts`) 在 ONNX 推理会话中维护 LSTM 状态张量 (`stateH`、`stateC`)。每个音频帧（512 采样 / 32ms）处理后更新状态。关键优化：

- **RMS 能量过滤**: 低于 `rmsThreshold`（默认 ~-48dBFS）的帧跳过 ONNX 推理，直接视为静音。在高噪声环境中可以减少约 60% 的推理次数。
- **状态重置**: `reset()` 方法清空 LSTM 状态和累积缓冲区，用于会话间清理。
- **预处理触发**: `preSpeechTriggerFrames`（默认 10 帧 / 320ms）过滤短时噪音爆发，避免误触发。

---

## 架构决策记录

| 决策 | 理由 |
|------|------|
| 错误使用 `class extends Error` 并显式设置 `this.name` | 确保压缩构建中 `instanceof` 失效时仍可通过 `name` 属性识别错误类型 |
| 重试引擎使用 generator (`yield`) | 允许在重试间隔中间向调用方输出系统消息（心跳、进度） |
| GrowthBook 使用 `remoteEval: true` | 服务器端评估避免客户端下载完整规则集，减少网络负载和延迟 |
| VAD 使用 WASM 而非原生插件 | 兼容 Bun 运行时（Node-API 原生插件在 Bun 中导致 segfault） |
| 选择器使用纯函数而非 memoized selector | AppState 不可变性保证引用相等性检查足够高效，不需要额外记忆化开销 |
| Feature flag 死代码消除在构建时而非运行时完成 | 显著减小外部构建的二进制体积，消除内部代码泄漏风险 |
| Datadog / 遥测在 OSS 构建中默认禁用 | 保持开放源代码版本的隐私友好特性，同时保持接口兼容性 |

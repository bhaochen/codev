# 后端服务

VersperClaw 提供一系列后台服务，涵盖 MCP 集成、上下文压缩、自主记忆整合、即时通讯集成、OAuth 认证、分析监控及工具执行引擎。

---

## MCP (Model Context Protocol)

**目录**: `src/services/mcp/`

MCP 客户端实现，基于 `@modelcontextprotocol/sdk`，支持多种传输层协议和 OAuth 认证。

### 核心文件

| 文件 | 描述 |
|------|------|
| `client.ts` | MCP 客户端 — 支持 Stdio、SSE、Streamable HTTP 三种传输协议；管理工具/资源/命令的发现与调用 |
| `auth.ts` | MCP OAuth 认证 — 基于 Authorization Server Metadata 发现流程，支持 PKCE、令牌刷新、本地 HTTP 服务器捕获授权码 |
| `config.ts` | MCP Server 配置解析 |
| `types.ts` | MCP 相关类型定义 |
| `InProcessTransport.ts` | 同进程传输层实现 |
| `SdkControlTransport.ts` | SDK Control 传输层 |
| `normalization.ts` | MCP 结果规范化 |
| `envExpansion.ts` | 环境变量展开 |
| `headersHelper.ts` | HTTP 头部辅助 |
| `elicitationHandler.ts` | MCP Elicit 请求处理 |
| `mcpStringUtils.ts` | MCP 字符串工具 |
| `claudeai.ts` | Claude AI 集成 |
| `officialRegistry.ts` | 官方 MCP 注册表 |
| `useManageMCPConnections.ts` | MCP 连接管理 Hook |
| `vscodeSdkMcp.ts` | VSCode SDK 兼容层 |
| `channelAllowlist.ts` / `channelPermissions.ts` / `channelNotification.ts` | 频道权限与通知 |
| `MCPConnectionManager.tsx` | MCP 连接管理器 UI 组件 |
| `xaa.ts` / `xaaIdpLogin.ts` | XAA 身份提供方登录 |
| `oauthPort.ts` | OAuth 回调端口管理 |

### 支持的传输协议

1. **StdioClientTransport** — 子进程标准输入/输出
2. **SSEClientTransport** — Server-Sent Events
3. **StreamableHTTPClientTransport** — 可流式 HTTP

### 发现能力

工具（Tools）、资源（Resources）、提示（Prompts）的自动发现与调用。

---

## 上下文压缩

**目录**: `src/services/compact/`

上下文压缩引擎，在对话历史超出上下文窗口时自动触发压缩，将冗长的历史会话压缩为精炼的摘要。

### 核心文件

| 文件 | 大小 | 描述 |
|------|------|------|
| `compact.ts` | 61 KB | **核心压缩引擎** — 将对话历史压缩为摘要，包含完整的压缩策略与边界消息管理 |
| `autoCompact.ts` | — | **自动压缩** — 当上下文窗口使用量超过阈值时自动触发压缩，管理 maxTokens、重试逻辑、token 估算 |
| `microCompact.ts` | — | **微压缩** — 细粒度工具结果压缩，仅压缩特定工具（FileRead、FileEdit、FileWrite、Glob、Grep、WebFetch、WebSearch 等）的输出 |
| `sessionMemoryCompact.ts` | — | **会话记忆压缩** — 实验性功能，将会话记忆压缩整合到会话恢复流程中 |
| `cachedMicrocompact.ts` | — | 缓存式微压缩，提升重复压缩效率 |
| `cachedMCConfig.ts` | — | 缓存微压缩配置 |
| `snipCompact.ts` / `snipProjection.ts` | — | 截断式压缩与投影 |
| `grouping.ts` | — | 消息分组策略 |
| `reactiveCompact.ts` | — | 响应式压缩 |
| `timeBasedMCConfig.ts` | — | 基于时间的微压缩配置 |
| `postCompactCleanup.ts` | — | 压缩后清理 |
| `prompt.ts` | — | 压缩提示词模板 |
| `apiMicrocompact.ts` | — | API 微压缩接口 |
| `compactWarningHook.ts` / `compactWarningState.ts` | — | 压缩警告 UI 状态管理 |

### 压缩流程

1. `autoCompact` 监控上下文窗口使用率
2. 当超过阈值时，调用 `compactConversation()`（在 `compact.ts` 中）
3. 压缩引擎提取历史消息，调用 AI 生成摘要
4. 摘要替换原始历史消息，压缩边界消息标记范围
5. `sessionMemoryCompact` 可选地将会话记忆额外压缩
6. `microCompact` 对工具结果进行细粒度压缩以进一步节省 token
7. `postCompactCleanup` 执行压缩后清理

---

## Auto Dream (自主记忆整合)

**目录**: `src/services/autoDream/`

Auto Dream 是一个后台记忆整合系统，在对话间期自动运行，将学习到的信息整理为持久化的记忆文件。

### 核心文件

| 文件 | 描述 |
|------|------|
| `autoDream.ts` | 主模块 — 后台记忆中整合，使用 `runForkedAgent` 执行 `/dream` 提示词。使用三道门控（Gate）按成本递增顺序判断是否执行：时间（距上次整合 >= minHours）、会话数（新会话 >= minSessions）、锁（无其他进程正在整合） |
| `config.ts` | 配置 — 是否启用 Auto Dream |
| `consolidationLock.ts` | 整合锁 — 基于 PID 和 mtime 的文件锁，防止多个进程同时整合。锁文件位于记忆目录，mtime 作为 `lastConsolidatedAt` 时间戳 |
| `consolidationPrompt.ts` | 整合提示词 — 构建 `/dream` 的系统提示词，指导 AI 反思记忆文件并整理为持久化知识 |

### 门控顺序

1. **时间门控**: 距上次整合 >= 最小小时数（一个 stat 调用，最便宜）
2. **会话门控**: 新产生的会话记录数 >= 最小会话数
3. **锁门控**: 无其他进程正在进行整合（最昂贵）

### 整合内容

- 回顾记忆目录中的 `.md` 文件
- 分析近期会话记录（transcript）
- 合成新的记忆，整理现有知识
- 确保记忆文件对后续会话具有良好可读性

---

## 飞书集成

**目录**: `src/services/feishu/`

飞书机器人集成，基于 `@larksuite/channel` SDK。

### 核心文件

| 文件 | 描述 |
|------|------|
| `FeishuService.ts` | 飞书机器人服务 — 创建 LarkChannel、注册应用、处理消息事件、管理聊天模式、引用回复、保活机制 |
| `feishuConfig.ts` | 配置管理 — 读写 `~/.claude/adapters.json` 中的飞书配置段；管理已配对用户、授权用户白名单、Group 模式设置 |
| `vendor/` | 自包含的第三方实现模块（核心日志、机器人 pending 队列、保活、引用回复、访问策略） |

### 功能

- 应用注册与事件处理
- DM 私聊白名单
- Group 群聊模式
- 引用上下文回复
- 管理员权限控制
- 自动保活（Keepalive）

---

## Telegram 集成

**文件**: `src/services/telegram/TelegramService.ts`

Telegram 机器人服务，基于 Telegram Bot API 实现消息收发、指令处理、行内键盘等功能。

### 功能

- `getMe` — 获取机器人信息
- `sendMessage` — 发送消息（支持 Markdown / HTML 格式）
- `editMessageText` — 编辑已发送消息
- `answerCallbackQuery` — 响应回调查询
- `sendChatAction` — 发送聊天动作指示器
- `setMyCommands` — 设置机器人命令列表
- `getUpdates` — 轮询获取更新

配置管理: `telegramConfig.ts` / `telegramTypes.ts`

---

## OAuth

**目录**: `src/services/oauth/`

通用 OAuth 2.0 认证服务，支持授权码流程（Authorization Code Flow with PKCE）。

### 核心文件

| 文件 | 描述 |
|------|------|
| `index.ts` | `OAuthService` — 主类，管理完整 OAuth 流程：生成 code_verifier、启动本地 HTTP 服务器监听回调、令牌交换 |
| `auth-code-listener.ts` | 授权码监听器 — 启动本地 HTTP 服务器捕获回调中的授权码 |
| `client.ts` | OAuth 客户端 HTTP 请求封装 |
| `crypto.ts` | PKCE 加密工具 — code_verifier / code_challenge 生成 |
| `getOauthProfile.ts` | 获取 OAuth 用户档案 |
| `types.ts` | OAuth 类型定义（令牌、速率限制、订阅类型等） |

### 流程

1. 生成 PKCE code_verifier 和 code_challenge
2. 构建授权 URL 并打开浏览器
3. 本地 HTTP 服务器监听回调 / 用户手动粘贴授权码
4. 用授权码换取令牌（access_token + refresh_token）
5. 支持令牌刷新和持久化

---

## 分析 (Analytics)

**目录**: `src/services/analytics/`

### 核心组件

| 文件 | 描述 |
|------|------|
| `index.ts` | 分析日志入口 — 标准化事件日志接口 |
| `growthbook.ts` | GrowthBook 特性标记集成 — 远程配置和 A/B 测试功能开关 |
| `config.ts` | Analytics 配置 |
| `metadata.ts` | 分析元数据提取 — 工具名称脱敏、MCP 工具详情、文件扩展名 |
| `datadog.ts` | Datadog 集成 |
| `firstPartyEventLogger.ts` / `firstPartyEventLoggingExporter.ts` | 第一方事件日志与导出 |
| `sink.ts` / `sinkKillswitch.ts` | 事件接收器与终止开关 |

### 功能

- 工具使用统计与耗时追踪
- 模型调用分析
- GrowthBook 远程特性配置
- Datadog APM 集成

---

## 工具执行引擎

**目录**: `src/services/tools/`

### 核心文件

| 文件 | 大小 | 描述 |
|------|------|------|
| `toolExecution.ts` | 60 KB | **工具执行引擎** — 核心工具运行逻辑，管理工具调用生命周期、权限检查、进度报告、结果处理 |
| `toolHooks.ts` | — | **工具钩子系统** — 执行 Pre-Tool 和 Post-Tool 挂钩，支持基于规则和基于审批的权限决策 |
| `StreamingToolExecutor.ts` | — | **流式工具执行器** — 管理并发工具执行队列，支持工具状态追踪（queued / executing / completed / yielded），支持进度消息即时推流 |
| `toolOrchestration.ts` | — | **工具编排** — 高级工具调度与编排逻辑 |

### 工具执行流程

1. **Pre-Tool Hooks**: 权限检查、规则匹配、审批流程
2. **工具调用**: 查找工具定义 -> 执行 -> 收集结果
3. **Post-Tool Hooks**: 结果处理、日志记录、统计更新
4. **Streaming**: 支持并发工具执行，进度实时推送

# 桌面 HTTP/WebSocket 服务器

## 概述

Codev 桌面服务器是一个同进程 HTTP + WebSocket 服务器，基于 **Bun.serve()** 运行，为 Tauri 桌面应用提供全套 API 接口。服务器与 CLI 子进程通过 SDK WebSocket Bridge 通信，桌面 UI 通过客户端 WebSocket 与服务器交互。

- **入口文件**: `src/server/server.ts`
- **运行时**: Bun (JavaScript/TypeScript 运行时)
- **默认端口**: 3456
- **架构**: 单进程，HTTP + WebSocket 共存

## 路由系统

路由定义在 `src/server/router.ts`。所有 API 请求统一由 `handleApiRequest()` 函数处理，根据 URL 路径第二段（resource）分发到对应的 API handler。

当前支持约 **28 个 API 资源路径**，每个 handler 部署在 `src/server/api/` 目录下独立的文件中。

## API 端点

### 会话管理

| 路径 | 描述 |
|------|------|
| `/api/sessions` | 会话 CRUD — 创建、读取、更新、删除会话 |
| `/api/sessions/:id/chat/*` | 会话内的对话操作（由 conversations handler 处理） |

对应文件: `api/sessions.ts`

### 对话管理

| 路径 | 描述 |
|------|------|
| `/api/conversations` | 对话 CRUD — 会话消息的读写管理 |

对应文件: `api/conversations.ts`

### 模型配置

| 路径 | 描述 |
|------|------|
| `/api/models` | 获取可用模型列表 |
| `/api/models/current` | 获取/切换当前选中的模型 |
| `/api/effort` | 获取/设置 Effort 等级（low / medium / high / max） |

对应文件: `api/models.ts`

### 设置与权限

| 路径 | 描述 |
|------|------|
| `/api/settings` | 应用设置读写 |
| `/api/permissions` | 权限配置（由 settings handler 处理） |

对应文件: `api/settings.ts`

### MCP

| 路径 | 描述 |
|------|------|
| `/api/mcp` | MCP 服务器管理 — 连接配置与状态 |

对应文件: `api/mcp.ts`

### 插件与技能

| 路径 | 描述 |
|------|------|
| `/api/plugins` | 插件管理 — 安装、卸载、更新、启用/禁用 |
| `/api/skills` | 技能管理 |

对应文件: `api/plugins.ts`, `api/skills.ts`

### 诊断

| 路径 | 描述 |
|------|------|
| `/api/doctor` | 环境诊断 — 检查系统配置是否正常 |
| `/api/diagnostics` | 诊断事件记录与查询 |

对应文件: `api/doctor.ts`, `api/diagnostics.ts`

### 好友系统

| 路径 | 描述 |
|------|------|
| `/api/friend` | VRM 虚拟形象前端路由（由 Tauri 桌面应用调用），包含 TTS/STT、SSE、偏好设置等 |

路由定义在单独模块中（非 router.ts 直接管理），对应文件: `api/friend.ts`

### 文件与工作区

| 路径 | 描述 |
|------|------|
| `/api/filesystem` | 文件系统访问操作 |
| `/api/workspaces` | Git 工作区管理（会话工作区创建、差异查看等） |

对应文件: `api/filesystem.ts`（filesystem 由专用路由函数处理）

### 其他端点

| 路径 | 描述 |
|------|------|
| `/api/scheduled-tasks` | 定时任务管理 |
| `/api/search` | 搜索 |
| `/api/agents` / `/api/tasks` | Agent 任务管理 |
| `/api/status` | 服务器状态查询 |
| `/api/teams` | 团队配置 |
| `/api/adapters` | 适配器管理 |
| `/api/computer-use` | [Computer Use 功能控制](computer-use.md) — 环境检测、Python venv 安装、桌面控制 |
| `/api/haha-oauth` | haha 自定义 OAuth 认证 |
| `/api/haha-openai-oauth` | haha OpenAI OAuth 认证 |
| `/api/h5-access` | H5 访问策略 |
| `/api/activity-stats` | 活动统计 |
| `/api/open-targets` | OpenTarget 管理 |
| `/api/memory` | 记忆管理 |
| `/api/desktop-ui` | 桌面 UI 偏好 |
| `/api/cli-auth` | CLI 认证 |
| `/api/cli-proxy` | CLI 代理 |

## WebSocket

**文件**: `ws/handler.ts` (约 68KB)

WebSocket 连接处理器管理完整的连接生命周期：

- **会话管理**: 创建、启动、停止、清理会话
- **消息路由**: 将用户消息通过 CLI 子进程（stream-json 模式）处理
- **命令处理**: 解析和处理斜杠命令（slash command）
- **权限控制**: Computer Use 审批、运行时覆盖
- **自动标题**: 追踪用户消息计数，自动生成对话标题
- **会话预热**: 预启动空闲会话以加快响应
- **断线重连**: 客户端断线后保持会话 5 分钟，支持重连
- **消息转换**: CLI stdout 消息转换为 ServerMessage 并转发到 WebSocket

消息协议定义在 `ws/events.ts`，包含 `ClientMessage` 和 `ServerMessage` 类型。

## 服务层

所有后端服务部署在 `src/server/services/` 目录下：

### conversationService.ts
CLI 子进程管理器。每个桌面会话拥有一个 CLI 子进程，子进程通过 SDK WebSocket Bridge 与桌面服务器通信。

### sessionService.ts
会话 CRUD 操作封装。读写 CLI 持久化在 `~/.claude/projects/{path}/{sessionId}.jsonl` 的会话数据，确保桌面应用与 CLI 数据完全互通。使用 SQLite 间接管理会话索引。

### workspaceService.ts
Git 工作区管理。支持差异查看、文件历史快照、会话工作区初始化等功能。

### pluginService.ts
插件管理系统。支持安装、卸载、更新、启用/禁用插件，管理 MCP 服务器集成与 LSP 服务器集成。

### cronScheduler.ts
Cron 任务调度引擎。定期检查所有定时任务，在匹配 cron 表达式时通过 CLI 子进程执行任务，执行历史持久化到 `~/.claude/scheduled_tasks_log.json`。

### desktopCliLauncherService.ts
桌面 CLI 启动器。负责安装和管理 `claude-haha` CLI 命令，维护 PATH 环境变量。

### 其他服务

- `diagnosticsService.ts` / `doctorService.ts`: 系统诊断
- `searchService.ts`: 搜索服务
- `titleService.ts`: 对话标题自动生成
- `taskService.ts`: 任务管理
- `teamService.ts` / `teamWatcher.ts`: 团队协作
- `notificationService.ts`: 桌面通知
- `networkSettings.ts`: 网络代理设置
- `managedSettingsService.ts`: 托管设置
- `h5AccessService.ts`: H5 访问策略
- `computerUseApprovalService.ts`: Computer Use 审批
- `mcpHostPreflight.ts`: MCP 预检
- `attributionHeaderPolicy.ts`: 归因头策略
- `agentService.ts`: Agent 服务
- `adapterService.ts`: 适配器服务
- `openaiOfficialProvider.ts`: OpenAI 官方提供商
- `hahaOAuthService.ts` / `hahaOpenAIOAuthService.ts`: OAuth 认证
- `repositoryLaunchService.ts`: 仓库启动（Git worktree 集成）
- `filesystemAccessRoots.ts`: 文件系统访问根目录
- `recoverableJsonFile.ts`: 可恢复 JSON 文件读写
- `persistentStorageMigrations.ts`: 持久化存储迁移

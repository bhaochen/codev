# 远程桥接 / Remote Control

## 概述

Bridge（桥接）模式将本地 CLI 连接到 Anthropic 的远程会话基础设施（CCR, Claude Code Remote），使用户可以通过 claude.ai/code 从浏览器控制本地终端。

---

## 两种传输模式

### 1. 基于环境 (env-based)

通过 Environments API 进行 poll/dispatch：

1. CLI 注册为一个 "环境"（environment）到 Anthropic 服务器
2. 服务器通过 `pollForWork` API 分发工作
3. 客户端领取（acknowledge）工作、执行、发送心跳、返回结果

**核心 API（`src/bridge/bridgeApi.ts`）**：

| 端点 | 方法 | 用途 |
|------|------|------|
| `POST /v1/environments/bridge` | registerBridgeEnvironment | 注册当前终端为可用的执行环境 |
| `GET .../work/poll` | pollForWork | 轮询待处理的工作 |
| `POST .../work/{id}/ack` | acknowledgeWork | 确认领取工作 |
| `POST .../work/{id}/heartbeat` | heartbeatWork | 发送心跳（延长租约） |
| `POST .../work/{id}/stop` | stopWork | 停止工作 |
| `DELETE .../environments/bridge/{id}` | deregisterEnvironment | 注销环境 |

**认证**：使用 OAuth token 或 Bridge Access Token。

### 2. 无环境 (env-less)

直接通过 OAuth → Worker JWT 交换来连接远程会话：

1. 通过 OAuth 获取访问令牌
2. 直接连接到远程会话 WebSocket（`/v1/sessions/ws/{sessionId}/subscribe`）
3. 使用 SDK 消息格式进行双向通信

**核心组件（`src/remote/`）**：

| 文件 | 路径 | 用途 |
|------|------|------|
| SessionsWebSocket.ts | `src/remote/SessionsWebSocket.ts` | WebSocket 客户端 |
| sdkMessageAdapter.ts | `src/remote/sdkMessageAdapter.ts` | SDK 消息转换适配器 |

---

## 核心组件

### bridgeApi.ts（`src/bridge/bridgeApi.ts`）

HTTP 客户端，封装了所有 Bridge API 调用：

- **OAuth 认证**：自动 401 重试 + token 刷新（通过 `onAuth401` 回调）
- **BridgeFatalError**：不可重试的错误（认证失败、权限不足、会话过期）
- **ID 验证**：`validateBridgeId()` 防止路径遍历攻击
- **错误处理**：对 401/403/404/410/429 状态码分别处理

```typescript
export class BridgeFatalError extends Error {
  readonly status: number
  readonly errorType: string | undefined
}
```

### bridgeMain.ts（`src/bridge/bridgeMain.ts`）

主桥接逻辑，约 3000 行。负责：

- 环境注册与生命周期管理
- 工作（work）的 poll/dispatch 循环
- 会话（session）的创建、运行、恢复
- 多会话支持（`--spawn`, `--capacity`, `--create-session-in-dir`）
- 优雅关闭（SIGTERM → SIGKILL 宽限期）
- 退避策略（连接退避、通用退避、stopWork 退避）

```typescript
export type BackoffConfig = {
  connInitialMs: number      // 连接初始延迟
  connCapMs: number           // 连接最大延迟 (2min)
  connGiveUpMs: number        // 连接放弃时间 (10min)
  generalInitialMs: number    // 通用初始延迟
  generalCapMs: number        // 通用最大延迟 (30s)
  generalGiveUpMs: number     // 通用放弃时间 (10min)
  shutdownGraceMs?: number    // SIGTERM→SIGKILL 宽限期
}
```

### replBridge.ts（`src/bridge/replBridge.ts`）

REPL 集成桥接，约 2400 行。在 REPL（交互式终端）模式下将 CLI 连接到远程会话：

- 通过 `HybridTransport` 实现消息转发
- 支持 CCR v1/v2 协议（`createV1ReplTransport` / `createV2ReplTransport`）
- 消息入口（ingress）处理
- 控制请求/响应（`SDKControlRequest` / `SDKControlResponse`）
- 容量唤醒（capacity wake）信号

```typescript
export type ReplBridgeHandle = {
  bridgeSessionId: string
  environmentId: string
  sessionIngressUrl: string
  writeMessages(messages: Message[]): void
  writeSdkMessages(messages: SDKMessage[]): void
  sendControlRequest(request: SDKControlRequest): void
  sendControlResponse(response: SDKControlResponse): void
  sendControlCancelRequest(requestId: string): void
  sendResult(): void
  teardown(): Promise<void>
}
```

### SessionsWebSocket.ts（`src/remote/SessionsWebSocket.ts`）

WebSocket 客户端，用于直接连接远程会话：

**协议**：
1. 连接到 `wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...`
2. 发送认证消息：`{ type: 'auth', credential: { type: 'oauth', token: '...' } }`
3. 接收 SDK 消息流

**重连机制**：
- `RECONNECT_DELAY_MS = 2000`：重连延迟 2 秒
- `MAX_RECONNECT_ATTEMPTS = 5`：最大重连次数
- `PING_INTERVAL_MS = 30000`：30 秒心跳间隔
- `PERMANENT_CLOSE_CODES = new Set([4003])`：4003（未授权）为永久关闭，不重连
- `MAX_SESSION_NOT_FOUND_RETRIES = 3`：4001（会话未找到）有限重试（压缩期间可能短暂出现）

```typescript
type SessionsWebSocketCallbacks = {
  onMessage: (message: SessionsMessage) => void
  onClose?: () => void
  onError?: (error: Error) => void
  onConnected?: () => void
  onReconnecting?: () => void
}
```

### sdkMessageAdapter.ts（`src/remote/sdkMessageAdapter.ts`）

SDK 消息格式转换器。将 CCR 发送的 SDK 格式消息（`SDKMessage`）转换为 CLI 内部的消息类型（`Message`）：

- `convertAssistantMessage()`: `SDKAssistantMessage` → `AssistantMessage`
- `convertStreamEvent()`: `SDKPartialAssistantMessage` → `StreamEvent`
- 处理多种消息类型：assistant、system、compact_boundary、status、tool_progress、result 等

### remotePermissionBridge.ts

在远程会话中处理权限请求桥接（位于 `src/hooks/useSSHSession.ts`、`useRemoteSession.ts`、`useDirectConnect.ts`），将远程权限提示通过 WebSocket 转发给用户。

---

## 认证机制

| 机制 | 说明 |
|------|------|
| **OAuth Token** | 通过 OAuth 2.0 流程获取的访问令牌 |
| **Bridge Access Token** | 桥接模式专用的访问令牌，通过 `workSecret.ts` 中的 `decodeWorkSecret()` 解码 |
| **Trusted Device Token** | `X-Trusted-Device-Token` 头部，用于权限提升 |
| **Token 刷新** | `handleOAuth401Error` 在 401 时自动刷新 |

---

## WebSocket 协议（CCR v1/v2）

### 认证流程

```
Client → Server: { type: "auth", credential: { type: "oauth", token: "..." } }
Server → Client: { type: "auth_ok" }  或  { type: "auth_error" }
```

### 消息格式

- **CCR v1**：通过 `replBridgeTransport.ts` 的 `createV1ReplTransport` 处理
- **CCR v2**：通过 `createV2ReplTransport` 处理，使用 `buildCCRv2SdkUrl()` 构建 URL

### 心跳保活

- 标准 WebSocket ping：30 秒间隔
- 会话活动信号（`sendSessionActivitySignal()`）在压缩等长时间操作期间发送，防止 WebSocket 因 idle 超时被断开

---

## 其他组件

| 文件 | 路径 | 用途 |
|------|------|------|
| bridgeConfig.ts | `src/bridge/bridgeConfig.ts` | 桥接配置管理 |
| bridgeMessaging.ts | `src/bridge/bridgeMessaging.ts` | 桥接消息处理逻辑 |
| capacityWake.ts | `src/bridge/capacityWake.ts` | 容量唤醒信号 |
| codeSessionApi.ts | `src/bridge/codeSessionApi.ts` | 代码会话 API |
| trustedDevice.ts | `src/bridge/trustedDevice.ts` | 受信任设备管理 |
| workSecret.ts | `src/bridge/workSecret.ts` | Work Secret 编解码 |
| sessionIdCompat.ts | `src/bridge/sessionIdCompat.ts` | 会话 ID 兼容性转换 |
| pollConfig.ts | `src/bridge/pollConfig.ts` | 轮询间隔配置 |
| types.ts | `src/bridge/types.ts` | 桥接模块类型定义 |

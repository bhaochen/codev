# 飞书（Feishu/Lark）机器人集成

## 概述

Codev 内置飞书（国内版）和 Lark（国际版）机器人集成，允许用户在即时通讯中与 AI CLI 进行对话。机器人通过 `@larksuite/channel` SDK 建立长连接 WebSocket，支持私聊、群聊、语音回复、引用回复等功能。

---

## 架构

```
Feishu WebSocket (LarkChannel)
        │
        ▼
FeishuService (singleton)
  ├── PendingQueue (600ms 去抖)
  ├── Access Control (DM/Group 策略)
  ├── Slash Command Router (/stop, /reset, /status, /help)
  ├── Quoted Context Fetcher
  └── TTS Engine (Edge TTS / VoxCPM)
        │
        ▼
messageQueueManager.enqueue()
  └── origin: { kind: 'channel', server: 'feishu' }
        │
        ▼
useFeishuBridge (React hook)
  ├── 收集 AI 回复
  └── sendMarkdown() / sendVoice() 返回飞书
```

---

## 连接方式

采用 **WebSocket 长连接**（非 Webhook），基于 `@larksuite/channel` 包：

- **国内版**: `https://open.feishu.cn`
- **国际版 (Lark)**: `https://open.larksuite.com`
- 通过配置中的 `tenant` 字段选择端点（`'lark'` 使用国际版）

### Channel 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `respectProxyEnv` | `true` | 遵循 `HTTP_PROXY`/`HTTPS_PROXY` |
| `pingTimeout` | `3` | SDK ping 看门狗 |
| `handshakeTimeoutMs` | `8000` | 连接握手超时 |
| `httpTimeoutMs` | `30000` | API 调用超时 |
| `policy.dmMode` | `'open'` | SDK 级 DM 策略（上层另有自定义） |
| `safety.chatQueue.enabled` | `false` | 禁用 SDK 内部队列，使用自定义 PendingQueue |

### 生命周期事件

- `message` — 收到消息
- `error` — 连接错误
- `reconnecting` — 重连中
- `reconnected` — 重连成功

---

## 消息处理流水线

```
Feishu WS → NormalizedMessage → PendingQueue → Access Control → Slash Router → Inbound Listeners → enqueue()
```

### PendingQueue（去抖队列）

文件：`vendor/bot/pending-queue.ts`

- 每个 `chatId` 独立队列
- 消息静默 600ms 后批量提交
- 支持 `block(scope)` / `unblock(scope)` — AI 回复期间阻塞新消息
- 以 `/` 开头的命令跳过队列立即处理

### Access Control（访问控制）

文件：`FeishuService.ts`

**DM 权限**（`canUseDm`）：
- 机器人拥有者（Owner）— 始终允许
- 管理员（`admins[]`）— 始终允许
- `allowedUsers[]` 为空（默认）— 所有人可 DM
- `allowedUsers[]` 有值 — 仅白名单用户可 DM

**群聊权限**（`canUseGroup`）：
- 拥有者和管理员始终允许
- 仅 `allowedChats[]` 中的群被允许

**@ 提及策略**：
- `requireMentionInGroup` 默认为 `true` — 群聊需要 @bot
- 可配置为 `false` 响应所有群消息

### 内置命令

| 命令 | 说明 |
|------|------|
| `/stop` | 停止当前处理 |
| `/reset` | 重置会话 |
| `/status` | 显示机器人状态、App ID、Owner、策略 |
| `/help` | 显示帮助信息 |

未知命令自动传递给 AI 处理。

---

## 引用回复

当用户回复某条历史消息时，`fetchQuotedContext()`（`vendor/bot/quote.ts`）会通过 `channel.fetchRawMessage()` 获取原文，包装为 XML 注入 AI 上下文：

```xml
<quoted_message id="..." sender_id="..." sender_name="..." type="text">
  Original message content here
</quoted_message>
```

支持类型：纯文本、合并转发、交互式卡片（CardKit v1 和 v2）。

---

## 消息格式输出

### 文本

`sendText(chatId, text)` — 发送纯文本。

### Markdown（主要方式）

`sendMarkdown(chatId, markdown)` — 发送前通过 `feishuMarkdown.ts` 优化：

- **标题降级**: H1→H4, H2-H6→H5（飞书卡片 H1-H3 渲染有 bug）
- **Schema 2.0 间距**: 在连续标题、表格前后、代码块周围插入 `<br>`
- **图片过滤**: 非 `img_*` 图片移除（防 CardKit 200570 错误）
- **表格限制**: 超过 3 个表格降级为代码块（防 230099/11310 错误）

### 语音

`sendVoice(chatId, text)` — 启用 TTS 时自动调用。

---

## 语音（TTS）系统

飞书语音为**单向输出**（AI 回复 → 语音），用户始终通过文字输入。

### Edge TTS（默认）

- 使用 `edge-tts` CLI 工具
- 默认语音：`zh-CN-XiaoxiaoNeural`
- 输出转码为 OGG (Opus) 后发送

### VoxCPM（自定义语音克隆）

- 使用 `.venv/bin/voxcpm` CLI
- 需要 `ttsReferenceAudio`（WAV/MP3 参考音频）
- 长文本按 ~150 字在句边界分块
- 每块独立合成，WAV→OGG 转码，ffmpeg concat 合并

### TTS 配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `ttsEnabled` | boolean | 主开关 |
| `ttsProvider` | `'edge' \| 'voxcpm'` | 引擎选择 |
| `ttsVoice` | string | Edge TTS 语音名称 |
| `ttsReferenceAudio` | string | VoxCPM 参考音频路径 |

---

## QR 码注册向导

支持一键创建飞书应用，无需手动在开发者后台操作：

1. 调用 `@larksuite/channel` 的 `registerApp({ source: 'codev' })`
2. 返回 QR 码 URL，终端用 ASCII 渲染
3. 用户使用飞书手机端扫码授权
4. `client_id` 和 `client_secret` 自动保存到配置
5. 机器人立即启动

---

## 配置

文件路径: `~/.claude/adapters.json`（`feishu` 键下）

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `appId` | string | ✅ | 飞书开放平台 App ID |
| `appSecret` | string | ✅ | 飞书开放平台 App Secret |
| `tenant` | `'feishu' \| 'lark'` | ❌ | API 端点选择 |
| `encryptKey` | string | ❌ | 事件加密 |
| `verificationToken` | string | ❌ | 事件 URL 验证 |
| `allowedUsers` | string[] | ❌ | DM 白名单（空=开放） |
| `admins` | string[] | ❌ | 管理员 open_id |
| `allowedChats` | string[] | ❌ | 群聊白名单 |
| `requireMentionInGroup` | boolean | ❌ | 默认 true |
| `ttsEnabled` | boolean | ❌ | 语音回复开关 |
| `ttsProvider` | `'edge' \| 'voxcpm'` | ❌ | TTS 引擎 |
| `ttsVoice` | string | ❌ | Edge TTS 语音 |
| `ttsReferenceAudio` | string | ❌ | VoxCPM 参考音频 |

---

## Keepalive（保活机制）

文件：`vendor/bot/keepalive.ts`

独立于 SDK 内部 ping 的防御性看门狗：

- **间隔**: 每 15 秒
- **防风暴**: 5 秒内跳过重复 tick
- **睡眠检测**: 距上次 tick 超过 30 秒重置计数器
- **HTTP 探针**: 重连前 HEAD 请求检测网络可达性
- **死连接阈值**: 连续 3 个 tick 确认 WS 断开才强制重连

---

## 桥接 Hook

`useFeishuBridge`（`src/hooks/useFeishuBridge.ts`）

React hook，负责：

1. 订阅 FeishuService 的入站事件
2. 监听 `messages` 数组，识别飞书来源的消息（`origin.kind === 'channel' && origin.server === 'feishu'`）
3. 收集后续 AI 回复
4. 在 `isLoading` 从 true→false 时:
   - 主: `sendMarkdown()` 发送完整回复
   - 次: `sendVoice()` 发送 TTS 语音

---

## 与 FriendService 的对比

| 方面 | FeishuService | FriendService |
|------|--------------|---------------|
| 通信方式 | WebSocket (`@larksuite/channel`) | 同进程 HTTP + SSE |
| 消息输入 | 文字（飞书 IM） | 文字 / 语音（VAD + STT） |
| 语音方向 | 仅输出（TTS） | 双向（VAD → STT → AI → TTS） |
| TTS 引擎 | Edge TTS, VoxCPM | Edge TTS, Qwen TTS |
| 配置存储 | `~/.claude/adapters.json` | `getPrefs()` |
| 服务位置 | `src/services/feishu/` | `src/friend/` |

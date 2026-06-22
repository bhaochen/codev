# Friend 系统架构

本文档详细描述 Friend VRM 桌面伴侣系统的各个组件架构。

---

## 1. FriendService — 核心编排器

**文件**: `src/friend/FriendService.ts` (~31KB, 897 行)

### 1.1 生命周期管理

```
start() ──► 状态: 'starting'
    │
    ├── 初始化 Silero VAD (非致命失败，失败后语音捕获降级为 F2-only)
    │       └── 配置: threshold 0.75, preSpeechTriggerFrames 10, redemptionFrames 20
    │
    └── 状态: 'running'

stop() ──► 停止语音捕获 → 清理 STT 连接 → 状态: 'stopped'
```

### 1.2 React external store 接口

FriendService 实现了类似 React `useSyncExternalStore` 的接口：

```typescript
subscribe(listener: Listener): () => void       // 添加状态监听
subscribeToInbound(listener): () => void         // 监听用户输入事件
getStateSnapshot(): FriendServiceState           // 获取当前状态快照
```

`FriendServiceState` 包含：
- `status`: `'stopped' | 'starting' | 'running' | 'error'`
- `lastError`: 可选错误信息
- `displayClientCount`: SSE 显示器客户端数量
- `captureStatus`: 语音捕获状态（`capturing` + `interimText`）

### 1.3 文本中继

```typescript
sendText(text: string): void
```

流程：
1. 通知所有 `inboundListeners`（bridge hook 用于 turn tracking）
2. 动态导入 `messageQueueManager.enqueue()`（避免循环依赖）
3. 使用 `bridgeOrigin: true` 和 `origin: { kind: 'channel', server: 'friend' }` 标记来源

### 1.4 语音捕获

参见 [语音捕获与 VAD 策略](voice-vad.md) 详细文档。

```
startVoiceCapture()
    │
    ├── 检测 STT provider（自动降级）
    ├── 创建 STT 连接（8s 超时）
    ├── 启动 arecord/parecord 子进程（500ms 验证窗口）
    └── 启动 VAD 检测
```

### 1.5 静音系统

AI 处理全过程阻止麦克风采音进入 STT/VAD，防止 TTS 播放时的回声。

```
startAiTurnMute()
    │ muted = true, VAD pause
    │ 设置 30s 安全性计时器
    │
    ├── AI 处理 → TTS 生成
    │
    └── extendMuteForTts(audioId)
        │ 解析 MP3 精确时长
        │ 重置计时器为精确播放时长
        │
        └── unmute()
            │ muted = false, VAD resume
```

### 1.6 STT 自动检测

```typescript
detectAvailableSttProvider()
    │
    ├── 1. Groq Whisper API (最快, REST 调用)
    ├── 2. Local Whisper (pip install openai-whisper)
    ├── 3. Anthropic Voice Stream
    ├── 4. Doubao ASR (检查 ~/.claude/tts/doubao/credentials.json)
    │
    └── 全不可用则抛出错误
```

### 1.7 TTS 生成

```typescript
generateTts(text: string)
    │
    ├── prefs.provider === 'qwen' + prefs.qwenKey 存在
    │   └── Qwen DashScope TTS (qwen3-tts-flash)
    │
    └── else
        └── Edge TTS (node-edge-tts, 默认 zh-CN-XiaoxiaoNeural)
```

### 1.8 SSE 广播

```typescript
broadcastResponse(text: string)
    │
    ├── broadcastToVrm({ text })           // 发送文字到前端 TextBubble
    ├── if TTS enabled:
    │   ├── generateTts(text)
    │   ├── broadcastToVrm({ audioUrl, sendFirstTts: true })
    │   └── extendMuteForTts(audioId)
    └── broadcastToVrm({ replyDone: true }) // 信号回复完成
```

### 1.9 MP3 时长解析

`getMp3DurationMs()` 方法使用帧同步头扫描法精确计算 MP3 时长：

1. 跳过 ID3v2 标签头
2. 查找前两个帧同步字（0xFF + 0xE0）
3. 计算实际帧间隔（CBR 模式）
4. 解析帧头获取采样率和每帧采样数
5. 按步长计数帧数
6. 计算 `(帧数 * 每帧采样数 / 采样率) * 1000`

---

## 2. SSE 模块

**文件**: `src/friend/sse.ts`

### 2.1 客户端注册表

```typescript
Set<SseClient>  // 全局 SSE 客户端集合
```

- `addSseClient(client)`: 注册新客户端
- `removeSseClient(client)`: 移除客户端
- `getSseClientCount()`: 获取活跃客户端数
- `createSseClientId()`: 生成唯一 ID (`sse-{counter}-{timestamp}`)

### 2.2 VrmBroadcastPayload 类型

```typescript
type VrmBroadcastPayload = {
  text?: string;           // 回复文字
  emotion?: string;        // 表情名
  emotionIntensity?: number; // 表情强度 0-1
  audioUrl?: string;       // TTS 音频 URL
  audioIndex?: number;     // 音频索引（多句排序）
  clearText?: boolean;     // 清空气泡文字
  imageUrl?: string;       // 显示图片
  moodDelta?: number;      // 心情变化
  moodIndex?: number;      // 当前心情指数 0-100
  sendFirstTts?: boolean;  // 开始 TTS 播放信号
  appendText?: boolean;    // 追加文字（后续句子）
  replyDone?: boolean;     // 回复结束信号
};
```

### 2.3 广播机制

```typescript
broadcastToVrm(payload: VrmBroadcastPayload)
    ├── 序列化为 SSE data 格式: `data: {json}\n\n`
    ├── 遍历所有客户端，逐个写入
    └── 写入失败的客户端自动移除
```

### 2.4 连接建立

`createSseResponse()` 创建 Bun ReadableStream，返回 `text/event-stream` 响应。
初始发送空行以确认连接建立。客户端断开时自动取消注册。

---

## 3. HTTP 服务器

**文件**: `src/friend/server.ts`

### 3.1 Bun.serve() 配置

- 端口: 3456
- 主机: 127.0.0.1
- `idleTimeout`: 60s（容纳慢速 STT 初始化）

### 3.2 端口管理

`freePort()` 方法在启动时尝试释放被占用的端口：
1. 使用 `ss -tlnp` 查找端口占用进程
2. 验证进程是否为 `bun`/`VersperClaw`/`claude-*`/`node`
3. 发送 SIGTERM，等待 3s，失败则 SIGKILL

### 3.3 路由

| 路径 | 方法 | 功能 |
|------|------|------|
| `/plugins/friend/events` | GET | SSE 事件流 |
| `/plugins/friend/*` | ANY | Friend API 路由（见下文） |
| `/friend/*` | GET | 静态文件 |
| WebSocket 升级 | ANY | 返回 426（不支持） |

---

## 4. Friend API 路由

**文件**: `src/server/api/friend.ts` (~793 行)

### 4.1 完整路由表

| 端点 | 方法 | 功能 |
|------|------|------|
| `/plugins/friend/events` | GET | SSE 事件流 |
| `/plugins/friend/audio/:id` | GET | 提供 TTS 音频文件 |
| `/plugins/friend/media/:id` | GET | 提供媒体文件 |
| `/plugins/friend/chat` | POST | 文字聊天消息 |
| `/plugins/friend/voice/stt-segment` | POST | 浏览器 VAD 语音片段 |
| `/plugins/friend/voice/start` | POST | 开始服务器端语音捕获 |
| `/plugins/friend/voice/stop` | POST | 停止语音捕获 |
| `/plugins/friend/voice/status` | POST | 获取捕获状态 |
| `/plugins/friend/touch` | POST | 触摸交互事件 |
| `/plugins/friend/voice` | GET/POST | 语音设置 |
| `/plugins/friend/stt/config` | GET | STT 配置 |
| `/plugins/friend/stt/file` | POST | 文件转录 |
| `/plugins/friend/preview` | POST | TTS 预览 |
| `/plugins/friend/settings` | GET/POST | 通用设置 |
| `/plugins/friend/persona` | GET/POST | 角色设定 |
| `/plugins/friend/model/list` | GET | 模型列表 |
| `/plugins/friend/model/serve/:file` | GET | 提供 VRM 模型文件 |
| `/plugins/friend/model/import` | POST | 导入 VRM 模型 |
| `/plugins/friend/history` | GET | 对话历史 |
| `/plugins/friend/context/clear` | POST | 清空上下文 |
| `/plugins/friend/mood/adjust` | POST | 调整心情 |
| `/plugins/friend/session/memo` | POST | 记录会话备注 |
| `/plugins/friend/dance/list` | GET | 舞蹈列表 |
| `/plugins/friend/dance/import` | POST | 导入舞蹈 VMD/MP3 |
| `/plugins/friend/dance/delete` | POST | 删除舞蹈 |
| `/plugins/friend/dance/serve/:file` | GET | 提供舞蹈文件 |
| `/plugins/friend/persona/screenshot` | POST | 保存 VRM 截图 |
| `/plugins/friend/persona/generate` | POST | AI 生成角色设定 |
| `/plugins/friend/screen/observe` | POST | 屏观察触发 |
| `/friend/api/window-close` | POST | Tauri 窗口关闭事件 |

### 4.2 MIME 类型支持

- 音频: `.mp3`, `.opus`, `.ogg`, `.wav`, `.webm`
- 图片: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`

---

## 5. TTS 服务

**文件**: `src/friend/tts.ts`

### 5.1 Edge TTS

```typescript
edgeTts({ text, voice? })
    ├── 使用 node-edge-tts 库
    ├── 默认语音: zh-CN-XiaoxiaoNeural
    ├── 输出: 临时目录中的 MP3 文件
    └── 返回: { success, audioPath, error }
```

### 5.2 Qwen DashScope TTS

```typescript
qwenTts({ text, apiKey, voice?, model?, language? })
    ├── 端点: dashscope.aliyuncs.com / dashscope-intl.aliyuncs.com
    ├── 默认模型: qwen3-tts-flash
    ├── 默认语音: Cherry
    ├── 超时: 30s
    └── 返回: { success, audioPath, error }
```

### 5.3 音频文件注册表

```typescript
audioFiles = Map<string, string>  // id → 文件路径

registerAudioFile(filePath)       // 注册文件，5 分钟后自动过期
getAudioFile(id)                  // 获取文件路径
```

---

## 6. STT 服务

**文件**: `src/friend/stt-service.ts`

提供基于文件的语音转录，用于 REST 端点。流式/进程内捕获由 FriendService 处理。

支持 Provider:
- `anthropic`: Anthropic Voice Stream
- `local`: Local Whisper (openai-whisper)
- `doubao`: Doubao ASR
- `browser`: 浏览器 VAD (仅前端的占位符)

---

## 7. VAD 服务

**文件**: `src/friend/voice/vad-service.ts`

参见 [语音捕获与 VAD 策略](voice-vad.md) 详细文档。

### 7.1 核心架构

- **模型**: Silero VAD legacy ONNX (来自 `@ericedouard/vad-node-realtime`)
- **运行时**: onnxruntime-web WASM 后端（Bun 不兼容 onnxruntime-node）
- **帧大小**: 512 采样 @ 16kHz = 32ms/帧
- **预处理**: RMS 能量预过滤 (<0.004 跳过推理)

### 7.2 状态机

```
pre-speech phase (preSpeechCount < preSpeechTriggerFrames)
    │  ├── 非语音帧 → 重置计数
    │  └── 连续语音帧达到阈值 → 进入 speaking
    ▼
speaking (confirmed speech segment)
    │  ├── 语音帧 → 重置 redemptionCounter
    │  └── 静音帧 → redemptionCounter++
    │       └── redemptionCounter >= redemptionFrames → endSpeech()
    ▼
silence redemption (grace period)
    └── endSpeech() → onSpeechEnd 回调
```

---

## 8. 偏好设置

**文件**: `src/friend/prefs.ts`

```typescript
interface FriendPrefs {
  enabled?: boolean;
  voice?: string;              // TTS 语音
  provider?: string;           // TTS provider (edge | qwen)
  qwenKey?: string;            // Qwen API Key
  qwenModel?: string;          // Qwen 模型名
  modelPath?: string;          // VRM 模型路径
  ttsEnabled?: boolean;        // TTS 开启
  showText?: boolean;          // 显示文字气泡
  hideUI?: boolean;            // 隐藏 UI
  tracking?: 'mouse' | 'camera';  // 眼球追踪模式
  volume?: number;             // 音量 0-1
  uiAlign?: 'left' | 'right';  // UI 对齐
  screenObserve?: boolean;     // 屏幕观察
  screenObserveInterval?: number; // 观察间隔(秒)
  language?: 'zh' | 'en';     // 语言
  currentDance?: string;       // 当前舞蹈
  hideMood?: boolean;          // 隐藏心情
  sttProvider?: string;        // STT provider
  sttLanguage?: string;        // STT 语言
  groqApiKey?: string;         // Groq API Key
}
```

持久化路径: `~/.config/VersperClaw/friend.json`

---

## 9. Tauri Launcher

**文件**: `src/friend/tauri-launcher.ts`

- 查找 Tauri 二进制文件（release → debug）
- 启动为 detached 子进程
- 管道 stdout/stderr 到主进程日志
- 退出时自动清理

启动路径: `src/components/friend/frontend/src-tauri/target/{release|debug}/versperclaw-friend`

---

## 10. 常量

**文件**: `src/friend/constants.ts`

```typescript
GATEWAY_URL = 'http://127.0.0.1:3456'
FRIEND_SESSION_KEY = 'agent:main:main'
CHANNEL_ID = 'friend'
VALID_EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'think', 'awkward',
                  'question', 'curious', 'neutral', 'love', 'flirty',
                  'greeting', 'relaxed']
```

---

## 依赖关系图

```
server.ts ──┬── sse.ts ──────────► FriendService.ts ──┬── tts.ts
            │                    │                    ├── vad-service.ts
            │                    │                    ├── prefs.ts
            │                    │                    └── text-utils.ts
            │                    │
            └── api/friend.ts ───┤
                                ├── sse.ts
                                ├── prefs.ts
                                ├── tts.ts
                                ├── stt-service.ts
                                └── FriendService.ts

FriendEmotionTool.ts ──► sse.ts, prefs.ts
FriendScreenObserveTool.ts ──► sse.ts

tauri-launcher.ts (独立启动)
```

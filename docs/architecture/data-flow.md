# 核心数据流

本文档详细描述 Codev 的六大核心数据流，包含 ASCII 序列图和关键代码路径。

---

## 1. 用户输入流

用户通过终端输入文本到 AI 响应的完整链路。

```
User (键盘)
    │
    │  键入文本 + Enter
    ▼
PromptInput 组件
(screens/PromptInput.tsx)
    │
    │  handlePromptSubmit()
    ▼
messageQueueManager.enqueue()
(utils/messageQueueManager.ts)
    │
    │ 命令入队 (priority: 'now' | 'next' | 'later')
    │ FIFO 按优先级排序
    ▼
useCommandQueue hook
(hooks/useCommandQueue.ts)
    │
    │ 出队 → 交给 REPL 主循环
    ▼
query() 函数
(query.ts → QueryEngine.ts)
    │
    ├── 组装消息历史
    ├── 获取系统提示词 (src/context.ts)
    ├── 合并工具列表 (assembleToolPool)
    └── 选择 Provider
         │
         ├── [1P Anthropic] ── Anthropic SDK ── POST /v1/messages
         │
         └── [3P Provider] ── server/proxy/handler.ts
                                │
                                ├── anthropicToOpenaiChat.ts  (请求转换)
                                ├── POST provider API (OpenAI/Groq/DeepSeek...)
                                └── openaiChatToAnthropic.ts (响应转换)
                                      │
                                      ▼
                              流式响应回到 query()
                                      │
                                      ▼
                              工具调用分发 (Tool Execution)
                                      │
                                      ▼
                              渲染响应到终端 (Ink UI)
```

### 关键代码路径

| 步骤 | 文件 | 核心函数 |
|------|------|----------|
| 输入 | `src/components/PromptInput/PromptInput.tsx` | `handlePromptSubmit()` |
| 队列 | `src/utils/messageQueueManager.ts` | `enqueue()`, `dequeue()` |
| 查询 | `src/query.ts` | `query()` |
| 引擎 | `src/QueryEngine.ts` | `QueryEngine` 类 |
| 工具 | `src/tools.ts` | `assembleToolPool()`, `getTools()` |
| 代理 | `src/server/proxy/handler.ts` | `handleProxyRequest()` |
| 响应渲染 | `src/screens/REPL.tsx` | 消息列表 + 流式渲染 |

### 单轨 Native LLM Runtime（P6 最终）

```
Agent query() → queryModel Facade(src/services/api/queryModel.ts:17)
              → ModelRuntime.generate(src/services/llm/runtime/ModelRuntime.ts:10)
                ├─ resolveRoute(src/services/llm/router/resolveRoute.ts:11) → LLMRoute{provider,protocol,model,endpoint}
                ├─ resolveAuth(src/services/llm/auth/resolveAuth.ts:8) → Credential{bearer|none}
                ├─ getModelMetadata(src/services/llm/models/registry.ts:16) → ModelMetadata{capabilities}
                └─ getClientForRoute(protocol)(src/services/llm/clients/index.ts:21)
                   ├─ openai-chat → queryOpenAIChat(src/services/llm/clients/openaiChat.ts:52) 直连 Chat Completions
                   └─ anthropic-messages → queryAnthropicMessages(src/services/llm/clients/anthropicMessages.ts:958) 直连 Messages
              → adaptOpenAIStreamToAnthropic / 透传 → query() 流式事件 → Tool Execution → 渲染
```

免费模型在 `openaiChat.ts:102` 按 `models.dev:isFree` 裁剪 `tools<=8`、`system<=8000`，无 key 注入 `x-anthropic-billing-header` 暗桩，`500` 自动 `fallback to big-pickle`。

### REPL 批量引擎契约（a1325f2）

```
LLM → REPL tool_use{code} → ReplEngine.execute(src/tools/REPLTool/engine.ts:130)
        ├─ callTool(name,input) → ToolResult{tool,ok,exitCode,stdout/stderr/data,outputPath,truncated}
        ├─ ExecutionStore: innerMessages(isVirtual:true) → UI/history（normalizeMessagesForAPI 过滤不进 LLM）
        └─ ContextAggregator.buildContextResult() → ContextResult{ok,tool_calls,calls:[preview,summary,truncated,outputPath],logs} JSON → LLM API
   REPL != SubAgent：批量执行器，无二次 LLM 调用；isVirtual 仅可视，ContextResult 唯一进模型。
```

### 队列优先级机制

```
优先级: 'now' > 'next' > 'later'
同一优先级内 FIFO

┌─────────┐  ┌──────────┐  ┌─────────┐
│  'now'  │  │  'next'  │  │ 'later' │
│ (紧急)  │  │ (正常)   │  │ (通知)  │
├─────────┤  ├──────────┤  ├─────────┤
│ ═══▶    │  │ ═══▶     │  │ ═══▶    │
│ 出队优先  │  │          │  │         │
└─────────┘  └──────────┘  └─────────┘
```

---

## 2. 语音捕获流

从麦克风到 VRM 前端语音播放的完整管道。

### 语音捕获架构

Codev 使用进程内音频捕获（cpal Rust 库，通过 `native-modules/audio-capture-napi`），而不是传统的 arecord/parecord 子进程。

```
麦克风 (硬件)
    │
    │ 16kHz S16LE PCM
    ▼
cpal (Rust 原生模块)
(native-modules/audio-capture-napi)
    │
    │ onData(chunk: Buffer)
    ▼
FriendService.startVoiceCapture()
(friend/FriendService.ts)
    │
    ├──▶ Silero VAD (语音活动检测)
    │    (friend/voice/vad-service.ts)
    │    │
    │    │ onnxruntime-web WASM 推理
    │    │ 512 samples/frame @ 16kHz (32ms)
    │    │
    │    ├── 说话开始 → 开始积累音频
    │    ├── 检测持续语音 (≥10 帧 ≈ 320ms 激活)
    │    └── 检测静音 (≥20 帧 ≈ 640ms) → onSpeechEnd
    │         │
    │         ▼
    │    音频段 (Float32Array)
    │         │
    │         ▼
    │    STT (语音转文字)
    │    ├── Doubao ASM (火山引擎)
    │    │   (doubaoime-asr 包)
    │    ├── Anthropic STT
    │    └── Whisper (OpenAI)
    │         │
    │         ▼
    │    转录文本 (transcript)
    │
    └──▶ messageQueueManager.enqueue()
         │
         │ { value: transcript, mode: 'prompt', origin: { kind: 'channel', server: 'friend' } }
         ▼
    AI 处理 (同用户输入流)
         │
         │ AI 响应文本
         ▼
    TTS (文本转语音)
    ├── Edge TTS (node-edge-tts, 默认 zh-CN-XiaoxiaoNeural)
    └── Qwen TTS (DashScope API, qwen3-tts-flash)
         │
         │ 生成 MP3 文件
         ▼
    broadcastToVrm()
    (friend/sse.ts)
         │
         │ SSE → { text, audioUrl, audioIndex }
         ▼
    VRM 前端
    ├── 播放音频
    ├── 显示文本气泡
    └── 触发口型同步
```

### VAD 状态机

```
Silero VAD 内部状态:

          [静音] ────────────── 帧概率 < 正阈值 ──────────────▶ [静音]
            │                                                     ▲
            │ 帧概率 ≥ positiveSpeechThreshold                   │
            │ (连续 ≥ preSpeechTriggerFrames)                    │ 帧概率 < 负阈值
            ▼                                                     │ (连续 ≥ redemptionFrames)
          [可能说话] ────── 帧概率 < 正阈值 ──────▶ [确认说话] ──┘
            │                                                     │
            │ onSpeechStart()                                     │ onSpeechEnd(audio)
            ▼                                                     ▼
      [积累音频帧]                                      [发送音频段到 STT]
```

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `positiveSpeechThreshold` | 0.75 | 判定为语音的置信度阈值 |
| `negativeSpeechThreshold` | 0.50 | 判定为静音的置信度阈值 |
| `preSpeechTriggerFrames` | 10 | 激活前需要连续语音帧数 |
| `redemptionFrames` | 20 | 结束前需要连续静音帧数 |
| `minSpeechFrames` | 6 | 最小有效语音帧数 |
| `rmsThreshold` | 0.004 | RMS 能量阈值 (-48dBFS)，低于此值跳过推理 |

### 回声消除机制

```
FriendService 在 TTS 播放时自动静音麦克风:

AI 响应文本
    │
    ▼
TTS 开始生成
    │
    ▼
friend.muted = true
    │  muteTimer = setTimeout(unmute, estimatedTtsDuration)
    │
    ▼
TTS 播放期间: 麦克风数据 → 丢弃 (不送 VAD/STT)
    │
    ▼
TTS 播放结束 (或估算时间到)
    │
    ▼
friend.muted = false
    │
    ▼
恢复正常捕获
```

---

## 3. 远程桥接流

Local CLI 到 `claude.ai` 远程会话的 WebSocket 桥接。

```
Local CLI (你的机器)                  claude.ai 服务器
─────────────────────            ─────────────────────

  claude --remote start
       │
       ▼
  bridgeMain()
  (bridge/bridgeMain.ts)
       │
       │ 创建本地 HTTP 服务
       │ 发起 OAuth 登录
       ▼
  WebSocket 连接
  (bridge/replBridgeTransport.ts)
       │                ◄══════════►  claude.ai 远程会话
       │  wss://api.claude.ai/...
       │
       ▼
  replBridge.ts
       │
       ├── 从远程接收输入 → 入队到本地 messageQueueManager
       ├── 将本地输出/工具结果 → 发送回远程
       └── 同步本地命令到远程白名单
            (BRIDGE_SAFE_COMMANDS)
```

### 命令过滤

远程模式下只允许安全命令执行：

```
REMOTE_SAFE_COMMANDS = {
   session,   // 显示 QR/URL
   exit,      // 退出
   clear,     // 清屏
   help,      // 帮助
   theme,     // 主题
   color,     // 颜色
   vim,       // Vim 模式
   cost,      // 计费
   usage,     // 用量
   copy,      // 复制
   btw,       // 便签
   feedback,  // 反馈
   plan,      // 计划模式
   keybindings, // 快捷键
   statusline,  // 状态栏
   stickers,    // 贴纸
   mobile,      // 移动端
}
```

桥接安全命令（从移动端也可执行）：

```
BRIDGE_SAFE_COMMANDS = {
   compact,    // 压缩上下文
   clear,      // 清屏
   cost,       // 计费
   summary,    // 会话总结
   releaseNotes, // 更新日志
   files,      // 文件列表
}
```

---

## 4. Friend 表情流

LLM 调用 `friend_emotion` 工具到 VRM 前端 3D 角色表情渲染的完整链路。

```
LLM 推理
    │
    │ 思考上下文后调用 FriendEmotionTool
    ▼
FriendEmotionTool.call({ emotion, intensity, mood_delta })
(tools/FriendEmotionTool.ts)
    │
    ├── 更新心情指数 moodIndex (0-100, 基准值 60)
    │   ├── mood_delta > 0: moodIndex += delta (上限 100)
    │   └── mood_delta < 0: moodIndex -= delta (下限 0)
    │
    └── broadcastToVrm({
    │       emotion: 'happy'|'sad'|'angry'|...,
    │       emotionIntensity: 0..1,
    │       moodDelta: n,
    │       moodIndex: n
    │   })
    │
    ▼
broadcastToVrm()
(friend/sse.ts)
    │
    │ SSE data: JSON.stringify(payload) + "\n\n"
    │ 发送给所有已连接的 SSE 客户端
    ▼
VRM 前端 (Three.js / React Three Fiber)
    │
    ├── SSE 事件解析
    │
    ├── VRMScene 组件
    │   ├── EmoteController — 设置 BlendShape 混合形状
    │   │   (happy → 嘴角上扬, sad → 眉眼下垂, 等)
    │   ├── MotionController — 触发生理动画 (呼吸、眨眼)
    │   └── TextBubble — 显示聊天文本气泡
    │
    └── AudioPlayback (如果有 audioUrl)
        └── 播放 TTS 音频 + 口型同步
```

### 可用表情列表

| 表情 | 说明 |
|------|------|
| `happy` | 开心 |
| `sad` | 悲伤 |
| `angry` | 生气 |
| `surprised` | 惊讶 |
| `think` | 思考 |
| `awkward` | 尴尬 |
| `question` | 疑问 |
| `curious` | 好奇 |
| `neutral` | 中性/默认 |
| `love` | 喜爱 |
| `flirty` | 调情 |
| `greeting` | 打招呼 |
| `relaxed` | 放松 |

### 心情系统

```
心情指数 (moodIndex) 范围 0-100，基准值 60

  0 ────────────── 60 ────────────── 100
  [低落]          [中性]            [高涨]

每次 mood_delta: -3 到 +3 (最小绝对值 1)
通过 prefs 持久化 (friend/prefs.ts)

moodIndex 影响:
  - 文本气泡颜色/样式
  - 坐姿姿态 (放松 vs 紧张)
  - 手臂动作幅度
```

### SSE 广播事件类型

Friend SSE 通道通过 `broadcastToVrm()` 发送 JSON 事件，所有字段均为可选：

```typescript
type VrmBroadcastPayload = {
  text?: string;           // 显示文本
  emotion?: string;        // 表情名称
  emotionIntensity?: number; // 表情强度 0-1
  audioUrl?: string;       // TTS 音频 URL
  audioIndex?: number;     // 音频序列号
  clearText?: boolean;     // 清除当前文本
  imageUrl?: string;       // 显示的图片 URL
  moodDelta?: number;      // 心情变化量
  moodIndex?: number;      // 当前心情指数
  sendFirstTts?: boolean;  // 发送第一个 TTS 段
  appendText?: boolean;    // 追加到已有文本
  replyDone?: boolean;     // 响应结束标记
};
```

---

## 5. Provider 代理流（单轨 Native，已收敛）

CLI 通过统一接口向不同 LLM Provider 发送请求的完整路径（P6 最终：不再双路由分流，统一 `ModelRuntime`）。

### 单轨路由决策

```
CLI (Anthropic Messages API format → normalizeMessagesForAPI)
    │
    │ resolveProviderContext() + resolveModel() + getProviderDef(protocol/endpoint)
    ▼
resolveRoute() → LLMRoute{provider,protocol,model,endpoint} (src/services/llm/types.ts:22)
    │
    ├─ resolveAuth(provider) → Credential (src/services/llm/auth/resolveAuth.ts:8)
    └─ getClientForRoute(protocol) → Protocol Client (src/services/llm/clients/index.ts:21)
           ├─ openai-chat → queryOpenAIChat (OpenAI/OpenCode/DeepSeek 直连)
           └─ anthropic-messages → queryAnthropicMessages (Anthropic/Bedrock/Vertex/Foundry/NVIDIA)
                   │
                   ▼ Native fetch POST /v1/chat/completions 或 /v1/messages
```

### 请求/响应转换流程（openai-chat 路径）

```
Anthropic Messages API 请求
{
  model: "claude-3-opus",
  messages: [{role: "user", content: "Hello"}],
  system: "You are helpful",
  max_tokens: 1024,
  stream: true
}
    │
    ▼
convertAnthropicMessagesToOpenAI(@ant/model-provider) / convertAnthropicToolsToOpenAI
    │
    │ 转换逻辑:
    │ - system → role:system 消息
    │ - messages[] → messages[] (role 映射, image→image_url, tool_result→tool, tool_use→tool_calls)
    │ - thinking → reasoning_content (DeepSeek 兼容)
    │ - tools: {name, description, input_schema} → {type:function, function:{...}}
    │
    ▼
buildOpenAIRequestBody(...) → {model, messages, tools, max_tokens, temperature, stream:true}
    │
    │ POST 到上游 endpoint（resolveRoute 产出，Provider 仅提供元数据）
    ▼
parseOpenAIStream → adaptOpenAIStreamToAnthropic (流式 SSE 双向转换)
    │
    │ 转换逻辑:
    │ - delta.content → delta.text
    │ - delta.reasoning_content → thinking_delta
    │ - tool_calls → content_block / tool_use
    │ - finish_reason → stop_reason
    │
    ▼
Anthropic 格式流式事件回 query() → 工具调度 → 渲染
```

服务端 `src/server/proxy/handler.ts` 的 `anthropicToOpenaiChat/Responses` 转换仍保留作 H5/远程备用路径；主 CLI 路径已走 `services/llm/clients/*` 直连。

### Provider 配置（仅 Tier1 TUI，Tier2 已删 `13c204e`）

通过 TUI 内置 Provider 系统 (`src/utils/model/providers.ts` + `~/.claude.json:authProvider`) 单一事实源管理，无 Tier2 预设；默认 `f1aa3bb` 回落 `opencode`：

```typescript
type APIProvider = 'firstParty' | 'openai' | 'opencode' | 'nvidia' | 'local' | 'openrouter' | ...
type LLMRoute = { provider: ProviderId, protocol: ProtocolId, model: string, endpoint?: string }
type Credential = { type:'bearer', token:string } | { type:'none' }
```

Provider 通过 `/login` 在终端中配置。

---

## 数据流汇总图

```
                        ┌─────────────────────────┐
                        │    用户的输入来源         │
                        ├─────┬─────┬──────┬──────┤
                        │键盘 │语音 │远程  │ Bot  │
                        │     │     │WebSocket  │
                        └──┬──┴──┬──┴──┬───┴──┬──┘
                           │     │     │      │
                           ▼     │     │      │
                    ┌──────────┐ │     │      │
                    │  message │◄┘     │      │
                    │  Queue   │◄──────┘      │
                    │  Manager │◄─────────────┘
                    └─────┬────┘
                          │
                          ▼
                    ┌──────────┐
                    │  query() │
                    │  AI 引擎 │
                    └──┬────┬──┘
                       │    │
            ┌──────────┘    └──────────┐
            ▼                          ▼
    ┌──────────────┐          ┌────────────────┐
    │  Tool 执行    │          │  LLM 文本响应   │
    │ (Bash/Read/  │          └───────┬────────┘
    │  Edit/...   │                  │
    └──────────────┘          ┌───────┴────────┐
                              │  分发到消费者    │
                              ├────┬────┬──────┤
                              │TUI │TTS │SSE   │
                              │显示 │播放 │推送  │
                              └────┴────┴──────┘
```

---

## 参考文件路径

| 文件 | 说明 |
|------|------|
| `src/utils/messageQueueManager.ts` | 统一命令队列 |
| `src/query.ts` | AI 查询入口 |
| `src/QueryEngine.ts` | 查询引擎实现 |
| `src/friend/FriendService.ts` | Friend 语音/文本服务 |
| `src/friend/voice/vad-service.ts` | Silero VAD 实现 |
| `src/friend/tts.ts` | Edge TTS / Qwen TTS |
| `src/friend/sse.ts` | SSE 广播与客户端管理 |
| `src/friend/server.ts` | Friend HTTP 服务 (Bun.serve) |
| `src/tools/FriendEmotionTool.ts` | VRM 表情工具 |
| `src/friend/constants.ts` | 情绪列表常量 |
| `src/utils/model/providers.ts` | Tier1 Provider 管理 |
| `src/bridge/bridgeMain.ts` | 远程桥接主入口 |
| `src/bridge/replBridgeTransport.ts` | WebSocket 传输层 |
| `src/bridge/replBridge.ts` | REPL 桥接逻辑 |

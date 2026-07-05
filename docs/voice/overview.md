# 语音系统

## 概述

Codev 的语音系统支持**语音转文字（STT, Speech-to-Text）** 和 **文字转语音（TTS, Text-to-Speech）** 功能。语音录制使用底层音频捕获库（cpal），含有 SoX 和 arecord 回退方案。语音识别支持多个提供商，包括云端 API 和本地模型；语音合成同样支持多个引擎，涵盖 Edge TTS 和 DashScope TTS。

> 注意：部分功能受构建特性门控（feature gate）限制，仅在 ant-internal 构建中可用。

---

## 语音录制（Voice Recording）

核心文件：`src/services/voice.ts`

录音模块使用分层策略：

| 层级 | 方案 | 适用平台 |
|------|------|----------|
| 原生 | `audio-capture-napi`（cpal） | macOS, Linux, Windows |
| 回退 1 | SoX `rec` | Linux (有 SoX) |
| 回退 2 | `arecord` (ALSA) | Linux (有 ALSA) |

关键特征：

- **懒加载原生模块**：`loadAudioNapi()` 在首次按键时异步加载 `audio-capture-napi`，避免启动时阻塞（dlopen 可能耗时 1-8 秒）。
- **静音检测**：使用 SoX 或 arecord 时启用静音检测（阈值 3%，持续时间 2 秒），自动结束录音。
- **录音常量**：采样率 16000 Hz，单声道，16-bit PCM。
- **依赖检查**：`checkVoiceDependencies()` 探测可用性，显示每个方案的可用状态。

---

## STT 提供商（Speech-to-Text）

### 抽象接口

文件：`src/services/voice/providers.ts`

```typescript
interface TranscriptionProvider {
  name: string
  transcribe(wavPath: string, language?: string): Promise<TranscriptionResult>
}
```

所有 STT 提供商实现此接口，`LocalWhisperSTT` 和 `DoubaoSTTProvider` 是内置实现。

---

### 1. Groq Whisper（云端）

文件：`src/services/voice/groqSTT.ts`

通过官方 `groq-sdk` npm 包调用 Groq LPU API，使用 Whisper 模型。

**模型回退**：
1. 优先使用 `whisper-large-v3`
2. 遇到 429（限速）或 5xx（服务端错误）时自动回退到 `whisper-large-v3-turbo`
3. 其他错误（4xx）直接抛出，不重试

**API 密钥解析**（优先级从高到低）：
1. 显式传入的 `apiKey` 参数
2. `friend.json` 中的 `groqApiKey` 配置
3. 环境变量 `GROQ_API_KEY`
4. `~/.claude/settings.json` 中的 `env.groqApiKey`

**核心流程**：
- `connectGroqStream()` 返回 `VoiceStreamConnection` 接口
- 接收 PCM 音频块并缓冲
- `finalize()` 时将 PCM 转换为 WAV（`pcmToWav()`，16-bit 单声道，16000 Hz）
- 通过 `File` API 上传 WAV 到 Groq

---

### 2. Local Whisper（本地模型）

文件：`src/services/voice/whisperSTT.ts`

基于 Python `openai-whisper` 的本地部署方案。

**架构**：
- 启动一个长期运行的 Python 子进程（`whisper_server.py`）
- 通过 stdin/stdout 的 JSON 行协议通信
- 支持预加载模型（`preloadWhisperModel()`）

**通信协议**：
- `{"type":"load","model":"small"}` —— 加载模型
- `{"type":"transcribe","wav":"/path/to/audio.wav","language":"en"}` —— 转写
- 服务端以 `{"type":"result","text":"...","language":"..."}` 或 `{"type":"error","message":"..."}` 响应

**进程管理**：
- 进程崩溃后自动重启
- 30 秒超时保护
- 临时文件自动清理

**可用性检查**：使用 Python `importlib.util.find_spec("whisper")` 探测 whisper 模块是否可导入，避免加载 PyTorch 的耗时。

---

### 3. Anthropic Voice Stream（WebSocket）

文件：`src/services/voiceStreamSTT.ts`

通过 Anthropic 的 voice_stream WebSocket 端点传输语音，仅在 ant-internal 构建中可用（由 `feature('VOICE_MODE')` 门控）。

**WebSocket 协议**：
- 端点：`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`
- 认证：OAuth Bearer Token（与 Claude Code 共享凭证）
- 消息类型：
  - `KeepAlive` —— 每 8 秒发送保持连接
  - `CloseStream` —— 结束流
  - 服务端推送 `TranscriptText`、`TranscriptEndpoint`、`TranscriptError`

**连接生命周期**：
1. `connectVoiceStream()` 建立 WebSocket 连接
2. `send(audioChunk)` 发送二进制音频帧
3. `finalize()` 发送 `CloseStream`，等待服务端返回 `TranscriptEndpoint`
4. `FinalizeSource` 枚举标识解析路径：`post_closestream_endpoint`、`no_data_timeout`、`safety_timeout`、`ws_close`、`ws_already_closed`

**Deepgram Nova 3 门控**：通过 GrowthBook 特性标记 `deepgram_nova_3_gate` 控制是否使用 Deepgram Nova 3 模型。

**Voice Keyterms**：通过查询参数传递关键词列表，提高领域术语的识别准确率。

---

### 4. Doubao（豆包 STT）

文件：`src/services/voice/doubaoSTT.ts`

此文件是一个自动生成的存根（stub），对应 ant-internal 的 `feature()` 门控模块。外部构建中所有代码路径在 DCE（死代码消除）后不会实际执行。

存根使用 JavaScript `Proxy` 将任何属性访问、函数调用、构造操作映射到无操作（noop）处理器。导出 `connectDoubaoStream`、`normalizeLanguageForSTT` 等函数作为占位符。

`DoubaoSTTProvider`（在 `providers.ts` 中）封装了此存根的调用逻辑，通过动态导入（`import('./doubaoSTT.js')`）在运行时解析。

---

## TTS 提供商（Text-to-Speech）

### 抽象接口

文件：`src/services/voice/providers.ts`

```typescript
interface TTSProvider {
  name: string
  synthesize(text: string): Promise<SynthesisResult>
}
```

`EdgeTTSProvider` 和 `CommandTTSProvider` 是内置实现。

---

### 1. Edge TTS（微软神经网络语音）

文件：`src/services/voice/providers.ts`（类 `EdgeTTSProvider`）

**实现路径一（Provider 接口）**：
- 直接调用 `edge-tts` 命令行工具
- 使用 Node.js `child_process.spawn` 执行子进程
- 通过 `--voice`、`--text`、`--write-media` 参数控制输出
- 默认语音：`en-US-AriaNeural`

**实现路径二（独立函数）**：
文件：`src/services/voice/edgeTTS.ts`（`speakWithEdgeTTS()`）
- 调用 `scripts/speak.py` Python 脚本
- 依赖 `.venv/bin/python` 或系统 Python
- 返回标准化的 `TTSResult` 接口

**实现路径三（Friend 模块）**：
文件：`src/friend/tts.ts`（`edgeTts()`）
- 使用 `node-edge-tts` npm 包（Node.js 原生实现，无需 Python）
- 默认语音：`zh-CN-XiaoxiaoNeural`（中文语音）
- 输出为 MP3 文件

**播放功能**（`src/services/voice/edgeTTS.ts` `playAudioFile()`）：
| 平台 | 播放器 | 说明 |
|------|--------|------|
| macOS | `afplay` | 原生 |
| Linux | `ffplay` | 先 `pkill` 已有进程，再启动新进程 |
| Windows | `start` | 系统默认播放器 |

---

### 2. Qwen DashScope TTS（通义千问语音合成）

文件：`src/friend/tts.ts`（`qwenTts()`）

调用阿里云 DashScope API 进行语音合成。

**API 信息**：
- 国内端点：`https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- 国际端点：`https://dashscope-intl.aliyuncs.com/...`
- 默认模型：`qwen3-tts-flash`
- 默认语音：`Cherry`
- 认证：Bearer Token（`apiKey`）

**参数**：
- `voice`：语音角色（如 Cherry, Polly 等）
- `model`：模型版本
- `language`：语言（`zh` 或 `en`），决定端点选择和 `language_type`

**流程**：
1. POST 请求获取合成音频的 URL
2. 从 URL 下载音频数据
3. 保存为 WAV 临时文件
4. 支持 30 秒超时保护

**音频文件注册**：`registerAudioFile()` 将文件路径注册到内存映射，5 分钟后自动过期，用于跨模块引用。

---

### 3. Command TTS（命令模板回退）

文件：`src/services/voice/providers.ts`（类 `CommandTTSProvider`）

通用 shell 命令 TTS，支持模板占位符：
- `{input}` / `{input_path}` —— 输入文本文件路径
- `{output_path}` —— 输出音频文件路径

适用于调用任意外部 TTS 命令行工具。

---

## Voice Stream 协议

文件：`src/services/voiceStreamSTT.ts`

Voice Stream 是 Anthropic 的 WebSocket 协议，用于实时语音识别。

### 消息类型

| 方向 | 类型 | 说明 |
|------|------|------|
| 客户端 → 服务端 | `KeepAlive` | 心跳，每 8 秒 |
| 客户端 → 服务端 | `CloseStream` | 结束音频流 |
| 客户端 → 服务端 | 二进制帧 | PCM 音频数据 |
| 服务端 → 客户端 | `TranscriptText` | 转写文本片段 |
| 服务端 → 客户端 | `TranscriptEndpoint` | 转写结束标记 |
| 服务端 → 客户端 | `TranscriptError` | 错误信息 |

### FinalizeSource 枚举

`finalize()` 方法的解析路径：

| 值 | 说明 |
|----|------|
| `post_closestream_endpoint` | 正常流程：发送 CloseStream 后收到 TranscriptEndpoint |
| `no_data_timeout` | 发送 CloseStream 后 1.5 秒无响应 |
| `safety_timeout` | WebSocket 挂起超过 5 秒 |
| `ws_close` | WebSocket 连接关闭 |
| `ws_already_closed` | 已关闭的连接被重复调用 |

### Keyterms（关键词）

通过 WebSocket 查询参数 `keyterms` 传递关键词列表，格式为逗号分隔的 URL 编码值。关键词可提高模型对特定术语的识别准确率。

---

## Voice Mode（语音模式）

语音模式是 Push-to-Talk（按住说话）的实现：

1. **开始录音**：用户按下语音快捷键
2. **音频采集**：底层 cpal 或回退方案开始采集 16kHz 单声道 PCM 音频
3. **音频传输**：音频块通过 Voice Stream WebSocket 实时发送
4. **释放停止**：用户松开快捷键，发送 CloseStream
5. **等待转写**：接收服务端返回的 TranscriptText 和 TranscriptEndpoint
6. **提交文本**：转写文本进入对话输入流

当使用本地 Whisper 时，流程类似但使用子进程通信而非 WebSocket。

---

## 提供商注册与选择

文件：`src/services/voice/providers.ts`

系统通过 `TranscriptionProvider` 和 `TTSProvider` 接口实现多提供商支持。每个提供商有自己的名称（`name` 属性）和实现逻辑。选择策略在调用方（如 `useVoice` hook）中决定，根据可用性和用户配置选择合适的提供商。

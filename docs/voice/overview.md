# 语音系统

## 概述

Codev 的语音系统支持**语音转文字（STT, Speech-to-Text）** 和 **文字转语音（TTS, Text-to-Speech）** 功能。语音录制使用底层音频捕获库（cpal），含有 SoX 和 arecord 回退方案。语音识别当前以 Groq Whisper（云端）为主，另保留 whisper.cpp 本地转录类与豆包生成存根；语音合成基于 Edge TTS 与命令模板回退。

> 注意：整个语音功能受构建特性门控 `feature('VOICE_MODE')` 限制（见 `scripts/features.ts`，默认构建集启用）。 GrowthBook 杀开关在外部构建中恒为放行（`src/voice/voiceModeEnabled.ts`）。

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

`LocalWhisperSTT` 实现此接口；实际接入 `useVoice` hook 的云端 STT 是 `connectGroqStream()`（见下）。

---

### 1. Groq Whisper（云端，当前默认）

文件：`src/services/voice/groqSTT.ts`

通过官方 `groq-sdk` npm 包调用 Groq LPU API，使用 Whisper 模型。

**模型回退**：
1. 优先使用 `whisper-large-v3`
2. 遇到 429（限速）或 5xx（服务端错误）时自动回退到 `whisper-large-v3-turbo`
3. 其他错误（4xx）直接抛出，不重试

**API 密钥解析**（`resolveGroqApiKey()`，优先级从高到低）：
1. 显式传入的 `apiKey` 参数
2. 环境变量 `GROQ_API_KEY`
3. 合并设置的 `env` 块（`groqApiKey` 或 `GROQ_API_KEY`）

第 3 级通过 `getInitialSettings()`（`src/utils/settings/settings.ts`）读取，因此跟随 `CLAUDE_CONFIG_DIR` —— 与 `/voice` 开关写入的 `voiceEnabled`、`voiceProvider` 设置属于**同一个文件**。历史上此处裸读 `~/.claude/settings.json`（忽略 `CLAUDE_CONFIG_DIR`），自定义配置目录下会静默丢 key，已修复（`2600b9de`）。

**核心流程**：
- `connectGroqStream()` 返回 `VoiceStreamConnection` 接口
- 接收 PCM 音频块并缓冲
- `finalize()` 时将 PCM 转换为 WAV（`pcmToWav()`，16-bit 单声道，16000 Hz）
- 通过 `File` API 上传 WAV 到 Groq

---

### 2. Local Whisper（whisper.cpp 本地转录）

文件：`src/services/voice/providers.ts`（类 `LocalWhisperSTT`）

调用本地 `whisper.cpp` 命令行二进制（非 Python 子进程）：

- 二进制探测顺序：显式 `opts.binary` → PATH 中的 `whisper.cpp` / `whisper-cpp` / `whisper` / `main` → `~/.local/bin/whisper.cpp` → Homebrew / `/usr/local`
- 输出 txt 到临时目录后读回；未产出输出时报 `whisper produced no txt output`
- 找不到二进制时返回 `{ success: false, error: 'no whisper binary found' }`

> 注意：该类当前未接入 `useVoice` hook（无调用方），作为库代码保留。

---

### 3. Doubao（豆包 STT，生成存根）

文件：`src/services/voice/doubaoSTT.ts`

此文件是自动生成的占位存根（`@generated stub from scan-missing-imports`），用 `Proxy` 把任意属性访问/调用/构造映射为 noop，仅用于满足 bun build 的模块解析。**当前无任何 import 方**，外部构建 DCE 后不会执行。

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

`EdgeTTSProvider` 和 `CommandTTSProvider` 是内置实现（作为库代码保留，当前无直接调用方）；实际接入 hook 的 TTS 路径是 `edgeTTS.ts` 的函数（见下）。

---

### 1. Edge TTS（微软神经网络语音）

**实现路径一（Provider 类）**：
文件：`src/services/voice/providers.ts`（类 `EdgeTTSProvider`）

- 调用 `edge-tts` 命令行工具（`child_process.spawn`）
- 参数：`--voice`、`--text`、`--write-media`
- 默认语音：`en-US-AriaNeural`
- 输出写入 `~/.claude/voice/tts_<ts>.mp3`

**实现路径二（独立函数）**：
文件：`src/services/voice/edgeTTS.ts`

- `speakWithEdgeTTS()` / `edgeTts()`：调用 **`node-edge-tts` npm 包**（Node 原生实现，无 Python 依赖），默认语音 `en-US-JennyNeural`
- `checkEdgeTTSAvailable()`：探测 `node-edge-tts` 可导入性
- `playAudioFile()` 播放：

| 平台 | 播放器 | 说明 |
|------|--------|------|
| macOS | `afplay` | 原生 |
| Linux | `ffplay` | 先 `pkill -9 ffplay` 已有进程，再启动新进程 |
| Windows | `start` | 系统默认播放器 |

自动播放入口：`useAutoTTS` hook（`src/hooks/useAutoTTS.ts`，由 `Messages.tsx` 挂载）调用 `edgeTts()` 合成、`playAudioFile()` 播放。

---

### 2. Command TTS（命令模板回退）

文件：`src/services/voice/providers.ts`（类 `CommandTTSProvider`）

通用 shell 命令 TTS，支持模板占位符：
- `{input}` / `{input_path}` —— 输入文本文件路径
- `{output_path}` —— 输出音频文件路径

适用于调用任意外部 TTS 命令行工具。

---

## Voice Mode（语音模式）

语音模式是 Push-to-Talk（按住说话）的实现，链路如下：

1. **开启**：`/voice` 命令切换用户设置中的 `voiceEnabled`（`src/commands/voice/voice.ts`），provider 由 `voiceProvider === 'groq'` 决定（`useVoice.ts`）
2. **挂载**：`REPL.tsx` 在 `feature('VOICE_MODE')` 下条件 require `useVoiceIntegration`
3. **开始录音**：用户按下语音快捷键（默认绑定 `space: voice:pushToTalk`，见 `src/keybindings/defaultBindings.ts`）
4. **音频采集**：cpal 或回退方案采集 16kHz 单声道 PCM
5. **识别**：音频块送入 `connectGroqStream()` 缓冲，松开快捷键后 `finalize()` 一次性上传 Groq 转写
6. **提交文本**：转写文本进入对话输入流
7. **自动朗读**（可选）：`useAutoTTS` 对回复合成并播放 TTS 音频

---

## 提供商注册与选择

文件：`src/services/voice/providers.ts`

系统通过 `TranscriptionProvider` / `TTSProvider` 接口实现多提供商支持。STT 的选择由 `useVoice` hook 依据用户设置（`voiceProvider`）与可用性决定，当前固定走 Groq 云端流式接口；`LocalWhisperSTT` 与 TTS Provider 类作为库实现保留，尚未接线。

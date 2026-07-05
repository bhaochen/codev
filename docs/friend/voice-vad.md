# 语音捕获与 VAD 策略

本文档详细描述 Friend 系统的音频捕获、语音活动检测 (VAD)、语音转文字 (STT) 和静音管理策略。

---

## 1. 音频捕获

### 1.1 子进程架构

Friend 使用子进程方式进行音频捕获，而非原生 NAPI 绑定。这是因为 cpal 的同步 NAPI 调用在 ALSA 初始化卡顿时会阻塞事件循环，且无法从 JS 侧超时。

**文件**: `src/friend/FriendService.ts` — `loadAudioCapture()` 方法

```typescript
private async loadAudioCapture(): Promise<AudioCaptureProvider> {
  // 使用 arecord / parecord 子进程
  // 尝试顺序: arecord (ALSA) → parecord (PulseAudio)
}
```

### 1.2 工具选择与参数

**arecord** (ALSA):
```
-D default    # 默认设备
-r 16000      # 采样率 16kHz
-f S16_LE     # 16位有符号小端 PCM
-c 1          # 单声道
-t raw        # 原始 PCM 格式
-q            # 静默模式
```

**parecord** (PulseAudio):
```
--raw              # 原始 PCM
--rate=16000       # 16kHz
--format=s16le     # 16位有符号小端
--channels=1       # 单声道
--latency-msec=20  # 低延迟
```

### 1.3 验证机制 (500ms 窗口)

子进程启动后有 500ms 验证窗口：

```typescript
// 启动子进程后等待 500ms
// 若子进程在此时间内产生了音频数据 → 验证通过
// 若子进程退出且未产出数据 → 验证失败，尝试下一个工具
// 若 500ms 无数据 → 验证失败
```

这防止了 `parecord` 在 PulseAudio 不可用时静默失败的问题（进程启动但立即退出）。

### 1.4 数据回调

```typescript
const feedAudio = (chunk: Buffer) => {
  // 1. 静音过滤: muted 时不转发（防止 TTS 回声）
  if (this.muted) return;

  // 2. 转发到 STT 连接
  onData(chunk);

  // 3. 转发到 VAD 检测
  if (this.vadInstance) {
    const float32 = new Float32Array(chunk.length / 2);
    for (let i = 0; i < float32.length; i++) {
      float32[i] = chunk.readInt16LE(i * 2) / 32768;
    }
    this.vadInstance.processAudio(float32).catch(() => {});
  }
};
```

### 1.5 停止逻辑

```typescript
stopRecording: async () => {
  if (captureProc) {
    captureProc.kill('SIGTERM');
    // 2s 后强制 SIGKILL（防止僵进程）
    setTimeout(() => {
      try { captureProc?.kill('SIGKILL'); } catch {}
    }, 2000);
    captureProc = null;
  }
},
```

---

## 2. STT Provider 检测与降级

### 2.1 自动检测链

**文件**: `src/friend/FriendService.ts` — `detectAvailableSttProvider()` 方法

```typescript
detectAvailableSttProvider()
    │
    ├── 1. Groq Whisper (isGroqAvailable)
    │   最快 - REST API 调用，无需 Python
    │   检测: 检查 API key 是否存在
    │
    ├── 2. Local Whisper (checkLocalWhisperAvailable)
    │   本地运行，无需网络
    │   检测: 导入 connectLocalWhisperStream 检查
    │
    ├── 3. Anthropic Voice Stream (isVoiceStreamAvailable)
    │   通过 Anthropic API 的流式语音识别
    │   检测: 检查登录状态和 API key
    │
    ├── 4. Doubao ASR
    │   通过豆包 API
    │   检测: 检查 ~/.claude/tts/doubao/credentials.json
    │
    └── 全不可用 → 抛出错误
        "No STT provider available. Install local Whisper: pip install openai-whisper"
```

### 2.2 STT Provider 特性对比

| Provider | 延迟 | 依赖 | 是否需要网络 | 支持语言 |
|----------|------|------|-------------|---------|
| **Groq Whisper** | 低 | API key | 是 | 多语言 |
| **Local Whisper** | 中 | Python + pip | 否 | 多语言 |
| **Anthropic Voice Stream** | 低 | Anthropic 登录 | 是 | 多语言 (keyterms支持) |
| **Doubao ASR** | 中 | 凭据文件 | 是 | 中文最佳 |

### 2.3 STT 连接超时

所有 provider 连接都有 8 秒超时：

```typescript
startSttConnectionWithTimeout(provider, language)
    ├── 超时 8s
    └── 超时错误提示: "STT provider '{provider}' timed out after 8s."
        └── provider === 'local' 时附带 pip 安装提示
```

### 2.4 连接工厂

```typescript
startSttConnection(provider, language)
    │
    ├── anthropic: connectVoiceStream(callbacks, { language, keyterms })
    │    keyterms: ['code', 'codev'] 提高相关词汇识别率
    │
    ├── local: preloadWhisperModel + connectLocalWhisperStream
    │    需预加载模型（首次加载较慢）
    │
    ├── doubao: connectDoubaoStream(callbacks, { language })
    │
    └── groq: connectGroqStream(callbacks, { language })
        最快，纯 REST 流式调用
```

### 2.5 回调接口

```typescript
const callbacks = {
  onTranscript: (text: string, isFinal: boolean) => {
    if (isFinal) {
      this.captureTranscripts.push(text);  // 最终文本入队列
      this.captureInterimText = '';
    } else {
      this.captureInterimText = text;       // 临时文本（前端轮询显示）
    }
    // 更新状态供前端轮询
    this.setState({
      captureStatus: { capturing: true, interimText: this.captureInterimText },
    });
  },
  onError: (_error: string) => {},
  onClose: () => {},
  onReady: (_conn: any) => {},
};
```

---

## 3. Silero VAD 架构

**文件**: `src/friend/voice/vad-service.ts` (~322 行)

### 3.1 为什么选择 onnxruntime-web WASM

Bun 不支持 onnxruntime-node 原生插件（会触发 segfault），因此使用 onnxruntime-web 的 WASM 后端。WASM 二进制文件来自 `onnxruntime-web/dist`。

### 3.2 模型规格

- **模型**: Silero VAD legacy ONNX (来自 `@ericedouard/vad-node-realtime`)
- **模型文件**: `silero_vad_legacy.onnx`
- **输入**: 512 采样帧 @ 16kHz (32ms)
- **输出**: 语音概率 (0-1)
- **LSTM 状态**: h=[2,1,64], c=[2,1,64]

### 3.3 配置参数

```typescript
this.opts = {
  // 说话判定阈值
  positiveSpeechThreshold: 0.75,    // 超过此值判定为语音帧
  negativeSpeechThreshold: 0.50,    // 低于此值判定为静音帧

  // 触发条件
  preSpeechTriggerFrames: 10,       // 需要连续 10 帧 (320ms) 确认说话
  minSpeechFrames: 6,               // 最少 6 帧 (192ms) 有效语音

  // 静音消音
  redemptionFrames: 20,             // 连续 20 帧 (640ms) 静音结束段落

  // 前置填充
  preSpeechPadFrames: 10,           // 段落开头包含 10 帧前置音频

  // 能量过滤
  rmsThreshold: 0.004,              // RMS 能量阈值 (-48dBFS 噪声底限)

  // 采样率
  sampleRate: 16000,                // 16kHz
};
```

### 3.4 RMS 能量预过滤（噪声抑制）

RMS 预过滤是 VAD 的**第一道噪声防线**。在运行 ONNX 推理之前，先计算帧的 RMS 能量：

```typescript
let sumSq = 0;
for (let i = 0; i < frame.length; i++) {
  sumSq += frame[i] * frame[i];
}
const rms = Math.sqrt(sumSq / frame.length);

if (rms < this.opts.rmsThreshold) {
  prob = 0;  // 低于噪声底限 → 跳过 ONNX 推理
} else {
  // 执行 ONNX 推理
  prob = await this.session.run({ input, sr, h, c });
}
```

作用：
- 节省 CPU 资源（大量帧无语音信号）
- 过滤机械噪声/麦克风碰撞/环境静音（噪声抑制）
- 降低误触发率

注：FriendService 中使用更严格的阈值 `0.01`（-40dBFS）而非 SileroVAD 的默认 `0.004`，以减少非语音噪音造成的误触发。

### 3.5 状态机详解

```
              ┌──────────────────────────────────────────────────┐
              │                  pre-speech phase               │
              │  preSpeechCount < preSpeechTriggerFrames (10)   │
              │                                                  │
              │  语音帧 → preSpeechCount++                      │
              │  非语音帧 → preSpeechCount = 0                  │
              │                                                  │
              │  当 preSpeechCount >= 10:                        │
              │    → speaking = true                             │
              │    → speechFrameCount = preSpeechCount           │
              │    → onSpeechStart()                             │
              └──────────────────────┬───────────────────────────┘
                                     │
                                     ▼
              ┌──────────────────────────────────────────────────┐
              │                 speaking phase                   │
              │                                                  │
              │  语音帧 → redemptionCounter = 0                 │
              │  静音帧 → redemptionCounter++                    │
              │                                                  │
              │  当 redemptionCounter >= 20 (640ms):             │
              │    → endSpeech()                                 │
              │    → onSpeechEnd(audioSegment)                   │
              └──────────────────────────────────────────────────┘
```

### 3.6 段落构建

当 onSpeechEnd 触发时，构建包含前置填充的音频段：

```typescript
private endSpeech(): void {
  // 1. 检查最小语音帧数 (防止误触发)
  if (this.speechFrameCount < this.opts.minSpeechFrames) {
    this.callbacks.onVADMisfire();  // 误触发回调
    return;
  }

  // 2. 构建音频段 (含前置填充)
  const total = this.frameHistory.length;
  const prePad = Math.min(this.opts.preSpeechPadFrames, total);
  const segFrames = this.frameHistory.slice(
    total - prePad - this.speechFrameCount,
    total
  );
  // 合并所有帧为一个 Float32Array
  const segment = new Float32Array(totalSamples);
  for (const f of segFrames) { segment.set(f.frame, offset); offset += ... }

  // 3. 回调
  this.callbacks.onSpeechEnd(segment);
}
```

### 3.7 VAD 生命周期

```typescript
class SileroVad {
  async init()     // 加载 ONNX 模型 (初始化)
  start()          // 激活 VAD 处理
  pause()          // 暂停 + 结束当前语音段
  processAudio()   // 处理 PCM 音频帧
  flush()          // 刷新剩余缓冲区 + 结束段
  reset()          // 重置全部状态 (保留 session)
  destroy()        // 清理资源
}
```

### 3.8 VAD 初始化失败的处理

VAD 初始化失败是非致命的：

```typescript
vad.init()
  .then(() => { this.vadInstance = vad; })
  .catch((e) => {
    console.warn('[FriendService] VAD init failed (non-fatal, voice capture falls back to F2-only):', e);
  });
```

当 VAD 不可用时，F2 语音通话模式降级为手动分段（仍可通过 PTT 模式使用语音）。

---

## 4. 静音系统

### 4.1 为什么需要静音

当 AI 回复通过 TTS 播放时，扬声器声音会被麦克风捕获，如果不做静音处理会产生两种问题：
1. **TTS 回声**: 自己的语音进入 STT 造成重复识别
2. **打断 AI 回复**: 用户未说话但环境噪声导致 VAD 误触发

### 4.2 静音策略

```
startAiTurnMute() ──── 在语音片段提交时立即静音
    │
    ├── muted = true
    ├── vadInstance.pause()
    └── 30s 超时定时器 (安全性保障)
    │
    ▼
AI 处理 (工具调用、深度思考)
    │
    ▼
broadcastResponse() → generateTts()
    │
    ├── TTS 成功:
    │   └── extendMuteForTts(audioId)
    │       ├── 取消 30s 定时器
    │       └── 设置精确的 TTS 播放时长定时器
    │
    ├── TTS 失败:
    │   └── unmute() (立即解除静音)
    │
    ▼
TTS 播放完毕 → unmute()
    ├── muted = false
    ├── muteTimer = null
    └── vadInstance.start()    (恢复 VAD 监听)
```

### 4.3 定时器精确控制

- **初始静音**: 30s（覆盖几乎所有 AI 响应周期）
- **精确调整**: TTS 生成后通过 MP3 时长解析精确控制
- **安全性保障**: 任何情况下都不会永久静音

### 4.4 清除静音 (紧急情况)

```typescript
stopVoiceCapture() → _stopCapture()
    ├── 停止音频捕获
    ├── clearMute()  (立即解除静音)
    └── VAD reset()
```

---

## 5. MP3 时长解析

**文件**: `src/friend/FriendService.ts` — `getMp3DurationMs()` 方法

### 5.1 帧同步头扫描法

不使用 bitrate 查找表（容易出错），而是通过实际帧间隔计算：

```typescript
private getMp3DurationMs(audioId: string): number {
  // 1. 获取音频文件路径
  const filePath = getAudioFile(audioId);
  const buf = readFileSync(filePath);

  // 2. 跳过 ID3v2 标签 (如果存在)
  if (buf[0..2] === 'ID3') {
    offset = 10 + syncsafe_int(buf[6..9]);
  }

  // 3. 找到前两个帧同步字
  // 帧同步: 0xFF 字节 + 0xE0 掩码
  for (let i = offset; i < buf.length - 3; i++) {
    if (isSync(i)) {
      if (firstSync === -1) firstSync = i;
      else { secondSync = i; break; }
    }
  }

  // 4. 计算帧间隔 (CBR 模式)
  const frameSize = secondSync - firstSync;

  // 5. 解析帧头获取采样率
  const h = read32BE(firstSync);
  const version = (h >> 19) & 0x3;
  const sampleRateIdx = (h >> 10) & 0x3;
  // MPEG1 → 1152 samples/frame, MPEG2/2.5 → 576

  // 6. 按步长计数帧数 (帧损坏时扫描到下一个同步字)
  for (let pos = firstSync; pos + 3 < buf.length; pos += frameSize) {
    if (!isSync(pos)) {
      // 损坏帧: 扫描到下一个同步字
      while (pos < buf.length - 3 && !isSync(pos)) pos++;
    }
    frames++;
  }

  // 7. 计算时长
  return Math.round((frames * spf) / sampleRate * 1000);
}
```

### 5.2 为什么自实现 MP3 解析

- Edge TTS 输出 CBR MP3
- 不依赖外部库（减少依赖项）
- 帧同步头扫描法对 CBR 精确且鲁棒
- 处理文件损坏的帧 (向前扫描下一个同步字)

---

## 6. 前端语音捕获 (useServerStt hook)

**文件**: `src/components/friend/frontend/hooks/useServerStt.ts`

### 6.1 设计原因

Tauri 使用 WebKitGTK，不兼容 `onnxruntime-web` WASM 后端，因此浏览器 VAD (`@ricky0123/vad-web`) 不可用。前端将语音捕获完全委托给后端。

### 6.2 两种模式

**Push-to-Talk (PTT)**:
```typescript
startPushToTalk() → POST /voice/start  // 后端开始捕获
stopPushToTalk()  → POST /voice/stop   // 后端停止并返回转录
```

**Voice Call (F2 模式)**:
```typescript
startStreaming(onTranscript, onError) → POST /voice/start
    │
    ├── 后端持续捕获麦克风音频
    ├── 后端自动分段 (VAD / 定时 5s) 并转录
    ├── 前端每 1s 轮询 POST /voice/status 获取 interimText
    └── 显示在输入栏中

stopStreaming() → POST /voice/stop
    └── 结束后端捕获，返回完整转录
```

### 6.3 前端语音通话交互

```typescript
// TTS 中断: 用户说话时延迟 1s 中断当前 TTS
const scheduleInterrupt = useCallback(() => {
  setTimeout(() => {
    ;(window as any).__clawInterruptAudio?.()
  }, 1000)
}, [])

// 显示控制: 转录文字显示 3s 后自动清除
setTimeout(() => {
  if (voiceCallActiveRef.current) {
    setText('')
  }
}, 3000)
```

---

## 7. 浏览器 VAD 片段转录

前端浏览器 VAD（非 WebKitGTK 环境）检测到语音段落后，通过 HTTP 发送到后端：

```typescript
// POST /plugins/friend/voice/stt-segment
// Body: raw PCM/WAV buffer
handleFriendApi → friendService.transcribeAudioSegment(audioBuffer)
    │
    ├── 检测 STT provider (自动降级)
    ├── 创建临时 STT 连接
    ├── 发送音频 → 等待 finalize
    └── 发送转录文本到 AI 对话
```

---

## 总结: 语音路径选择

| 使用场景 | VAD | STT Provider | 音频来源 | 静音需求 |
|---------|-----|------------|---------|---------|
| Push-to-Talk (PTT) | 否 (人工分段) | 自动检测 | arecord/parecord | 否 |
| F2 语音通话 | Silero VAD | 自动检测 → 分段 flush | arecord/parecord | 是 |
| 浏览器 VAD (非 Tauri) | 浏览器 VAD | STT segment API | getUserMedia | 否 |
| 文字输入 | 不适用 | 不适用 | 键盘 | 不适用 |

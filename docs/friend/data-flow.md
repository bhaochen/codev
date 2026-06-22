# Friend 数据流

本文档详细描述 Friend 系统中的四种核心数据流，以及 SSE 事件格式规范。

---

## 1. 文字对话流

用户在前端输入框输入文字，按下 Enter 发送。

```
用户输入文字
    │
    ▼
ChatInput.tsx  ── POST /plugins/friend/chat ──────────────────┐
    │                              { message: "你好" }         │
    │                                                          │
    ▼                                                          │
handleFriendApi()  ── friendService.start()                    │
    │                 friendService.sendText(message)           │
    ▼                                                          │
FriendService.sendText()                                       │
    │                                                          │
    ├── 通知 inboundListeners (bridge hook turn tracking)      │
    │                                                          │
    └── messageQueueManager.enqueue()                          │
        │  { mode: 'prompt', skipSlashCommands: true,          │
        │    bridgeOrigin: true, origin: { server: 'friend' }} │
        │                                                      │
        ▼                                                      │
    AI Provider (Anthropic/NVIDIA/OpenAI)                      │
        │                                                      │
        ├── 处理消息                                           │
        ├── 可调用 friend_emotion 工具设置表情                  │
        ├── 可调用 friend_screen_observe 观察屏幕               │
        │                                                      │
        ▼                                                      │
    AI 回复流回 (通过 useFriendBridge / REPL)                   │
        │                                                      │
        ▼                                                      │
    FriendService.broadcastResponse(text)                      │
        │                                                      │
        ├── broadcastToVrm({ text })                           │
        │       │                                              │
        │       ▼ SSE data                                     │
        │   TextBubble 收到                                     │
        │       │                                              │
        │       ├── 重置气泡，显示文字                          │
        │       ├── 启动打字机效果 (逐字符显示)                 │
        │       │   - CJK: 200ms/char (TTS开启) / 80ms (关闭)  │
        │       │   - English: 60ms/char (TTS开启) / 30ms (关闭)│
        │       ├── 打字机完成后渲染 Markdown                    │
        │       └── 1秒后触发 onMessage → VRMScene 表情动作    │
        │                                                      │
        ├── if TTS enabled:                                    │
        │   ├── generateTts(text)                              │
        │   │   ├── stripForTts() 清洗文本                     │
        │   │   └── EdgeTTS 或 QwenTTS 生成 MP3                │
        │   │                                                 │
        │   ├── broadcastToVrm({ audioUrl, sendFirstTts })     │
        │   │       │                                           │
        │   │       ▼ SSE data                                 │
        │   │   TextBubble 开始音频队列播放                     │
        │   │       │                                           │
        │   │       └── LipSync.playAudio(url)                 │
        │   │           ├── fetch 音频文件                      │
        │   │           ├── decodeAudioData                     │
        │   │           ├── 连接到 lipSyncNode (分析) + gainNode (扬声器) │
        │   │           └── 播放时实时更新 VRM 嘴形             │
        │   │                                                 │
        │   └── extendMuteForTts(audioId)                      │
        │       └── 精确计算 MP3 时长，更新静音定时器           │
        │                                                      │
        └── broadcastToVrm({ replyDone: true })                │
                │                                               │
                ▼ SSE data                                     │
            TextBubble 调度气泡隐藏 (2s 延迟)                  │
                或等待后续 appendText 消息                      │
```

---

## 2. 语音捕获流 (F2 通话模式)

用户按下 F2 进入连续语音通话模式，再次按下 F2 结束通话。

### 2.1 启动通话

```
用户按 F2
    │
    ▼
ChatInput.startVoiceCall()
    │
    ├── setVoiceCallActive(true)
    │
    └── useServerStt.startStreaming()
        │
        └── POST /plugins/friend/voice/start
            │
            ▼
        handleFriendApi()
            │
            └── friendService.startVoiceCapture()
                │
                ├── 检测 STT provider (Groq→Whisper→Anthropic→Doubao)
                │
                ├── startSttConnection() (8s 超时)
                │   ├── Groq: connectGroqStream()
                │   ├── Local: connectLocalWhisperStream()
                │   ├── Anthropic: connectVoiceStream()
                │   └── Doubao: connectDoubaoStream()
                │
                ├── loadAudioCapture()
                │   ├── 尝试 arecord (ALSA)
                │   │   args: -D default -r 16000 -f S16_LE -c 1 -t raw -q
                │   ├── 失败则尝试 parecord (PulseAudio)
                │   │   args: --raw --rate=16000 --format=s16le --channels=1
                │   └── 500ms 验证窗口: 确认子进程输出音频数据
                │
                ├── arecord 数据回调:
                │   ├── if not muted → 转发到 STT connection.send(chunk)
                │   └── if not muted → 转发到 VAD processAudio(float32)
                │
                └── vadInstance.start()
```

### 2.2 语音检测与转录

```
麦克风音频流 (16kHz S16LE)
    │
    ├──► STT Connection.send(chunk)  (实时流式转录)
    │
    └──► SileroVad.processAudio(float32)
            │
            ├── RMS 预过滤 (阈值 0.004)
            │   ├── < 阈值 → 概率 = 0 (跳过推理)
            │   └── >= 阈值 → ONNX 推理
            │
            ├── 状态机
            │   ├── pre-speech: 需要连续 10 帧 (~320ms) 确认说话
            │   ├── speaking: 语音持续中
            │   └── silence redemption: 连续 20 帧 (~640ms) 静音触发 endSpeech
            │
            └── onSpeechEnd callback
                │
                ▼
            FriendService._flushVadSegment()
                │
                ├── 创建新的 STT 连接 (旧的连接继续处理)
                │
                ├── 等待旧连接 finalize()
                │   └── 获取转录文本推入 captureTranscripts
                │
                ├── if 有转录文本:
                │   ├── this.sendText(transcript)
                │   │       │
                │   │       ▼
                │   │   messageQueueManager.enqueue() → AI 开始处理
                │   │
                │   └── this.startAiTurnMute()
                │       ├── muted = true
                │       ├── VAD pause
                │       └── 30s 超时安全性定时器
                │
                └── 循环继续监听下一段语音
```

### 2.3 AI 回复与静音解除

```
AI 处理完成
    │
    ▼
FriendService.broadcastResponse(text)
    │
    ├── broadcastToVrm({ text })          // 显示文字
    │
    ├── if TTS enabled:
    │   ├── generateTts(text)
    │   │       │
    │   │       ▼
    │   ├── broadcastToVrm({ audioUrl, sendFirstTts: true })
    │   │
    │   └── extendMuteForTts(audioId)
    │       ├── getMp3DurationMs() 精确计算
    │       ├── 取消 30s 安全性定时器
    │       └── 设定精确的播放时长定时器
    │
    └── broadcastToVrm({ replyDone: true })
        │
        ▼
    播放完成后 → unmute()
        ├── muted = false
        └── VAD resume (可继续接收语音)
```

### 2.4 结束通话

```
用户按 F2 (再次)
    │
    ▼
ChatInput.endVoiceCall()
    │
    └── useServerStt.stopStreaming()
        │
        └── POST /plugins/friend/voice/stop
            │
            ▼
        friendService.stopVoiceCapture()
            │
            ├── arecord.kill('SIGTERM') → 2s 后 SIGKILL
            ├── capturing = false
            ├── clearMute()
            ├── VAD reset()
            ├── STT connection.finalize() + close()
            ├── 发送剩余转录文本
            └── 返回完整转录
```

---

## 3. 情绪表情流

LLM 调用 `friend_emotion` 工具触发情绪更新。

```
LLM 处理完成，调用 friend_emotion 工具
    │
    ▼
FriendEmotionTool.call({ emotion: 'happy', intensity: 0.8, mood_delta: 2 })
    │
    ├── broadcastToVrm({ emotion: 'happy', emotionIntensity: 0.8 })
    │       │
    │       ▼ SSE data
    │   App.tsx handleVrmMessage
    │       │
    │       ├── emotionActionMap['happy'] = 'happy'
    │       │
    │       ├── sceneRef.current.setEmotionWithReset('happy', 5000, 0.8)
    │       │       │
    │       │       ▼
    │       │   VRMScene.setEmotionWithReset (via forwardRef)
    │       │       │
    │       │       └── EmoteController.setEmotionWithReset('happy', 5000, 0.8)
    │       │           ├── setEmotion('happy', 0.8)
    │       │           │   ├── 获取 happy 的 blend shapes: [{name:'happy', val:0.2}, {name:'aa', val:0.8}]
    │       │           │   ├── 应用 intensity: aa = 0.8*0.8 = 0.64, happy = 0.2*0.8 = 0.16
    │       │           │   ├── isTransitioning = true
    │       │           │   └── 记录目标 blendshape 值
    │       │           │
    │       │           └── setTimeout(5000ms → setEmotion('neutral'))
    │       │
    │       └── sceneRef.current.playAction('happy')
    │               │
    │               ▼
    │           MotionController.playAction('happy')
    │               ├── loadClip('happy.fbx')
    │               ├── crossFadeTo(clip, 0.3s)
    │               ├── LoopOnce + clampWhenFinished
    │               └── 完成后 crossFade 回 idle 动画
    │
    ├── 处理 mood_delta
    │   ├── 读取当前 moodIndex = 60
    │   ├── newMood = clamp(60 + 2, 0, 100) = 62
    │   ├── 持久化到 prefs
    │   └── broadcastToVrm({ moodDelta: 2, moodIndex: 62 })
    │           │
    │           ▼ SSE data
    │       MoodIndicator 收到
    │           ├── 显示心情数值变化气泡 (+2)
    │           ├── Canvas 动画: displayPercent 从 60 → 62 渐变
    │           └── 5s 后自动隐藏
    │
    └── 返回 tool result
```

### 每帧更新循环 (VRMScene animate)

```
requestAnimationFrame 循环 (约 60fps)
    │
    ├── 1. MotionController.update(delta)
    │   └── AnimationMixer.update(delta)
    │
    ├── 2. 应用 Relaxed Hand Pose (非舞蹈状态)
    │   └── 手指自然弯曲 + 微妙颤动
    │
    ├── 3. Humanoid.update()
    │
    ├── 4. 眼球追踪 (camera 模式)
    │   └── lookAtTarget = camera.position
    │
    ├── 5. LookAt.update(delta)
    │
    ├── 6. Eye Saccades Controller.update()
    │   └── 每隔 400-1200ms 添加随机眼球微动偏移
    │
    ├── 7. Blink State Machine.update()
    │   └── 随机眨眼 (间隔 1-6s, 时长 150ms, sin 曲线)
    │
    ├── 8. EmoteController.update(delta)
    │   └── cubic ease 过渡到目标 blendshape 值
    │
    ├── 9. LipSync.update(vrm, delta)
    │   ├── 读取 wlipsync 音频分析节点的音素权重
    │   ├── 选择胜者/亚军音素
    │   ├── Attack/Release 平滑 (50/30)
    │   └── 设置 VRM 嘴形 blendshapes (aa, ee, ih, oh, ou)
    │
    ├── 10. ExpressionManager.update()
    │
    └── 11. SpringBoneManager.update(delta)
        └── 物理头发/衣服/饰品模拟
```

---

## 4. SSE 事件格式

所有前端 SSE 事件通过 `GET /plugins/friend/events` 接收，格式为标准 SSE (`data: {json}\n\n`)。

### 4.1 VrmBroadcastPayload 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 否 | AI 回复文字，TextBubble 显示并启动打字机效果 |
| `emotion` | string | 否 | VRM 表情名，触发 EmoteController 切换 blend shapes |
| `emotionIntensity` | number | 否 | 表情强度 0-1，默认 1 |
| `audioUrl` | string | 否 | TTS 音频 URL，TextBubble 触发 LipSync 播放 |
| `audioIndex` | number | 否 | 音频播放顺序索引，用于多句排序 |
| `clearText` | boolean | 否 | 清空气泡文字和音频队列 |
| `imageUrl` | string | 否 | 图片 URL，在气泡中显示 |
| `moodDelta` | number | 否 | 心情变化量，MoodIndicator 显示浮动气泡 |
| `moodIndex` | number | 否 | 当前心情指数 0-100，MoodIndicator Canvas 更新 |
| `sendFirstTts` | boolean | 否 | 开始 TTS 播放的信号，重置音频队列 |
| `appendText` | boolean | 否 | 追加文字模式，后续句子的文字和音频配对 |
| `replyDone` | boolean | 否 | 回复完成信号，TextBubble 调度气泡隐藏 |

### 4.2 典型回复序列

```
1. { text: "你好！今天心情不错啊！", replyDone: true }
    → 显示文字，打字机效果，1s 后触发表情

2. { text: "一起玩吧！" }
   { audioUrl: "http://127.0.0.1:3456/plugins/friend/audio/123-1", sendFirstTts: true }
   { replyDone: true }
    → 显示文字 + 播放 TTS + 语音结束后隐藏气泡

3. { text: "今天天气真好。" }
   { audioUrl: "...", sendFirstTts: true, emotion: "happy", emotionIntensity: 0.8 }
   { appendText: true, text: "要不要出去走走？", audioUrl: "...", audioIndex: 1 }
   { appendText: true, text: "我知道一个好地方。", audioUrl: "...", audioIndex: 2 }
   { replyDone: true }
    → 多句子回复，每句独立音频，按索引顺序播放
    → 第一句发送时触发 happy 表情

4. { emotion: "think", emotionIntensity: 0.7 }
    → 思考阶段的表情更新（LLM 处理中）

5. { clearText: true }
    → 清空气泡（新会话）

6. { moodDelta: 3, moodIndex: 63 }
    → 心情更新，显示 +3 浮动气泡，Canvas 液态填充变化
```

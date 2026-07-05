# VRM 桌面伴侣系统

## 定位

Friend 是 Codev 的 VRM 3D 桌面伙伴系统，与 CLI 共享同一进程运行。它通过 SSE + HTTP 与 Tauri 前端通信，无需独立的子进程或外部服务。用户可以与 VRM 角色进行文字聊天、语音对话，角色会通过 3D 表情、肢体动作和语音进行反馈。

核心设计理念：**同进程集成** — FriendService 作为单例运行在 CLI 主进程中，消息通过 `messageQueueManager.enqueue()` 直接注入到对话流程中，AI 回复通过 SSE 实时广播到前端显示。

---

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| **FriendService** | `src/friend/FriendService.ts` (~31KB) | 核心编排器，管理生命周期、语音捕获、STT/TTS、SSE 广播、静音系统 |
| **SSE 模块** | `src/friend/sse.ts` | 客户端注册表，类型化广播 `VrmBroadcastPayload` |
| **HTTP 服务器** | `src/friend/server.ts` | Bun.serve() 在 3456 端口，处理静态文件、API 路由、SSE 连接 |
| **API 路由** | `src/server/api/friend.ts` | `/plugins/friend/*` 的所有 REST 端点 |
| **TTS 服务** | `src/friend/tts.ts` | Edge TTS + Qwen DashScope TTS，音频文件注册表 |
| **STT 服务** | `src/friend/stt-service.ts` | 基于文件的语音转录（REST 端点） |
| **VAD 服务** | `src/friend/voice/vad-service.ts` | Silero VAD ONNX 模型，onnxruntime-web WASM 后端 |
| **偏好设置** | `src/friend/prefs.ts` | 持久化到 `~/.config/Codev/friend.json` |
| **Tauri 启动器** | `src/friend/tauri-launcher.ts` | 启动 Tauri 桌面窗口 |
| **前端应用** | `src/components/friend/frontend/` | React + Three.js + @pixiv/three-vrm |

---

## LLM 集成

Friend 通过三种方式与 LLM 深度集成：

### 1. `friend_emotion` 工具
- 定义在 `src/tools/FriendEmotionTool.ts`
- LLM 可在每次回复后调用，设置角色表情和心情
- 参数：`emotion` (13种情绪之一)、`intensity` (0-1)、`mood_delta` (-3 到 +3)
- 通过 `broadcastToVrm()` 向 SSE 客户端广播表情切换
- `mood_delta` 会持久化到 prefs 中的 `_moodIndex`，并广播给前端心情指示器

### 2. `friend_screen_observe` 工具
- 定义在 `src/tools/FriendScreenObserveTool.ts`
- 捕获桌面截图，返回图片路径
- LLM 使用 Read 工具查看截图后，以同伴身份回应
- 自动广播 `think` 表情到前端

### 3. friendPrompt 技能注入
- 定义在 `src/skills/bundled/friendPrompt.ts`
- 自动注入系统提示，告知 LLM 拥有 VRM 虚拟形象
- 包含情绪列表、心情指数、对话风格指引

---

## 情绪系统

Friend 支持 13 种情绪，映射到 VRM blend shapes 和骨骼动画：

- `happy`, `sad`, `angry`, `surprised`, `think`, `awkward`, `question`, `curious`, `neutral`, `love`, `flirty`, `greeting`, `relaxed`

每种情绪在 `src/components/friend/frontend/emote.ts` 中定义了：
- VRM blend shapes 组合及权重
- 过渡时间（cubic ease 缓动）
- 自动回中到 neutral 的定时器

情绪与肢体动作在 `App.tsx` 的 `emotionActionMap` 中关联。

---

## 交互模式

### 文字聊天
用户在输入框输入文字，通过 `POST /plugins/friend/chat` 发送到后端，FriendService 调用 `sendText()` 将消息通过 `messageQueueManager.enqueue()` 注入 CLI 对话流程。

### PTT 按键通话
按住麦克风按钮进行语音录制，松开后语音数据被发送到 STT 服务转录为文字，然后提交到对话流程。

### F2 语音通话
按下 F2 进入连续语音通话模式。服务器端通过 `arecord`/`parecord` 持续捕获麦克风音频，Silero VAD 自动检测语音段落边界，转录后自动发送给 AI 处理。AI 回复通过 TTS 播放，期间静音系统阻止回声。

---

## 简要架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    Codev 主进程 (Bun)                      │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │   CLI TUI    │    │   LLM Provider   │    │   Bridge API  │  │
│  │  (React Ink) │◄──►│  (Anthropic/NIM) │◄──►│  (SSE/HTTP)   │  │
│  └──────┬───────┘    └────────┬─────────┘    └───────────────┘  │
│         │                     │                                  │
│  ┌──────▼─────────────────────▼──────────────────────────────┐  │
│  │                   FriendService (单例)                     │  │
│  │  ┌────────────┐  ┌───────────┐  ┌───────────┐  ┌───────┐  │  │
│  │  │ STT 连接器 │  │ TTS 生成器│  │ VAD 检测  │  │静音系统│  │  │
│  │  │(Groq/等)   │  │(Edge/Qwen)│  │(Silero)   │  │       │  │  │
│  │  └────────────┘  └───────────┘  └───────────┘  └───────┘  │  │
│  └───────────────────────┬────────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────▼────────────────────────────────────┐  │
│  │               HTTP 服务器 (Bun.serve :3456)                 │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │ SSE /events  │  │ REST API     │  │ 静态文件服务     │  │  │
│  │  │             │  │ /chat /voice │  │ /friend/*        │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────────────┘  │  │
│  └───────────────────────┬────────────────────────────────────┘  │
└──────────────────────────┼────────────────────────────────────────┘
                           │ SSE + HTTP
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              Tauri 桌面窗口 (WebKitGTK)                          │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                 App.tsx (React 应用)                       │   │
│  │  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐  │   │
│  │  │ VRMScene │ │TextBubble│ │ChatInput│ │ MoodIndicator│  │   │
│  │  │ Three.js │ │SSE驱动   │ │PTT/通话│ │ Canvas 动画  │  │   │
│  │  └──────────┘ └──────────┘ └────────┘ └──────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  核心 3D 子系统:                                                 │
│  ┌─────────────┐ ┌────────────────┐ ┌──────────┐ ┌──────────┐  │
│  │EmoteController│ MotionController │  LipSync  │ TextBubble │  │
│  │blend shapes  │ VRMA/VMD/FBX    │ WebAudio  │ 打字机效果 │  │
│  │13种情绪映射  │ 舞蹈系统        │ 唇形同步  │ Markdown   │  │
│  └─────────────┘ └────────────────┘ └──────────┘ └──────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 文件位置

- 后端: `src/friend/` — FriendService, SSE, TTS, STT, VAD, prefs, server, launcher
- 前端: `src/components/friend/frontend/` — React app, Three.js 3D 场景
- API 路由: `src/server/api/friend.ts` — 所有 HTTP 端点
- LLM 工具: `src/tools/FriendEmotionTool.ts`, `src/tools/FriendScreenObserveTool.ts`
- 技能注入: `src/skills/bundled/friendPrompt.ts`
- 配置: `~/.config/Codev/friend.json`

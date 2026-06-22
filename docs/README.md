# VersperClaw 文档

> VersperClaw — 基于 Anthropic Claude Code 的增强型 AI CLI 代理，集成 VRM 桌面伴侣、多 Provider、语音对话和自动化模式。

## 目录

### 架构
| 文档 | 说明 |
|------|------|
| [项目架构概览](architecture/overview.md) | 技术栈、入口流程、模块职责、架构亮点 |
| [核心数据流](architecture/data-flow.md) | 5 大核心数据流：用户输入、语音捕获、远程桥接、Friend 表情、Provider 代理 |

### CLI 与工具
| 文档 | 说明 |
|------|------|
| [CLI 命令系统](cli/overview.md) | 命令注册、Slash 命令大全 (~75+)、Skill/工作流系统 |
| [AI 工具系统](tools/overview.md) | buildTool 框架、执行流程、权限系统、关键工具详解 |
| [工具参考大全](tools/tool-reference.md) | 所有 ~60+ AI 工具的完整参考表 |

### Friend VRM 伴侣
| 文档 | 说明 |
|------|------|
| [系统总览](friend/overview.md) | 定位、组件、交互模式、架构图 |
| [系统架构](friend/architecture.md) | FriendService、SSE、HTTP 服务器、TTS/STT/VAD 详细分析 |
| [数据流](friend/data-flow.md) | 文字对话/F2 语音/情绪表情/SSE 事件 四种流 |
| [情绪→3D 表情映射](friend/emotion-map.md) | 13 种情绪的 blend shape 组合、动作映射 |
| [前端 3D 渲染](friend/frontend-3d.md) | Three.js、EmoteController、MotionController、LipSync、TextBubble |
| [语音捕获与 VAD](friend/voice-vad.md) | Silero VAD 状态机、STT 提供者链、静音系统 |

### 语音
| 文档 | 说明 |
|------|------|
| [语音系统总览](voice/overview.md) | STT/TTS 提供者、Voice Stream 协议 |

### Ink 终端 UI
| 文档 | 说明 |
|------|------|
| [Ink UI 框架](ink-ui/overview.md) | 自定义 Fork 的渲染管线、组件库、事件系统 |

### 桌面服务器
| 文档 | 说明 |
|------|------|
| [HTTP/WS 服务器](server/overview.md) | Bun.serve()、REST API、WebSocket、服务层 |
| [Provider 代理](server/proxy-provider.md) | Anthropic ↔ OpenAI 协议转换、多提供商支持 |

### 后端服务
| 文档 | 说明 |
|------|------|
| [服务总览](services/overview.md) | MCP、上下文压缩、Auto Dream、飞书/Telegram |

### 协调与自动化
| 文档 | 说明 |
|------|------|
| [目标与自动模式](coordinator/goals-auto-mode.md) | Goal 系统、Auto Mode、查询循环、Task 系统 |
| [多代理协调](coordinator/multi-agent.md) | Coordinator 模式、Worker 派发、并行策略 |

### 远程桥接
| 文档 | 说明 |
|------|------|
| [远程桥接总览](remote-bridge/overview.md) | Bridge 模式、传输协议、认证机制 |

### 记忆与上下文
| 文档 | 说明 |
|------|------|
| [自动记忆系统](memory-context/memory.md) | Memdir、4 种记忆类型、生命周期 |
| [上下文管理](memory-context/context.md) | 系统/用户上下文构建、压缩策略、React Contexts |

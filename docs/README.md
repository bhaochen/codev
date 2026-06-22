# VersperClaw 文档

> VersperClaw — 基于 Anthropic Claude Code 的增强型 AI CLI 代理，集成 VRM 桌面伴侣、多 Provider、语音对话和自动化模式。

## 目录

### 架构
| 文档 | 说明 |
|------|------|
| [项目架构概览](architecture/overview.md) | 技术栈、入口流程、模块职责、架构亮点 |
| [核心数据流](architecture/data-flow.md) | 5 大核心数据流：用户输入、语音捕获、远程桥接、Friend 表情、Provider 代理 |
| [Agent 循环深度解析](architecture/agent-loop.md) | 663 行 | queryLoop 完整流程、StreamingToolExecutor、5 阶段 turn pipeline、恢复机制 |
| [设计哲学与架构原则](architecture/design-philosophy.md) | 329 行 | 5 大价值、13 设计原则、与 Claude Code arXiv paper 的映射 |
| [安全与权限系统](architecture/safety-and-permissions.md) | 867 行 | 7 种权限模式、Deny-first 规则引擎、Auto-mode ML 分类器、授权流水线 |
| [Provider 多厂商认证](architecture/provider-auth.md) | 646 行 | OAuth PKCE、Fetch Override、Anthropic↔OpenAI 协议转换、NVIDIA NIM |
| [跨切面关注点](architecture/cross-cutting.md) | 254 行 | 错误处理层次、遥测系统、性能优化策略 |

### CLI 与工具
| 文档 | 说明 |
|------|------|
| [CLI 命令系统](cli/overview.md) | 命令注册、Slash 命令大全 (~75+)、Skill/工作流系统 |
| [构建系统与功能标记](cli/build-system.md) | 676 行 | Bun 构建管道、48 个 feature flag、死代码消除、命令可用性门控 |
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
| [上下文压缩深度解析](services/compact-deep-dive.md) | 906 行 | 5 层压缩管线、Budget Reduction、Snip、Microcompact、Context Collapse、Auto-compact |

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

### 面试准备
| 文档 | 说明 |
|------|------|
| [面试准备指南](interview-prep.md) | 714 行 | 高频面试题、源码级解析、架构对比、设计权衡 |

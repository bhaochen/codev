# Provider 代理与多模型支持

## Proxy 协议转换

**文件**: `src/server/proxy/handler.ts`

Proxy Handler 是一个**协议转换反向代理**，接收 Anthropic Messages API 格式的请求，将其转换为 OpenAI Chat Completions 或 Responses API 格式，转发到上游第三方（3P）Provider，再将响应转换回 Anthropic 格式。

### 转换路线

```
Anthropic Messages API  ←→  OpenAI Chat Completions API
Anthropic Messages API  ←→  OpenAI Responses API
```

### 转换模块

所有转换逻辑位于 `src/server/proxy/transform/` 和 `src/server/proxy/streaming/`：

**请求转换（Anthropic → OpenAI）**:
- `anthropicToOpenaiChat.ts` — 转换非流式 Chat 请求
- `anthropicToOpenaiResponses.ts` — 转换非流式 Responses 请求

**响应转换（OpenAI → Anthropic）**:
- `openaiChatToAnthropic.ts` — Chat 响应转 Anthropic 格式
- `openaiResponsesToAnthropic.ts` — Responses 响应转 Anthropic 格式

**流式转换（OpenAI SSE stream → Anthropic SSE stream）**:
- `openaiChatStreamToAnthropic.ts` — Chat 流式响应转换
- `openaiResponsesStreamToAnthropic.ts` — Responses 流式响应转换
- `openaiResponsesStreamToAnthropicResponse.ts` — Responses 流聚合

**工具参数**:
- `toolArguments.ts` — 工具参数的兼容处理

**类型定义**:
- `types.ts` — `AnthropicRequest` 等共享类型

### 支持的 Provider

Proxy 支持以下第三方提供商（3P Provider）：

- **Groq** — 通过 OpenAI Chat API
- **OpenRouter** — 通过 OpenAI Chat API
- **OpenCode** — 通过 OpenAI Chat API，含 DeepSeek 推理兼容适配
- **本地模型** — 任何兼容 OpenAI API 的本地推理端点
- **其他 OpenAI 兼容 API** — 只要符合 OpenAI Chat/Responses 格式即可

### DeepSeek 兼容模式

当检测到上游 baseUrl 包含 `deepseek` 或 `opencode.ai` 时，自动启用 DeepSeek 推理兼容模式：
- 启用手动往返推理内容（`roundTripReasoningContent`）
- 传递 thinking toggle（`passThinkingToggle`）

## Provider 配置系统

**文件**: `src/server/services/providerService.ts`

ProviderService 实现了一个基于预设（Preset）的 Provider 配置系统。

### 数据存储

- **索引文件**: `~/.claude/cc-haha/providers.json`（轻量级索引）
- **环境变量**: 活跃 Provider 配置写入 `~/.claude/cc-haha/settings.json`
- **隔离策略**: 与原始 Claude Code 的 `~/.claude/settings.json` 完全隔离

### Preset 预设系统

**文件**: `src/server/config/providerPresets.ts` + `providerPresets.json`

每个预设包含：
- `id` / `name`: 唯一标识和显示名
- `baseUrl`: API 端点地址
- `apiFormat`: 格式类型（`openai_chat` 或 `openai_responses`）
- `defaultModels`: 模型映射（main / haiku / sonnet / opus）
- `needsApiKey`: 是否需要 API Key
- `authStrategy`: 认证策略
- `defaultEnv`: 默认环境变量
- `modelContextWindows`: 模型上下文窗口大小

### OpenCode 兼容

系统支持导入 OpenCode 的 Provider 配置，包括模型映射和 API 端点设置。

### haha 认证

自定义认证机制，支持两种 OAuth 流程：
- `hahaOAuthService.ts` — 通用 haha OAuth
- `hahaOpenAIOAuthService.ts` — OpenAI 专用 OAuth

## Two-Tier 访问架构

系统采用双层访问模式：

### Tier 1: 原生 SDK 直连

适用于 **Anthropic 用户**，直接使用官方 SDK：

- **Anthropic API** — 直接使用 `@anthropic-ai/sdk`
- **AWS Bedrock** — 通过 Bedrock SDK
- **GCP Vertex AI** — 通过 Vertex AI SDK

无需经过 Proxy 转换，性能最优。

### Tier 2: Proxy 协议转换

适用于 **第三方（3P）用户**，通过 Proxy 转换为 OpenAI 格式：

- 请求路径: `/proxy/v1/messages`（使用活跃 Provider）
- 请求路径: `/proxy/providers/:providerId/v1/messages`（指定特定 Provider）
- 支持 OpenAI Chat Completions API
- 支持 OpenAI Responses API
- 支持流式（SSE）和非流式响应

### OpenAI 官方提供商

**文件**: `src/server/services/openaiOfficialProvider.ts`

OpenAI 官方提供商作为特殊的内置 Provider，使用 OpenAI Codex API，通过 OAuth 认证获取令牌，支持完整的模型目录（`OPENAI_CODEX_MODEL_CATALOG`）。

### Provider 运行时环境

**文件**: `src/server/services/providerRuntimeEnv.ts`

管理 Provider 的运行时环境变量：
- 构建 Provider 认证环境
- 规范化模型映射
- 获取托管环境变量键
- 解析预设认证策略

### 归因头策略

**文件**: `src/server/services/attributionHeaderPolicy.ts`

自动为请求添加 Claude Code 归因头，确保第三方 API 调用中的来源标识。

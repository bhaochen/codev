# System Prompt 组装逻辑

## 概述

System Prompt 是 codev 中指导模型行为的核心指令文本。它通过 `getSystemPrompt()` 函数动态生成，返回一个**字符串数组**，最终在 API 发送时拼接成单一字符串。

## 核心函数

```typescript
// src/constants/prompts.ts
export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]>
```

**返回值**: `Promise<string[]>` - 一个字符串数组，每个元素是 system prompt 的一个 section。

## 组装流程

### 1. Bare mode 分级

Bare mode 由 `bareModeLevel` 配置或 `CLAUDE_CODE_BARE_LEVEL` 环境变量控制，支持
`max`、`high`、`medium`、`low` 四档。旧配置
`bareModeEnabled: true` 兼容映射为 `max`，`--bare` 也等同于 `max`。

| 等级 | system prompt 内容 |
|------|--------------------|
| `ultra` | 仅身份：`You are Codev, chenbhao's CLI.`；同时跳过 Git/user context |
| `max` | 身份、CWD、会话日期 |
| `high` | `max` + 输出效率和语气风格 |
| `medium` | `high` + 环境信息和语言偏好 |
| `low` | 完整 system prompt（仍保留 Bare mode 的启动级精简 gates） |

`CLAUDE_CODE_SIMPLE=1` 仍作为兼容标记使用；具体等级通过
`CLAUDE_CODE_BARE_LEVEL` 传递。Bare mode 的 system prompt 仍不等于一次 API
请求的全部上下文，额外内容包括：

- `CWD: ...`：当前工作目录，位于同一个 system prompt 字符串中
- `Date: ...`：会话启动日期，位于同一个 system prompt 字符串中
- `systemContext`：通常包含 `gitStatus`，在请求发送前通过 `appendSystemContext()` 追加；启用对应 feature 时还可能包含 cache breaker
- `userContext`：通常包含当前日期等内容，通过一个 `<system-reminder>` 元消息插入用户消息列表；Bare mode 会禁用 CLAUDE.md 自动发现，但不代表消息列表为空
- 工具定义：根据等级发送不同工具集合的名称、描述和 JSON Schema
- 对话历史：当前会话已有的用户消息、助手消息和工具结果仍会随请求发送

因此，Bare mode 的含义是“按等级精简默认指令和工具集合”，不是“只发送
`You are Codev, chenbhao's CLI.`”。工具 JSON Schema 和历史消息同样计入模型上下文。

### 2. 完整 system prompt 组装（`low` 或未启用 Bare mode）

当 Bare mode 为 `low`，或未启用 Bare mode 时，返回完整的 system prompt：

```typescript
return [
  // --- 静态内容 (可缓存) ---
  getSimpleIntroSection(outputStyleConfig),          // ← 第1段：简介
  getSimpleSystemSection(),                          // ← 第2段：系统指令
  getSimpleDoingTasksSection(),                      // ← 第3段：任务执行
  getActionsSection(),                               // ← 第4段：操作准则
  getUsingYourToolsSection(enabledTools),            // ← 第5段：工具使用
  getSimpleToneAndStyleSection(),                    // ← 第6段：语气风格
  getOutputEfficiencySection(),                      // ← 第7段：输出效率

  // === BOUNDARY MARKER - DO NOT MOVE OR REMOVE ===
  ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),

  // --- 动态内容 (registry-managed) ---
  ...resolvedDynamicSections,                        // ← 动态内容
].filter(s => s !== null)
```

### 3. 动态 sections (按条件包含)

`resolvedDynamicSections` 包含以下可能的内容：

```typescript
const dynamicSections = [
  systemPromptSection('session_guidance', () =>
    getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
  ),
  systemPromptSection('memory', () => loadMemoryPrompt()),
  systemPromptSection('ant_model_override', () =>
    getAntModelOverrideSection(),
  ),
  systemPromptSection('env_info_simple', () =>
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ),
  systemPromptSection('language', () =>
    getLanguageSection(settings.language),
  ),
  systemPromptSection('output_style', () =>
    getOutputStyleSection(outputStyleConfig),
  ),
  DANGEROUS_uncachedSystemPromptSection(
    'mcp_instructions',
    () => isMcpInstructionsDeltaEnabled() ? null : getMcpInstructionsSection(mcpClients),
    'MCP servers connect/disconnect between turns',
  ),
  systemPromptSection('scratchpad', () => getScratchpadInstructions()),
  systemPromptSection('frc', () => getFunctionResultClearingSection(model)),
  systemPromptSection('summarize_tool_results', () => SUMMARIZE_TOOL_RESULTS_SECTION),
  // ... 条件 sections (TOKEN_BUDGET, KAIROS, etc.)
]
```

## 各 Section 详细内容

### 第1段: `getSimpleIntroSection()`

**代码位置**: `src/constants/prompts.ts:175-184`

```typescript
function getSimpleIntroSection(outputStyleConfig: OutputStyleConfig | null): string {
  return `
You are an interactive agent that helps users ${outputStyleConfig !== null ? 'according to your "Output Style"' : 'with software engineering tasks.'} Use the instructions below and the tools available to you to assist the user.

${CYBER_RISK_INSTRUCTION}
IMPORTANT: You must NEVER generate or guess URLs for the user...`
}
```

**内容**: 简介模型的角色和能力

---

### 第2段: `getSimpleSystemSection()`

**代码位置**: `src/constants/prompts.ts:186-197`

```typescript
function getSimpleSystemSection(): string {
  const items = [
    `All text you output outside of tool use is displayed to the user...`,
    `Tools are executed in a user-selected permission mode...`,
    `Tool results and user messages may include <system-reminder> or other tags...`,
    `Tool results may include data from external sources...`,
    getHooksSection(),
    `The system will automatically compress prior messages...`,
  ]
  return ['# System', ...prependBullets(items)].join(`\n`)
}
```

**内容**: 系统基本指令，关于工具执行、权限、系统提醒等

---

### 第3段: `getSimpleDoingTasksSection()`

**代码位置**: `src/constants/prompts.ts:199-253`

**内容**: 约 150 行的任务执行规范，包括：
- 代码编写要求
- 安全漏洞避免
- 代码风格指南
- 工具使用规范
- 反馈渠道说明

---

### 第4段: `getActionsSection()`

**代码位置**: `src/constants/prompts.ts:255-267`

**内容**: 约 20 行的操作行为准则，关于可逆性和影响范围的考量

---

### 第5段: `getUsingYourToolsSection()`

**代码位置**: `src/constants/prompts.ts:269-311`

**内容**: 约 50 行的工具使用指南，包括：
- FileReadTool 替代 cat/head/tail
- FileEditTool 替代 sed/awk
- FileWriteTool 替代 echo/重定向
- GlobTool 替代 find/ls
- GrepTool 替代 grep/rg
- BashTool 的保留使用场景

---

### 第6段: `getSimpleToneAndStyleSection()`

**代码位置**: `src/constants/prompts.ts:427-439`

```typescript
function getSimpleToneAndStyleSection(): string {
  const items = [
    `Only use emojis if the user explicitly requests it...`,
    process.env.USER_TYPE === 'ant' ? null : `Your responses should be short and concise.`,
    `When referencing specific functions or pieces of code include the pattern file_path:line_number...`,
    `When referencing GitHub issues or pull requests, use the owner/repo#123 format...`,
    `Do not use a colon before tool calls...`,
  ]
  return [`# Tone and style`, ...prependBullets(items)].join(`\n`)
}
```

**内容**: 约 10 行的语气风格指南

---

### 第7段: `getOutputEfficiencySection()`

**代码位置**: `src/constants/prompts.ts:400-425`

**内容**: 约 30 行的输出格式要求，指导模型简洁直接地输出

---

### Dynamic Sections (动态内容)

这些 sections 根据 feature flags 和 session 状态条件性地包含：

| Section | 条件 | 内容 |
|---------|------|------|
| `session_guidance` | 始终 | 会话特定指引（AgentTool 使用、权限询问等） |
| `memory` | 始终 | 加载的记忆提示 |
| `env_info_simple` | 始终 | 环境信息（CWD、平台、shell 等） |
| `language` | 设置了语言 | 语言偏好 |
| `output_style` | 有输出样式 | 输出样式配置 |
| `mcp_instructions` | 有 MCP 服务器 | MCP 服务器指令 |
| `scratchpad` | 启用 | 临时文件目录指引 |
| `frc` | 特定模型 | 函数结果清除指引 |
| `token_budget` | feature('TOKEN_BUDGET') | token 预算指引 |
| `rlm_mode` | /rlm 启用 | RLM 模式指引 |

---

## API 发送时的拼接

### Anthropic Messages API

**代码位置**: `src/services/llm/clients/anthropicMessages.ts:1429`

```typescript
systemPrompt.join('\n\n')   // 用双换行连接
```

### OpenAI Chat API

**代码位置**: `src/services/api/openai/queryModelOpenAI.ts:199`

```typescript
systemPrompt?.join('\n')    // 用单换行连接
```

### OpenAI Compatible Chat

**代码位置**: `src/services/llm/protocols/openaiCompatibleChat.ts:95`

```typescript
systemPrompt?.join('\n')
```

---

## `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 的作用

**代码位置**: `src/constants/prompts.ts:114-116`

```typescript
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

这个边界标记的作用：
- 分隔静态内容（可全局缓存）和动态内容（用户/会话特定）
- 边界之前的内容使用 `scope: 'global'` 缓存
- 边界之后的内容包含用户/会话特定信息，不应全局缓存

---

## 性能优化

### 缓存策略

- **静态内容**: 可全局缓存（边界之前）
- **动态内容**: 不缓存或会话级缓存（边界之后）

### 内容精简

- `max`、`high`、`medium` 按等级返回精简 prompt；`low` 保留完整 prompt 结构
- 动态 sections 按需包含，避免不必要的内容

---

## 示例输出

### 当 Bare mode 为 `ultra` 时

```text
You are Codev, chenbhao's CLI.
```

### 当 Bare mode 为 `max` 时

```
You are Codev, chenbhao's CLI.

CWD: /home/user/codev-project
Date: 2026-09-16
```

实际请求还会在上述文本之外追加 `gitStatus` 等 system context，并在消息列表前插入 user context 元消息；如果使用 OpenAI Chat provider，还会把当前等级对应的工具转换为 `tools` 数组发送。

### 当 Bare mode 为 `low` 或未启用时

完整的 system prompt 会是几百行的文字，包含所有 sections 的内容，最终拼接成一个长字符串。

---

## 相关文件

| 文件 | 作用 |
|------|------|
| `src/constants/prompts.ts` | 所有 section 生成函数 |
| `src/utils/systemPrompt.ts` | system prompt 辅助函数 |
| `src/services/llm/clients/anthropicMessages.ts` | Anthropic API 发送时的拼接 |
| `src/services/api/openai/queryModelOpenAI.ts` | OpenAI API 发送时的拼接 |
| `src/services/llm/protocols/openaiCompatibleChat.ts` | OpenAI Compatible API 发送时的拼接 |

---

## 调试提示

### 导出 system prompt

```bash
codev --dump-system-prompt
```

这会输出当前会话的完整 system prompt，便于调试和检查。

### 检查各 section 的内容

可以通过修改 `getSystemPrompt()` 函数，逐个注释掉各 section 来检查每个部分的内容。

---

## 最佳实践

1. **理解缓存边界**: 静态内容（边界之前）可全局缓存，动态内容（边界之后）会话级缓存
2. **合理选择 Bare 等级**: 本地小上下文模型使用 `max` 或 `high`，需要项目上下文时使用 `medium`，完整能力使用 `low`
3. **条件 sections**: 利用 feature flags 控制是否包含特定 sections，避免不必要的 token 消耗
4. **避免修改边界**: `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 是性能关键点，不要随意移动或删除

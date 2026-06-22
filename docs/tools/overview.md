# AI 工具系统

## Tool 抽象

所有 AI 可调用的工具（Tool）都通过 **`buildTool()`** 框架构建。每个工具定义以下核心属性：

```
Tool<Input, Output, Progress>
```

### 核心字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 工具名称，用于 API 调用标识 |
| `aliases` | `string[]` | 可选的别名，用于向后兼容 |
| `searchHint` | `string` | 3-10 词的关键词提示，辅助 ToolSearch 匹配 |
| `inputSchema` | `Zod Schema` | 输入参数的 Zod 校验 schema |
| `inputJSONSchema` | `object` | 可选的 JSON Schema 直接输出（MCP 工具使用） |
| `outputSchema` | `Zod Schema` | 输出参数的 Zod schema |
| `call()` | 函数 | 工具的核心执行逻辑 |
| `description()` | 函数 | 工具的描述字符串 |
| `prompt()` | 函数 | 返回工具在系统提示词中的内容 |
| `isEnabled()` | 函数 | 工具是否启用（默认 true） |
| `isConcurrencySafe()` | 函数 | 是否支持并发执行（默认 false） |
| `isReadOnly()` | 函数 | 是否为只读操作（默认 false） |
| `isDestructive()` | 函数 | 是否为破坏性操作（删除、覆盖、发送；默认 false） |
| `shouldDefer` | `boolean` | 是否延迟加载（配合 ToolSearch 使用） |
| `alwaysLoad` | `boolean` | 是否始终加载（即使在 ToolSearch 模式下） |
| `maxResultSizeChars` | `number` | 结果超过此大小时持久化到磁盘 |
| `strict` | `boolean` | 是否启用工具调用严格模式 |
| `checkPermissions()` | 函数 | 检查用户权限 |
| `validateInput()` | 函数 | 输入值校验逻辑 |
| `renderToolUseMessage()` | 函数 | 渲染工具调用 UI |
| `renderToolResultMessage()` | 函数 | 渲染工具结果 UI |
| `renderToolUseProgressMessage()` | 函数 | 渲染执行进度 UI |
| `userFacingName()` | 函数 | 面向用户显示的名称 |
| `getActivityDescription()` | 函数 | 进度提示文本 |
| `mapToolResultToToolResultBlockParam()` | 函数 | 将结果映射为 API 格式 |

### buildTool() 默认值

`buildTool()` 提供以下安全默认值：

| 方法 | 默认值 |
|------|--------|
| `isEnabled()` | `true` |
| `isConcurrencySafe()` | `false`（默认不支持并发） |
| `isReadOnly()` | `false`（默认可能写入） |
| `isDestructive()` | `false` |
| `checkPermissions()` | `{ behavior: 'allow', updatedInput: input }`（放行） |
| `toAutoClassifierInput()` | `''`（跳过分类器） |
| `userFacingName()` | `name` |

相关文件：`/home/yuki/Code/Agent/VersperClaw/src/Tool.ts`

---

## 注册机制

### getTools() 流程

`src/tools.ts` 的 **`getTools()`** 函数是工具注册的核心入口：

```
getTools(permissionContext) → Tool[]
```

执行流程：

1. **`CLAUDE_CODE_SIMPLE` 模式**：仅返回 BashTool、FileReadTool、FileEditTool（极简模式）
2. **`getAllBaseTools()`**：收集所有内置工具，按 feature flag 和条件编译
3. **`filterToolsByDenyRules()`**：检查 deny rules，过滤被禁止的工具
4. **`REPL 模式过滤`**：当 REPL 启用时，隐藏原始工具（`REPL_ONLY_TOOLS`）
5. **`isEnabled()` 过滤**：逐个检查工具是否启用

### assembleToolPool()

`assembleToolPool()` 是内置工具与 MCP 工具的汇聚函数：

1. 调用 `getTools()` 获取内置工具
2. 通过 `filterToolsByDenyRules()` 过滤 MCP 工具
3. 按名称去重（内置工具优先）
4. 按名称排序（保持 prompt cache 稳定性）

### getMergedTools()

单纯合并内置工具与 MCP 工具（不去重、不排序），用于工具搜索阈值计算等场景。

相关文件：`/home/yuki/Code/Agent/VersperClaw/src/tools.ts`

---

## 执行引擎

### runToolUse()

`src/services/tools/toolExecution.ts` 的 **`runToolUse()`** 是工具调用的入口点，接收 `ToolUseBlock` 并返回异步生成器。

执行生命周期：

```
runToolUse(toolUse, assistantMessage, canUseTool, toolUseContext)
  → AsyncGenerator<MessageUpdateLazy>
```

### 完整生命周期

```
LLM 请求工具调用
    │
    ├─ 1. 查找工具 ── findToolByName()
    │      ├─ 找到 → 继续
    │      └─ 未找到 → 尝试别名匹配 → 返回"工具不存在"错误
    │
    ├─ 2. 输入校验 ── inputSchema.safeParse(input)
    │      ├─ 成功 → 继续
    │      └─ 失败 → 返回 Zod 校验错误（含 ToolSearch schema 未发送提示）
    │
    ├─ 3. 自定义校验 ── validateInput()
    │      ├─ 通过 → 继续
    │      └─ 拒绝 → 返回自定义错误消息
    │
    ├─ 4. PreToolUse Hooks ── runPreToolUseHooks()
    │      ├─ 产生消息（进度、附件）
    │      ├─ 产生 hookPermissionResult（提前决定权限）
    │      ├─ 产生 hookUpdatedInput（修改输入）
    │      └─ 产生 stop（钩子要求停止执行）
    │
    ├─ 5. 权限检查 ── resolveHookPermissionDecision()
    │      ├─ permission mode 决定交互方式
    │      ├─ 权限缓存 / alwaysAllow / alwaysDeny / alwaysAsk
    │      ├─ 用户交互弹窗（default 模式）
    │      ├─ 自动分类器（auto 模式）
    │      └─ 结果: allow / reject / ask
    │
    ├─ 6. 工具执行 ── tool.call()
    │      ├─ 执行核心逻辑
    │      ├─ 发送进度通知 (onProgress)
    │      └─ 返回 ToolResult
    │
    ├─ 7. 结果处理 ── mapToolResultToToolResultBlockParam()
    │      ├─ 大结果持久化到磁盘
    │      └─ 生成预览
    │
    ├─ 8. PostToolUse Hooks ── runPostToolUseHooks()
    │      ├─ MCP 工具: 可修改 toolOutput
    │      └─ 非 MCP 工具: 添加附件消息
    │
    └─ 9. 返回结果 ── 生成 MessageUpdateLazy
           ├─ 成功: tool_result 消息
           ├─ 错误: tool_use_error 消息
           └─ 中断: tool_result_stop 消息
```

---

## 权限系统

权限系统基于 `permission mode` 决定工具调用是否需要用户确认：

### Permission Mode

| 模式 | 说明 |
|------|------|
| `default` | 默认模式，敏感操作需用户确认 |
| `acceptEdits` | 自动接受文件编辑类操作 |
| `bypassPermissions` | 绕过所有权限检查 |
| `plan` | 规划模式，限制工具使用 |
| `auto` | 自动模式，分类器决定权限 |

### 权限规则覆盖

根据 `ToolPermissionContext`，系统支持：

- **alwaysAllowRules**: 始终允许的规则（按工具名称、文件路径模式、shell 命令前缀）
- **alwaysDenyRules**: 始终拒绝的规则
- **alwaysAskRules**: 始终询问的规则
- **denyRules**: 在工具注册阶段过滤掉的工具

### 权限决定来源（OTel `source` 词汇）

| 来源 | 说明 |
|------|------|
| `user_temporary` | 用户会话级临时允许 |
| `user_permanent` | 用户永久允许（存盘） |
| `user_reject` | 用户拒绝 |
| `hook` | 钩子系统决定 |
| `config` | 配置/预设规则决定 |

---

## 进度通知系统

工具执行过程中通过 `onProgress` 回调发送进度通知，不同类型的工具有不同的进度类型：

| 进度类型 | 说明 | 对应工具 |
|----------|------|----------|
| `BashProgress` | Shell 命令执行进度 | BashTool |
| `AgentProgress` | 子代理执行进度 | AgentTool |
| `MCPProgress` | MCP 工具调用进度 | MCP 工具 |
| `SkillToolProgress` | 技能执行进度 | SkillTool |
| `TaskOutputProgress` | 后台任务输出进度 | TaskOutputTool |
| `WebSearchProgress` | 网络搜索进度 | WebSearchTool |
| `REPLToolProgress` | REPL 工具进度 | REPLTool |
| `HookProgress` | 钩子执行进度 | Hooks |

相关文件：
- `/home/yuki/Code/Agent/VersperClaw/src/services/tools/toolExecution.ts` — 执行引擎
- `/home/yuki/Code/Agent/VersperClaw/src/types/tools.ts` — 进度类型定义
- `/home/yuki/Code/Agent/VersperClaw/src/hooks/toolPermission/` — 权限钩子
- `/home/yuki/Code/Agent/VersperClaw/src/utils/permissions/` — 权限工具函数

---

## 关键工具详述

### AgentTool

执行子代理任务的核心工具。

- **输入参数**: `description`, `prompt`, `subagent_type`, `model`, `run_in_background`, `name`, `team_name`, `mode`, `isolation`, `cwd`
- **行为**: 启动一个独立的子代理会话，可指定代理类型、模型、隔离方式
- **权限**: 可能需要用户确认
- **进度**: `AgentProgress` 类型

### BashTool

在本地 Shell 中执行命令。

- **输入参数**: `command`, `timeout`, `description`, `run_in_background`, `dangerouslyDisableSandbox`
- **行为**: 执行任意 shell 命令，支持超时控制、后台运行、沙箱模式
- **权限**: 按命令前缀匹配权限规则
- **进度**: 超过 2 秒显示 `BashProgress`
- **自动分类**: search/read/list 命令会折叠显示

### Read / Edit / Write

三大文件操作工具：

- **FileReadTool**: 读取文件内容，支持 PDF、图片、Jupyter Notebook
- **FileEditTool**: 精确替换文件中的字符串，支持 diff 显示和 git diff 跟踪
- **FileWriteTool**: 创建或覆盖写入文件内容，包含文件变更追踪

### WebSearch / WebFetch

- **WebSearchTool**: 使用 Tavily API 或本地 SearXNG 进行网络搜索
- **WebFetchTool**: 抓取 URL 内容并应用 prompt 处理（提取、总结）

相关文件：
- `/home/yuki/Code/Agent/VersperClaw/src/Tool.ts` — Tool 类型与 buildTool 框架
- `/home/yuki/Code/Agent/VersperClaw/src/tools.ts` — 工具注册与过滤
- `/home/yuki/Code/Agent/VersperClaw/src/services/tools/toolExecution.ts` — 执行引擎
- `/home/yuki/Code/Agent/VersperClaw/src/services/tools/toolHooks.ts` — 工具钩子

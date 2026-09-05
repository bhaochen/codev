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

相关文件：`/home/yuki/Code/Agent/Codev/src/Tool.ts`

---

## 注册机制

### getTools() 流程

`src/tools.ts` 的 **`getTools()`** 函数是工具注册的核心入口：

```
getTools(permissionContext) → Tool[]
```

执行流程：

1. **`CLAUDE_CODE_SIMPLE` 模式**：仅返回 BashTool、FileReadTool、FileEditTool（极简模式；REPL 开启时改返 REPL）
2. **`getAllBaseTools()`**：收集所有内置工具，按 feature flag 和条件编译；`REPL` 由 `getReplTool()` 按当前 `isReplModeEnabled()` 运行时决议注册（不在 import 阶段冻结）
3. **`filterToolsByDenyRules()`**：检查 deny rules，过滤被禁止的工具
4. **`REPL 模式过滤`**（不变量）：关闭时 `REPL` 必不存在、原始工具（`REPL_ONLY_TOOLS`）可直接调用；启用时保留 `REPL` 并隐藏原始工具（仍可在 VM 内 `callTool`）
5. **`isEnabled()` 过滤**：逐个检查工具是否启用

### assembleToolPool()

`assembleToolPool()` 是内置工具与 MCP 工具的汇聚函数：

1. 调用 `getTools()` 获取内置工具
2. 通过 `filterToolsByDenyRules()` 过滤 MCP 工具
3. 按名称去重（内置工具优先）
4. 按名称排序（保持 prompt cache 稳定性）

### getMergedTools()

单纯合并内置工具与 MCP 工具（不去重、不排序），用于工具搜索阈值计算等场景。

相关文件：`/home/yuki/Code/Agent/Codev/src/tools.ts`

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
| `LocationToolProgress` | 地理位置搜索进度 | LocationTool |
| `REPLToolProgress` | REPL 工具进度 | REPLTool |
| `HookProgress` | 钩子执行进度 | Hooks |

相关文件：
- `/home/yuki/Code/Agent/Codev/src/services/tools/toolExecution.ts` — 执行引擎
- `/home/yuki/Code/Agent/Codev/src/types/tools.ts` — 进度类型定义
- `/home/yuki/Code/Agent/Codev/src/hooks/toolPermission/` — 权限钩子
- `/home/yuki/Code/Agent/Codev/src/utils/permissions/` — 权限工具函数

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

#### 双后端架构

WebSearchTool 支持两个搜索后端：

| 后端 | 类型 | 配置 | 特点 |
|------|------|------|------|
| **Tavily** | 云 API | `TAVILY_API_KEY` 环境变量 | 稳定、无需自托管 |
| **SearXNG** | 自托管 | Docker 运行 `verspersearch` | 完全隐私、无 API 成本 |

后端自动选择：若配置了 `TAVILY_API_KEY` 则使用 Tavily，否则回退到本地 SearXNG。

#### WebFetch

抓取 URL 内容并应用 prompt 处理（提取、总结）。支持将结果渲染为 Markdown 格式，包含图片链接。

配置项：
- `JINA_API_KEY` — 可选的 Jina AI API 密钥，用于增强型内容提取

相关文件：
- `/home/yuki/Code/Agent/Codev/src/Tool.ts` — Tool 类型与 buildTool 框架
- `/home/yuki/Code/Agent/Codev/src/tools.ts` — 工具注册与过滤
- `/home/yuki/Code/Agent/Codev/src/services/tools/toolExecution.ts` — 执行引擎
- `/home/yuki/Code/Agent/Codev/src/services/tools/toolHooks.ts` — 工具钩子

---

### REPLTool — VM 沙箱批量执行引擎（P6.6 最终契约）

在 Bun `node:vm` 沙箱中执行 JavaScript 的批量操作引擎（默认启用；`/config` 的 `replEnabled` 字段控制，环境变量 `CODEV_REPL` / `CLAUDE_CODE_REPL` 优先级最高）。详见 [REPL Tool 深度解析](repl-tool.md)。

- **输入参数**: `code` (必填) — JS 代码，通过 `await callTool(name, input)` 调用 primitive tools
- **行为**: 单次调用内完成多步批量操作；变量跨调用持久化（会话级 `engineCache:Map<sessionId,ReplEngine>`，`src/tools/REPLTool/REPLTool.ts`）
- **primitive 工具集**: Read / Write / Edit / Glob / Grep / Bash（`src/tools/REPLTool/primitiveTools.ts`，大小写不敏感查找）
- **透明包装**: `isTransparentWrapper()=true`，UI 只显示内部 tool 调用与 `repl_tool_call` 进度；`innerMessages(isVirtual:true)` 仅 UI/history，`src/utils/messages.ts:1999 normalizeMessagesForAPI` 过滤不进 LLM
- **3 层契约** (`src/tools/REPLTool/engine.ts:35`):
  ```
  Tool → ToolResult{tool,ok,isError,exitCode,stdout/stderr,data,truncated,outputPath,noOutputExpected}
       → ExecutionStore(innerMessages isVirtual)
       → ContextAggregator.buildContextResult() → ContextResult{ok,tool_calls,calls:[{tool,ok,preview,summary,truncated,outputPath}],logs} JSON → LLM
  ```
  `callTool()成功必捕获 ToolResult → ContextAggregator 决定暴露`，`console.log` 仅补充 `logs` 字段；`Bash` 截断 4000/`head2000+tail500`，超大走 `outputPath` 按需二次 `Read`。`REPL_ONLY_TOOLS` 在启用时从工具池隐藏；`REPL != SubAgent`（无二次 LLM 调用，SubAgent 为 `AgentTool/task` 独立会话）。

### BenchmarkTool

渲染 `/benchmark` deepsearch 评测报告（雷达图、表格、步级指标），结果折叠、点击展开。

### LocationTool

地理位置与地图搜索工具。根据地区自动选择地图服务商：

| 地区 | 服务商 | 环境变量 |
|------|--------|----------|
| 中国大陆 | 高德地图 (Amap) | `AMAP_API_KEY` |
| 海外 | Google Maps | `GOOGLE_MAPS_API_KEY` |

**支持的操作：**

| 动作 | 功能 | Amap API | Google API |
|------|------|----------|------------|
| `locate` | IP 地理定位 (无需 location 参数) | — | — |
| `geocode` | 地址→坐标 | 地理编码 | Geocoding |
| `search_places` | 周边/关键词搜索 POI | POI 周边搜索 | Places / Nearby Search |
| `get_directions` | 两点间路线规划 | 驾车/公交路径规划 | Directions |
| `plan_trip` | 多途经点行程规划 | 分段路径拼接 | 多航点 Directions |

**地区自动检测：** 含中文字符或已知中国城市名 → Amap，否则 → Google。支持 `region` 参数强制指定。

**配合搜索工具：** Prompt 层面指导模型在获取地点后，可调用 WebSearchTool 查攻略/评价，或用 WebFetchTool 获取详情页内容。

**搜索结果数量：** 高德搜索默认翻页至全部结果（每页 1000 条，最多 20 页 ≈ 10000 条）；Google 搜索使用 `next_page_token` 翻页（最多 60 条，Google 上限）。`locate` 动作优先尝试 Amap/Google WiFi 指纹定位，最后回退到 IP 定位（3 个 IP 服务）。

**输入参数：** `action` (必填), `location` (必填), `destination`, `query`, `radius` (默认 5000m), `mode` (driving/walking/transit/bicycling), `waypoints`, `type` (Amap POI 类型过滤), `region` (强制指定), `language`

相关文件：
- `/home/yuki/Code/Agent/Codev/src/tools/LocationTool/LocationTool.ts` — 主工具逻辑
- `/home/yuki/Code/Agent/Codev/src/tools/LocationTool/prompt.ts` — 提示词
- `/home/yuki/Code/Agent/Codev/src/tools/LocationTool/UI.tsx` — 渲染组件

#### API Key 申请指南

**高德地图 API Key（中国大陆用）**

1. **注册账号** — 打开 [高德开放平台](https://lbs.amap.com/)，点击右上角「注册」
2. **创建应用** — 登录后进入控制台 → 「应用管理」→ 「创建新应用」
3. **添加 Key** — 在创建的应用中点击「添加 Key」→ 服务平台选择 **「Web 服务」**
4. **获取 Key** — 创建成功后复制 Key，设为环境变量：
   ```bash
   export AMAP_API_KEY=你的高德Key
   ```

**Google Maps API Key（海外用）**

1. **创建项目** — 打开 [Google Cloud Console](https://console.cloud.google.com/)，创建新项目
2. **启用 API** — 进入「API 和服务」→「库」，搜索并启用以下 API：
   - **Geocoding API**（地址 → 坐标）
   - **Places API**（地点搜索）
   - **Directions API**（路线规划）
3. **创建凭据** — 「API 和服务」→「凭据」→「创建凭据」→「API 密钥」
4. **限制密钥**（强烈建议）— 在凭据页面设置 API 限制，仅允许上面启用的三个 API，避免滥用
5. 设为环境变量：
   ```bash
   export GOOGLE_MAPS_API_KEY=你的GoogleKey
   ```

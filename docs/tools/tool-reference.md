# 工具参考大全

> 完整收录 VersperClaw 中所有 AI 可调用的工具（约 60+），按功能分类。

---

## 核心文件操作

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **Read** (FileReadTool) | 核心 | 读取文件内容，支持 PDF、图片、Jupyter Notebook。自动推断文件编码和语言 | `file_path` (必填), `offset`, `limit`, `pages` (PDF), `stop_sequence` |
| **Edit** (FileEditTool) | 核心 | 对现有文件执行精确字符串替换。支持 diff 显示、git diff 跟踪、行尾风格检测 | `file_path` (必填), `old_string` (必填), `new_string` (必填), `replace_all`, `is_undo` |
| **Write** (FileWriteTool) | 核心 | 创建新文件或覆盖写文件。不支持替换编辑（用途与 Edit 互补） | `file_path` (必填), `content` (必填) |
| **Glob** (GlobTool) | 核心 | 使用 glob 模式快速搜索文件名。支持 `.gitignore` 排除规则 | `pattern` (必填), `path` (可选) |
| **Grep** (GrepTool) | 核心 | 使用正则表达式搜索文件内容。基于 ripgrep，支持多种输出模式 | `pattern` (必填), `path` (可选), `glob`, `output_mode`, `-B`, `-A`, `-C`, `-i`, `type`, `head_limit`, `multiline` |
| **NotebookEdit** (NotebookEditTool) | 核心 | 编辑 Jupyter Notebook (.ipynb) 文件的单元格。支持 replace / insert / delete 模式 | `notebook_path` (必填), `cell_id`, `new_source`, `cell_type`, `edit_mode` |

---

## 命令执行

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **Bash** (BashTool) | 核心 | 执行 Shell 命令。支持超时控制、后台执行、沙箱模式。自动检测 search/read 类命令以折叠显示 | `command` (必填), `timeout` (可选), `description` (可选), `run_in_background` (可选), `dangerouslyDisableSandbox` (可选) |
| **Agent** (AgentTool) | 核心 | 启动独立的子代理执行子任务。支持指定代理类型、模型、隔离方式、团队协作 | `description` (必填), `prompt` (必填), `subagent_type`, `model`, `run_in_background`, `name`, `team_name`, `mode`, `isolation` (worktree/remote), `cwd` |
| **PowerShell** (PowerShellTool) | 命令 | Windows PowerShell 命令执行。仅在 Windows 平台可用 | `command` (必填), `timeout`, `description`, `run_in_background` |
| **TaskStop** (TaskStopTool) | 命令 | 停止正在运行的后台任务。继承自废弃的 KillShell 工具 | `task_id` (可选), `shell_id` (废弃) |
| **TaskOutput** (TaskOutputTool) | 命令 | 获取后台任务的执行输出。支持阻塞等待和超时控制 | `task_id` (必填), `block` (默认 true), `timeout` (默认 30000ms) |

---

## 搜索

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **WebSearch** (WebSearchTool) | 搜索 | 执行网络搜索。支持 Tavily API 和本地 SearXNG 两种后端（优先本地 SearXNG） | `query` (必填, 最少 2 字符) |
| **WebFetch** (WebFetchTool) | 搜索 | 抓取指定 URL 的内容，并对内容执行 prompt 处理（提取、总结等） | `url` (必填), `prompt` (必填) |
| **ToolSearch** (ToolSearchTool) | 搜索 | 搜索延迟加载的工具。当 ToolSearch 启用时，部分工具的 schema 不会随初始提示发送，需通过此工具查询后再调用 | `query` (必填, 支持 "select:name" 精确选择), `max_results` (默认 5) |

---

## MCP (Model Context Protocol)

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **ListMcpResources** (ListMcpResourcesTool) | MCP | 列出已连接 MCP 服务器提供的可用资源 | `server` (可选, 过滤) |
| **ReadMcpResource** (ReadMcpResourceTool) | MCP | 读取 MCP 资源内容。支持文本和二进制内容（二进制会保存到磁盘） | `server` (必填), `uri` (必填) |
| **MCPTool** (动态) | MCP | 由 MCP 服务器动态注册的工具。名称格式 `mcp__server__tool`。数量和功能取决于已连接的 MCP 服务器 | 由 MCP 服务器定义 |
| **McpAuth** (MCP) | MCP | MCP 服务器授权管理。当工具调用返回 McpAuthError 时触发重授权流程 | 由 MCP 服务器定义 |

---

## 任务管理 (Todo V2)

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **TaskCreate** (TaskCreateTool) | 任务 | 创建新的任务项。支持设置负责人（owner）、依赖关系、元数据 | `subject` (必填), `description` (必填), `activeForm`, `metadata` |
| **TaskGet** (TaskGetTool) | 任务 | 通过 ID 获取单个任务的详细信息 | `taskId` (必填) |
| **TaskUpdate** (TaskUpdateTool) | 任务 | 更新任务的状态、描述、负责人、依赖关系、元数据。支持标记为 "deleted" 删除 | `taskId` (必填), `subject`, `description`, `status`, `addBlocks`, `addBlockedBy`, `owner`, `metadata` |
| **TaskList** (TaskListTool) | 任务 | 列出所有任务的概览（ID、标题、状态、负责人、阻塞关系） | 无参数 |
| **TodoWrite** (TodoWriteTool) | 任务 | (遗留) 会话级任务清单管理。V1 版本，当 Todo V2 未启用时生效 | `todos` (必填) |

---

## 团队与多代理

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **TeamCreate** (TeamCreateTool) | 团队 | 创建新团队并设置团队领导。支持指定代理类型，自动生成团队文件 | `team_name` (必填), `description`, `agent_type` |
| **TeamDelete** (TeamDeleteTool) | 团队 | 删除已存在的团队 | `team_id` (必填) |
| **SendMessage** (SendMessageTool) | 团队 | 向指定队友发送消息。支持普通文本和结构化消息（关闭请求/响应、计划审批等） | `to` (必填), `message` (必填), `type`, `request_id` |
| **ListPeers** (ListPeersTool) | 团队 | 列出本地 UDS 对等节点（统一数据空间连接的对等体） | 无参数 |

---

## 规划与工作树

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **EnterPlanMode** (EnterPlanModeTool) | 规划 | 进入规划模式。在执行复杂任务前，可用于探索和设计方案 | 无参数 |
| **ExitPlanMode** (ExitPlanModeV2Tool) | 规划 | 退出规划模式。提交最终计划并恢复为之前的权限模式 | `plan` (必填), `plan_approval`, `output`, `mode` |
| **EnterWorktree** (EnterWorktreeTool) | 规划 | 创建隔离的 git worktree 并将会话切换到其中。用于安全地进行实验性修改 | `name` (可选) |
| **ExitWorktree** (ExitWorktreeTool) | 规划 | 退出 git worktree 并返回原工作目录。支持 keep（保留）或 remove（删除） | `action` (必填, keep/remove), `discard_changes` |

---

## 技能

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **Skill** (SkillTool) | 技能 | 执行 Markdown 定义的技能。技能可以是打包的、用户自定义的、插件提供的或 MCP 提供的 | 参数取决于具体技能 |
| **DiscoverSkills** (DiscoverSkillsTool) | 技能 | 发现新的可用技能。扫描技能目录并返回当前可用的技能列表 | 无参数 |

---

## 目标系统 (Goal)

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **GoalCreate** (GoalCreateTool) | 目标 | 创建新的会话目标。当当前无活跃目标时生效 | `objective` (必填) |
| **GoalGet** (GoalGetTool) | 目标 | 查看当前活跃目标的状态、经过时间、续用次数 | 无参数 |
| **GoalUpdate** (GoalUpdateTool) | 目标 | 声明目标完成或受阻。需提供原因说明 | `goal_id` (必填), `status` (必填, complete/blocked), `reason` (必填) |

---

## Friend 虚拟宠物

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **FriendEmotion** (FriendEmotionTool) | Friend | 控制 VRM 虚拟形象的表情和情绪状态。设置情绪类型、强度，调整自身心情指数 | `emotion` (必填, 如 happy/sad/angry), `intensity` (0-1, 默认 1), `mood_delta` (-3 到 +3) |
| **FriendScreenObserve** (FriendScreenObserveTool) | Friend | 捕获当前桌面屏幕截图，供 LLM "观察" 用户桌面环境。返回图片路径 | 无参数 |

---

## 特殊工具

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **AskUserQuestion** (AskUserQuestionTool) | 特殊 | 向用户提出需要即时回答的问题 | 取决于实现 |
| **Config** (ConfigTool) | 特殊 | 读取或修改 Claude Code 配置设置（ant 内部版本） | `setting` (必填), `value` (可选) |
| **Sleep** (SleepTool) | 特殊 | 让代理休眠一段时间。用于延迟执行或等待条件成熟 | 取决于实现 |
| **CronCreate** (CronCreateTool) | 特殊 | 创建定时触发任务（cron 调度） | 取决于实现 |
| **CronDelete** (CronDeleteTool) | 特殊 | 删除已存在的 cron 任务 | 取决于实现 |
| **CronList** (CronListTool) | 特殊 | 列出所有已注册的 cron 任务 | 取决于实现 |
| **RemoteTrigger** (RemoteTriggerTool) | 特殊 | 远程触发任务执行 | 取决于实现 |
| **Monitor** (MonitorTool) | 特殊 | 监控资源或任务状态 | 取决于实现 |
| **Brief** (BriefTool) | 特殊 | 生成简报输出。在 KAIROS/BRIEF 模式下可用 | 取决于实现 |
| **Snip** (SnipTool) | 特殊 | 强制截断历史上下文。HISTORY_SNIP feature 控制 | 取决于实现 |
| **SubscribePR** (SubscribePRTool) | 特殊 | 订阅 GitHub PR 的通知 | 取决于实现 |
| **PushNotification** (PushNotificationTool) | 特殊 | 发送推送通知 | 取决于实现 |
| **SendUserFile** (SendUserFileTool) | 特殊 | 向用户发送文件 | 取决于实现 |

---

## Workflow

| 工具名称 | 分类 | 用途描述 | 关键参数 |
|----------|------|----------|----------|
| **WorkflowTool** (WorkflowTool) | Workflow | 执行多步骤工作流脚本。工作流由 YAML/JSON 定义，支持顺序执行、条件分支、变量传递 | 取决于工作流定义 |

---

## Ant 内部工具

以下工具仅在 `USER_TYPE=ant` 的内部构建中可用，公开构建中被过滤：

| 工具名称 | 分类 | 用途描述 |
|----------|------|----------|
| **REPLTool** | Ant 内部 | REPL 模式的 VM 执行器。在 REPL 模式下包装 Bash/Read/Edit 等工具 |
| **TungstenTool** | Ant 内部 | Tungsten 内部工具 |
| **SuggestBackgroundPRTool** | Ant 内部 | 后台 PR 建议工具 |
| **CtxInspectTool** | Ant 内部 | 上下文折叠检查（CONTEXT_COLLAPSE） |
| **TerminalCaptureTool** | Ant 内部 | 终端面板捕获（TERMINAL_PANEL） |
| **OverflowTestTool** | Ant 内部 | 溢出测试工具 |
| **VerifyPlanExecutionTool** | Ant 内部 | 计划执行验证 |
| **TestingPermissionTool** | Ant 内部 | 测试权限工具（仅 NODE_ENV=test） |
| **WebBrowserTool** | Ant 内部 | 网页浏览器工具 |

---

## feature-flag 条件编译对照

以下工具根据 feature flag 条件编译，在公开构建中通过 bun build DCE 消除：

| Feature Flag | 包含的工具 |
|--------------|-----------|
| `PROACTIVE` / `KAIROS` | SleepTool |
| `AGENT_TRIGGERS` | CronCreateTool, CronDeleteTool, CronListTool |
| `AGENT_TRIGGERS_REMOTE` | RemoteTriggerTool |
| `MONITOR_TOOL` | MonitorTool |
| `KAIROS` | SendUserFileTool, PushNotificationTool |
| `KAIROS_PUSH_NOTIFICATION` | PushNotificationTool |
| `KAIROS_GITHUB_WEBHOOKS` | SubscribePRTool |
| `WORKFLOW_SCRIPTS` | WorkflowTool |
| `COORDINATOR_MODE` | 协调模式相关工具 |
| `HISTORY_SNIP` | SnipTool |
| `UDS_INBOX` | ListPeersTool |
| `ENABLE_LSP_TOOL` | LSPTool |
| `WEB_BROWSER_TOOL` | WebBrowserTool |
| `OVERFLOW_TEST_TOOL` | OverflowTestTool |
| `CONTEXT_COLLAPSE` | CtxInspectTool |
| `TERMINAL_PANEL` | TerminalCaptureTool |

---

> 注: 本参考基于 `/home/yuki/Code/Agent/VersperClaw/src/tools.ts` 的 `getAllBaseTools()` 函数。MCP 工具的完整列表取决于用户配置的 MCP 服务器，未在此表中逐一列出。

# CLI 命令系统

## 架构概述

### 入口

CLI 入口由 **Commander.js** 解析命令行参数，随后启动 **REPL**（交互式循环）。REPL 负责接收用户输入、解析斜杠命令、调用对应的处理函数。

### 命令注册

命令通过 **6 种来源** 注册到系统：

| 来源 | 说明 | 注册位置 |
|------|------|----------|
| **内置命令** | `COMMANDS()` 函数返回的核心命令列表 | `src/commands.ts:261-354` |
| **内置技能** | 随 CLI 打包的 Markdown 技能文件 | `getBundledSkills()` |
| **内置插件** | 内置插件导出的技能命令 | `getBuiltinPluginSkillCommands()` |
| **用户技能目录** | 用户自定义的 Markdown 技能文件 | `getSkillDirCommands()` |
| **工作流** | 多步骤脚本工作流 | `getWorkflowCommands()` |
| **市场插件** | 从插件市场安装的外部插件 | `getPluginCommands()`, `getPluginSkills()` |

### 命令过滤

`getCommands()` 是命令的最终汇聚函数，执行以下过滤：

1. **availability 检查**：`meetsAvailabilityRequirement()` — 验证当前用户是否有权限（如 claude.ai 订阅者、Console API 用户）
2. **isEnabled 检查**：`isCommandEnabled()` — feature flag 控制是否启用
3. **去重**：内置命令与动态技能（`getDynamicSkills()`）间去重，内置命令优先
4. **动态技能插入**：在插件命令之后、内置命令之前插入

### 远程模式过滤

`REMOTE_SAFE_COMMANDS` 集合定义了可在 `--remote` 模式下安全使用的命令（仅影响本地 TUI 状态）。

`BRIDGE_SAFE_COMMANDS` 和 `isBridgeSafeCommand()` 定义了可通过 Remote Control bridge（移动端/web 客户端）执行的命令。

---

## 内置命令详表

以下为 `COMMANDS()` 中注册的所有内置命令，按功能分组：

### 导航与信息

| 命令 | 别名 | 描述 |
|------|------|------|
| `/help` | - | 显示帮助信息，列出所有可用命令 |
| `/clear` | - | 清屏，重置终端显示 |
| `/exit` | - | 退出 CLI |
| `/init` | - | 在项目中初始化 Claude Code 配置文件 |
| `/resume` | - | 恢复之前的会话 |
| `/status` | - | 显示当前会话状态 |
| `/stats` | - | 统计信息和指标 |

### 配置管理

| 命令 | 别名 | 描述 |
|------|------|------|
| `/config` | - | 系统设置管理（theme, model, permissions 等） |
| `/model` | - | 切换 AI 模型 |
| `/theme` | - | 切换终端主题 |
| `/color` | - | 更改 AI 回复颜色 |
| `/permissions` | - | 权限模式管理 |
| `/privacySettings` | - | 隐私设置 |
| `/outputStyle` | - | 输出风格切换 |
| `/statusline` | - | 状态行开关 |
| `/effort` | - | 设置思考/推理投入度 |
| `/fast` | - | 快速模式切换 |
| `/env` | ant 内部 | 环境变量管理 |
| `/remoteEnv` | - | 远程环境变量管理 |
| `/passes` | - | 管理预设的 always-allow/always-deny 规则 |

### 会话管理

| 命令 | 别名 | 描述 |
|------|------|------|
| `/session` | - | 会话管理（分享、导出、查看记录） |
| `/cost` | - | 显示当前会话费用 |
| `/usage` | - | 显示 API 用量 |
| `/compact` | - | 压缩上下文，减少 token 消耗 |
| `/copy` | - | 复制最后一条消息 |
| `/rename` | - | 重命名当前会话 |
| `/tag` | - | 为会话添加标签 |
| `/btw` | - | 快速记笔记，补充上下文 |
| `/rewind` | - | 回滚到之前的对话状态 |

### 工具与技能

| 命令 | 别名 | 描述 |
|------|------|------|
| `/skills` | - | 管理技能（列出、启用、禁用） |
| `/mcp` | - | MCP 服务器管理（添加、连接、查看） |
| `/plugin` | - | 插件管理 |
| `/reloadPlugins` | - | 重新加载所有插件 |
| `/hooks` | - | 钩子系统管理 |
| `/keys` / `/keybindings` | - | 快捷键管理 |
| `/add-dir` | - | 添加技能目录 |
| `/terminalSetup` | - | 终端设置工具 |

### 语音与 Friend

| 命令 | 别名 | 描述 |
|------|------|------|
| `/voice` | feature 控制 | 语音听写模式 |
| `/friend` | - | Friend 虚拟宠物管理 |
| `/thinkback` | - | Thinkback 回放 |
| `/thinkbackPlay` | - | Thinkback 播放控制 |

###  Goal 与规划

| 命令 | 别名 | 描述 |
|------|------|------|
| `/goal` / `/goals` | - | 目标管理（创建、查看、更新） |
| `/plan` | - | 规划模式切换 |
| `/ultraplan` | feature 控制 | 高级规划模式 |
| `/agent` / `/agents` | - | 代理管理（列出、配置） |
| `/tasks` | - | 后台任务管理 |

### Git 与文件

| 命令 | 别名 | 描述 |
|------|------|------|
| `/diff` | - | 显示 Git diff |
| `/branch` | - | 分支管理 |
| `/files` | - | 显示会话中跟踪的文件 |
| `/commit` | ant 内部 | 创建 Git 提交 |
| `/commit-push-pr` | ant 内部 | 提交、推送、创建 PR |
| `/fork` | feature 控制 | Fork 子代理 |
| `/buddy` | feature 控制 | 协作编程伙伴 |

### 集成与外部服务

| 命令 | 别名 | 描述 |
|------|------|------|
| `/login` | - | 登录（非 3P 用户） |
| `/logout` | - | 登出 |
| `/feishu` | - | 飞书集成 |
| `/telegram` | - | Telegram 集成 |
| `/desktop` | - | 桌面应用模式 |
| `/mobile` | - | 移动端二维码 |
| `/install-github-app` | - | 安装 GitHub App |
| `/install-slack-app` | - | 安装 Slack App |
| `/bridge` | feature 控制 | 桥接模式 |
| `/peers` | feature 控制 | UDS 对等节点管理 |
| `/subscribe-pr` | feature 控制 | 订阅 PR 通知 |

### 诊断与开发

| 命令 | 别名 | 描述 |
|------|------|------|
| `/doctor` | - | 系统诊断，检查配置和依赖 |
| `/upgrade` | - | 升级 CLI 版本 |
| `/version` | ant 内部 | 显示版本信息 |
| `/heapdump` | - | 堆转储（调试用） |
| `/sandbox-toggle` | - | 沙箱模式开关 |
| `/debug-tool-call` | ant 内部 | 调试工具调用 |
| `/perf-issue` | ant 内部 | 性能问题报告 |
| `/ant-trace` | ant 内部 | Ant 追踪 |
| `/oauth-refresh` | ant 内部 | OAuth token 刷新 |
| `/color` | - | 更改 AI 颜色 |
| `/stickers` | - | 贴纸管理 |

### 反馈与分析

| 命令 | 别名 | 描述 |
|------|------|------|
| `/feedback` | - | 发送反馈 |
| `/review` | - | 代码审查 |
| `/ultrareview` | - | 深度代码审查 |
| `/security-review` | - | 安全审查 |
| `/insights` | - | 会话分析报告 |
| `/extra-usage` | - | 额外用量显示 |
| `/rate-limit-options` | - | 速率限制选项 |
| `/summary` | ant 内部 | 会话摘要生成 |
| `/share` | ant 内部 | 分享会话 |
| `/release-notes` | - | 版本发布说明 |
| `/cost` | - | 会话费用 |
| `/usage` | - | 使用情况 |

### 实验性 & Feature-gated

| 命令 | 别名 | 描述 |
|------|------|------|
| `/proactive` | feature 控制 | 主动模式 |
| `/brief` | feature 控制 | 简报模式 |
| `/assistant` | feature 控制 | 助手模式 |
| `/torch` | feature 控制 | Torch 调试工具 |
| `/web` / `/remote-setup` | feature 控制 | 远程设置 |
| `/workflows` | feature 控制 | 工作流管理 |
| `/force-snip` | feature 控制 | 强制截断上下文 |
| `/remoteControlServer` | feature 控制 | 远程控制服务器 |
| `/buddy` | feature 控制 | 编程伙伴 |
| `/agents-platform` | ant 内部 | 代理平台管理 |
| `/bughunter` | ant 内部 | Bug 猎人工具 |
| `/autofix-pr` | ant 内部 | 自动修复 PR |
| `/backfill-sessions` | ant 内部 | 回填会话数据 |
| `/issue` | ant 内部 | 问题管理 |
| `/onboarding` | ant 内部 | 引导流程 |
| `/teleport` | ant 内部 | 远程会话跳转 |
| `/good-claude` | ant 内部 | 内部工具 |
| `/ctx_viz` | ant 内部 | 上下文可视化 |
| `/mock-limits` | ant 内部 | Mock 限制测试 |
| `/bridge-kick` | ant 内部 | 桥接踢出 |
| `/reset-limits` | ant 内部 | 重置限制 |

---

## Skill 系统

技能（Skills）是以 Markdown 文件形式定义的提示词模板，可被 LLM 或用户调用。技能系统分为：

- **打包技能（Bundled Skills）**：随 CLI 发布的内置 `.md` 文件
- **用户技能目录（Skill Dir Commands）**：用户在工作区 `./claude/skills/` 或全局 `~/.claude/skills/` 中定义的技能
- **插件技能（Plugin Skills）**：从插件加载的技能
- **MCP 技能**：通过 MCP 协议提供的技能（`getMcpSkillCommands()`）

技能文件的 YAML frontmatter 定义 `name`、`description`、`model` 等属性，正文为发送给 LLM 的提示词。

### 技能相关工具

- `SkillTool`：AI 可调用的技能执行工具
- `getSkillToolCommands()`：获取所有可被模型调用的 prompt 类型命令
- `getSlashCommandToolSkills()`：获取斜杠命令可用的技能列表

---

## 工作流系统

工作流（Workflows）是通过 `WorkflowTool` 实现的多步骤脚本，支持：

- 顺序执行多个步骤
- 条件分支
- 变量传递
- 用户确认点

当 `WORKFLOW_SCRIPTS` feature flag 启用时，工作流命令通过 `createWorkflowCommand()` 注册。

---

## 命令类型

`Command` 类型包括三种变体：

| 类型 | 说明 |
|------|------|
| `prompt` | 扩展为提示词发送给模型（技能、工作流） |
| `local` | 本地执行，输出纯文本 |
| `local-jsx` | 本地执行，渲染 Ink UI 组件 |

---

## 配置管理

`/config` 命令管理系统设置。配置值存储在：

- **用户设置**：`~/.claude/settings.json`
- **项目设置**：`.claude/settings.json`（项目级覆盖）
- **会话设置**：仅当前会话有效

支持的配置项包括 theme、model、permissions（权限模式）、音效、通知等。

相关文件：
- `/home/yuki/Code/Agent/VersperClaw/src/commands.ts` — 命令注册与过滤核心
- `/home/yuki/Code/Agent/VersperClaw/src/types/command.ts` — Command 类型定义
- `/home/yuki/Code/Agent/VersperClaw/src/skills/loadSkillsDir.ts` — 技能目录加载
- `/home/yuki/Code/Agent/VersperClaw/src/tools/WorkflowTool/` — 工作流工具实现

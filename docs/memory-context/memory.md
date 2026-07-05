# 自动记忆系统

## 概述

Codev 拥有一个基于文件的持久化记忆存储系统（Memdir），允许 Agent 在不同会话间记住用户信息、偏好、项目上下文等。记忆存储在项目对应的 `~/.claude/projects/<slug>/memory/` 目录中。

---

## Memdir 系统

### 目录结构

```
~/.claude/projects/<project-slug>/memory/
├── MEMORY.md                  # 入口索引文件
├── user_role.md               # 用户类型记忆文件
├── feedback_testing.md        # 反馈类型记忆文件
├── project_deadlines.md       # 项目类型记忆文件
└── reference_dashboards.md    # 参考类型记忆文件
```

### 记忆类型

系统定义了四种记忆类型（`src/memdir/memoryTypes.ts`），限制为无法从项目当前状态推导出的信息：

| 类型 | 用途 | 示例 |
|------|------|------|
| **user** | 用户角色、职责、知识背景 | "用户是资深 Go 开发者，首次接触 React" |
| **feedback** | 用户对工作方式的指导 | "不要 mock 数据库——测试必须用真实数据库" |
| **project** | 项目上下文、目标、事件 | "2026-03-05 之后冻结所有非关键合并" |
| **reference** | 外部系统的指针 | "Pipeline bugs 在 Linear 项目 INGEST 中跟踪" |

### 不应该保存的内容

- 代码模式、架构、文件路径——这些可从当前项目状态推导
- Git 历史、最近的变更——`git log` / `git blame` 是权威来源
- 调试解决方案——修复在代码中，commit message 包含上下文
- 已在 CLAUDE.md 中记录的内容
- 临时任务细节——进行中的工作、临时状态

---

## MEMORY.md 入口索引

### 文件规范

MEMORY.md 是记忆系统的入口索引文件（非记忆本身）：

- 路径：`<memoryDir>/MEMORY.md`
- 最大行数：**200 行**（`MAX_ENTRYPOINT_LINES`）
- 最大字节数：**25,000 字节**（`MAX_ENTRYPOINT_BYTES`）
- 格式：每行一个条目：`- [Title](file.md) — 简短描述`
- 超过限制时自动截断并追加警告

### 截断策略

定义于 `src/memdir/memdir.ts` 的 `truncateEntrypointContent()`：

1. 首先按行数截断（保留前 200 行）
2. 然后按字节数截断（在最后一个换行符处切割，避免中断行）
3. 追加截断警告说明原因

---

## 记忆生命周期

### 保存（Save）

两种保存方式：

1. **显式请求**：用户要求 Agent 记住某事时立即保存
2. **系统自动提取**：通过 `extractMemories`（`src/services/extractMemories/extractMemories.ts`）在后台自动提取有价值的记忆

保存是两步过程：
1. 写入记忆文件（如 `user_role.md`），使用 frontmatter 格式
2. 在 `MEMORY.md` 中添加指向该文件的索引条目

### Frontmatter 格式

```markdown
---
name: {{记忆名称}}
description: {{一行描述——用于判断相关性，越具体越好}}
type: {{user / feedback / project / reference}}
---

{{记忆内容 — 对于 feedback/project 类型，结构为：规则/事实，然后 **Why:** 和 **How to apply:** 行}}
```

### 检索（Recall）

`findRelevantMemories()`（`src/memdir/findRelevantMemories.ts`）使用 Sonnet 模型选择与当前查询相关的记忆：

1. 扫描记忆目录中的所有文件，提取文件名和描述
2. 将查询和可用记忆清单发送给 Sonnet 模型
3. 模型返回最相关的记忆文件名列表（最多 5 个）
4. 返回绝对文件路径和 mtime

```typescript
export async function findRelevantMemories(
  query: string,          // 用户查询
  memoryDir: string,      // 记忆目录路径
  signal: AbortSignal,    // 取消信号
  recentTools?: string[], // 最近使用的工具（过滤不相关的 API 文档）
  alreadySurfaced?: Set<string>, // 已展示的文件（避免重复选择）
): Promise<RelevantMemory[]>
```

**选择性过滤**：
- 排除已在对话中展示的文件（`alreadySurfaced`）
- 排除最近正在使用的工具的参考文档
- 仍选择包含警告、陷阱、已知问题的记忆

### 更新（Update）

- 记忆文件的内容可以直接覆盖
- MEMORY.md 中的索引条目保持最新
- 语义而非时间顺序组织记忆

### 清除（Delete）

用户要求忘记时，找到并删除相关条目（记忆文件 + MEMORY.md 索引）。

---

## 记忆 Age（新鲜度追踪）

### mtime 追踪

每个记忆文件都有 `mtimeMs`（修改时间戳），在检索时返回：

```typescript
export type RelevantMemory = {
  path: string
  mtimeMs: number
}
```

### 新鲜度提示

- `MEMORY_DRIFT_CAVEAT`：记忆会随时间过时。在基于记忆回答前，需验证记忆是否仍准确
- 如果回忆的记忆与当前信息冲突，信任当前观察，更新或移除过时记忆

### 记忆推荐前的验证

即使回忆到的记忆命名了特定函数、文件或标志，也只是"在写入时存在"的声明。在推荐前：

- 如果记忆提到文件路径：检查文件是否存在
- 如果记忆提到函数或标志：通过 grep 确认
- 如果用户即将基于推荐采取行动：先验证

---

## 高级特性

### 团队记忆（Team Memory）

通过 `TEAMMEM` feature gate 启用。使用 `getTeamMemPath()`（`src/memdir/teamMemPaths.ts`）获取团队记忆目录路径。

团队记忆和私有记忆使用不同的作用域标签（`<scope>`），共享相同的四种记忆类型。

### 助手模式每日日志（Assistant Daily Log）

通过 `KAIROS` feature gate 启用。长期运行的助手模式的记忆策略：

- 按日期追加到 `logs/YYYY/MM/YYYY-MM-DD.md`
- 夜间 `/dream` 技能将日志蒸馏为主题文件 + MEMORY.md
- 避免在长时间会话中频繁重写 MEMORY.md

### 自动 Dream（Auto Dream）

`src/services/autoDream/autoDream.ts` 在后台自动执行记忆整理，包括：
- 合并重复记忆
- 更新过时信息
- 清除无关条目

### 团队记忆同步（Team Memory Sync）

`src/services/teamMemorySync/` 提供团队记忆的实时同步功能，包括文件监控（watcher）和秘密保护（secret guard）。

---

## 配置文件

### 路径解析

`getAutoMemPath()`（`src/memdir/paths.ts`）的路径解析顺序：

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 环境变量（完全路径覆盖）
2. `autoMemoryDirectory` 设置（来自 settings.json 的可信源）
3. `<memoryBase>/projects/<sanitized-git-root>/memory/`

### 启用/禁用

禁用链（优先级从高到低）：
1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/true` 环境变量
2. `CLAUDE_CODE_SIMPLE`（--bare 模式）
3. 远程模式但未设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR`
4. `autoMemoryEnabled: false` 在 settings.json 中
5. 默认：启用

### 核心文件

| 文件 | 路径 | 用途 |
|------|------|------|
| memdir.ts | `src/memdir/memdir.ts` | 记忆提示构建、入口索引管理 |
| paths.ts | `src/memdir/paths.ts` | 路径解析、启停检查 |
| findRelevantMemories.ts | `src/memdir/findRelevantMemories.ts` | 基于 Sonnet 的相关记忆检索 |
| memoryTypes.ts | `src/memdir/memoryTypes.ts` | 记忆类型定义和提示文本 |
| memoryScan.ts | `src/memdir/memoryScan.ts` | 记忆文件扫描 |

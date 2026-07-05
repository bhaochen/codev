# 上下文管理

## 概述

Codev 的上下文管理系统负责构建模型会话的输入上下文，包含系统级信息和用户级信息，并在上下文超过限制时自动压缩。

---

## 系统上下文（getSystemContext）

定义于 `src/context.ts`，通过 `getSystemContext()` 构建，缓存在会话期间不变。

### 包含内容

1. **Git 状态**（`getGitStatus()`）
   - 当前分支、主分支、Git 用户
   - 工作区状态（staged/unstaged 修改）
   - 最近 5 条 commit 记录
   - 限制在 2000 字符以内，超出时截断并提示用户使用 `git status`
   - 在 CCR 远程模式或 Git 指令禁用时跳过

2. **缓存破坏标记**（Cache Breaker）
   - 仅在 `BREAK_CACHE_COMMAND` feature gate 启用时注入
   - 用于紧急调试状态更新

### 代码结构

```typescript
export const getSystemContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    const gitStatus = isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
      ? null
      : await getGitStatus()
    return {
      ...(gitStatus && { gitStatus }),
      ...(injection && { cacheBreaker: `[CACHE_BREAKER: ${injection}]` }),
    }
  },
)
```

---

## 用户上下文（getUserContext）

定义于 `src/context.ts`，通过 `getUserContext()` 构建，同样缓存在会话期间不变。

### 包含内容

1. **CLAUDE.md 文件**
   - 自动发现项目中的 CLAUDE.md 文件（通过 `getClaudeMds()`）
   - 支持 `--add-dir` 在 bare 模式下添加额外的 CLAUDE.md 目录
   - 可通过 `CLAUDE_CODE_DISABLE_CLAUDE_MDS` 环境变量禁用
   - 记忆文件（memory files）被过滤后注入

2. **当前日期**
   - 格式：`Today's date is YYYY-MM-DD.`
   - 使用 `getLocalISODate()` 获取本地日期

### 代码结构

```typescript
export const getUserContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
```

---

## 上下文压缩（Compact）

当对话上下文超过 API 限制或用户手动触发时，自动或手动压缩对话历史。

### 压缩触发

| 触发方式 | 说明 |
|----------|------|
| **自动压缩** | 上下文超过阈值时自动触发（`autoCompactThreshold`） |
| **手动压缩** | 用户执行 `/compact` 命令 |
| **部分压缩** | 用户选择特定消息前后的历史进行压缩 |
| **反应式压缩** | API 返回 prompt-too-long 时自动触发 |

### 压缩流程（`src/services/compact/compact.ts`）

`compactConversation()` 主流程：

1. **PreCompact Hook**：执行预压缩钩子
2. **摘要生成**：将旧消息发送给模型生成摘要
   - 支持 prompt cache 共享（通过 forked agent 复用主会话的缓存前缀）
   - 自动重试（最多 3 次 PTL 重试 + 2 次流式重试）
3. **文件状态恢复**：重建最近读取的文件附件（最多 5 个文件，50K token 预算）
4. **状态恢复**：plan 文件、技能附件、异步 Agent 状态
5. **工具和 Agent 清单重新声明**：延迟工具、MCP 指令、Agent 列表
6. **SessionStart Hook**：执行会话启动钩子
7. **PostCompact Hook**：执行压缩后钩子

### 压缩边界消息

压缩后在消息流中插入 `SystemCompactBoundaryMessage`，包含：
- 压缩原因（auto/manual）
- 压缩前的 token 计数
- 上一个消息的 UUID（用于链式追踪）
- 用户反馈（手动压缩时）
- 压缩的消息数量

### 部分压缩（Partial Compact）

`partialCompactConversation()` 支持两种方向：

| 方向 | 说明 | 缓存影响 |
|------|------|----------|
| `from` | 压缩 pivot 索引之后的消息，保留之前的内容 | 保留前缀缓存 |
| `up_to` | 压缩 pivot 索引之前的消息，保留之后的内容 | 缓存失效 |

### 文件附件恢复

`createPostCompactFileAttachments()` 在压缩后自动恢复最近读取的文件：

- 基于读取时间戳排序，恢复最近的文件
- 跳过已在保留消息中的文件（避免重复）
- 跳过 plan 文件和记忆文件
- 受文件数量（5）和 token 预算（50K）双重限制
- 跳过 `FILE_UNCHANGED_STUB` 对应的文件（压缩时已处理的重复读取）

### 压缩注意事项

- **Plan 模式保持**：如果在 plan 模式下压缩，自动注入 plan mode 附件
- **技能保留**：已调用的技能内容会被保留（每个技能 5K token 预算，总 25K）
- **缓存破坏检测**：压缩后通知缓存破坏检测系统
- **会话元数据**：重新追加会话元数据（自定义标题、标签）
- **助手模式转录**：在 KAIROS 模式下，将压缩的对话段写入转录文件

---

## React Contexts（src/context/）

CLI 用户界面使用 React Context 管理多种状态：

### voice.tsx（语音上下文）
- `VoiceProvider` 提供语音状态管理
- 状态：`idle` / `recording` / `processing`
- 包含：录音状态、错误信息、实时转录文本、音频电平、预热状态
- 基于 React Context + Zustand-style store 模式

### mailbox.tsx（消息邮箱）
- 管理应用内消息队列
- 处理消息的发送、接收和状态更新

### stats.tsx（状态统计）
- 提供性能统计数据的上下文
- 包括 token 使用量、API 调用次数等

### notifications.tsx（通知系统）
- 管理应用内通知
- 支持不同优先级（immediate、later）
- 支持不同颜色（error、info 等）

### fpsMetrics.tsx（FPS 指标）
- 跟踪 UI 渲染性能
- 用于调试和优化

### modalContext.tsx（模态框上下文）
- 管理模态对话框的显示和隐藏
- 支持堆叠模式

### promptOverlayContext.tsx（提示覆盖层）
- 管理提示输入区域的覆盖层

### overlayContext.tsx（覆盖层上下文）
- 管理通用覆盖层组件

### QueuedMessageContext.tsx（队列消息上下文）
- 管理消息队列状态
- 处理消息的排队和调度

---

## 核心文件

| 文件 | 路径 | 用途 |
|------|------|------|
| context.ts | `src/context.ts` | 系统和用户上下文构建（getSystemContext / getUserContext） |
| compact.ts | `src/services/compact/compact.ts` | 对话压缩主逻辑 |
| compactWarningHook.ts | `src/services/compact/compactWarningHook.ts` | 压缩警告钩子 |
| compactWarningState.ts | `src/services/compact/compactWarningState.ts` | 压缩警告状态管理 |
| postCompactCleanup.ts | `src/services/compact/postCompactCleanup.ts` | 压缩后清理 |

# 调试系统

## 概述

VersperClaw 提供两层调试能力：

1. **会话级调试日志** — 基于 `logForDebugging()` 的持久化日志系统，用于内部诊断
2. **`/debug` 交互式调试** — 基于 DEBUG PROBE 的主动式调试工作流（v2.0）

---

## 1. 会话调试日志

### 基础用法

通过 CLI 标志启用：

```bash
claude --debug              # 启用调试日志
claude --debug=api,hooks    # 按分类过滤
claude -d                   # 简写
claude --debug-file=/tmp/debug.log  # 自定义日志路径
claude --debug-to-stderr    # 输出到 stderr
```

环境变量：

| 变量 | 说明 |
|------|------|
| `DEBUG` / `DEBUG_SDK` | 启用调试模式 |
| `CLAUDE_CODE_DEBUG_LOG_LEVEL` | 最低级别：`verbose`, `debug`, `info`, `warn`, `error` |
| `CLAUDE_CODE_DEBUG_LOGS_DIR` | 自定义日志目录 |

### 日志位置

默认路径：`~/.claude/debug/<sessionId>.txt`

`latest` 符号链接总是指向最新会话的日志文件。

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/utils/debug.ts` | `logForDebugging()`, `isDebugMode()`, `enableDebugLogging()`, `getDebugLogPath()` |
| `src/utils/debugFilter.ts` | 分类过滤：`parseDebugFilter()`, `shouldShowDebugMessage()` |
| `src/utils/bufferedWriter.ts` | 缓冲写入器，批量写入日志 |

`logForDebugging()` 在代码库中 250+ 个文件中使用。

---

## 2. `/debug` 交互式调试（v2.0）

### 架构

```
用户输入 /debug <bug描述>
        │
        ▼
debug.ts (bundled skill)
        │
        ▼
8 步 CHECKPOINT 工作流注入模型上下文
        │
        ▼
模型自动执行：分析 → 插探针 → 复现 → 分析日志 → 修复 → 验证 → 清理
        │
        ▼
DebugSessionTool — 管理 .versperclaw-debug/ 目录
```

### 与 v1 的区别

| 方面 | v1（旧） | v2.0（当前） |
|------|---------|-------------|
| 方式 | 被动读取调试日志 | 主动插入探针 |
| 数据源 | `~/.claude/debug/*.txt` | `.versperclaw-debug/debug.log` |
| 模型角色 | 分析已有日志 | 插桩 → 复现 → 分析 → 修复 |
| 工作流 | 无结构化步骤 | 8 步 CHECKPOINT |

### 8 步 CHECKPOINT 工作流

| 步骤 | 操作 |
|------|------|
| **Step 0: Triage** | 确认 bug 报告完整（预期/实际/复现步骤/一致性/错误） |
| **Step 1: Plan Probes** | 阅读代码，形成 2-3 个假设，输出探针插入计划表 |
| **Step 2: Init Session** | 调用 `DebugSession({ action: "init" })` 创建 `.versperclaw-debug/` |
| **Step 3: Insert Probes** | 用 Edit 插入 `DEBUG PROBE [N]` / `DEBUG PROBE END [N]` 代码块 |
| **Step 4: Reproduce & Log** | 调用 `DebugSession begin_run`，运行复现命令，通过 `read_log` 收集 |
| **Step 5: Analyze** | 引用日志行，定位根因 |
| **Step 6: Fix & Verify** | 修复后调用 `begin_verify`，重跑，对比日志 |
| **Step 7: Cleanup** | 删除所有探针，Grep 确认清理，调用 `DebugSession cleanup` |
| **Final** | 总结根因、证据、修复、验证、清理 |

### DEBUG PROBE 格式

```typescript
// DEBUG PROBE [1] <label>
try {
  require('fs').appendFileSync('.versperclaw-debug/debug.log',
    `[${new Date().toISOString()}] [js] file.ts:42 | label | value=${JSON.stringify(value)}\n`)
} catch {}
// DEBUG PROBE END [1]
```

规则：
- 探针必须是**只观察不修改**的
- 每个探针有唯一编号 `[N]` 和匹配的 START/END 标记
- 每种语言的探针模板不同（JS/TS、Python、Go、Rust）
- 最多 3 轮探针迭代
- 必须在最终回复前完全清理

### DebugSession 工具

工具名：`DebugSession`

可用动作：

| 动作 | 说明 |
|------|------|
| `init` | 创建 `.versperclaw-debug/` 目录、`debug.log`、`state` 文件 |
| `begin_run` | 追加 `RUN #N` 分隔符，递增运行计数器 |
| `begin_verify` | 追加 `VERIFY` 分隔符 |
| `read_log` | 读取 `debug.log` 尾部内容 |
| `cleanup` | 删除 `.versperclaw-debug/` 目录 |

### 目录结构

```
.versperclaw-debug/
  debug.log       -- 探针写入 + RUN/VERIFY 分隔符
  state           -- JSON: { "runCount": 3 }
```

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/skills/bundled/debug.ts` | `/debug` skill 定义，8 步工作流提示词，探针模板 |
| `src/tools/DebugSessionTool.ts` | DebugSession 工具实现 |
| `src/utils/debug.ts` | 通用调试日志基础设施 |
| `src/commands/debug-tool-call/index.js` | 遗留桩命令（`isEnabled: false`） |

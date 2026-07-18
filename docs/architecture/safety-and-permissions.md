# 安全与权限系统深度分析

> 本文基于 Codev (Claude Code) 源代码，深入分析其安全架构与权限子系统。
> 版本参考：commit `835ff5a` / `cdb3bdd`

---

## 1. 设计哲学

### 1.1 Deny-First 原则

系统中所有权限检查的**默认行为是拒绝**。未在规则中明确允许的操作，最终都会向用户发起询问或直接被拒绝。这一原则贯穿整个权限管道（Authorization Pipeline），体现在：

- `PermissionResult` 的默认行为是 `ask`（询问用户），而非 `allow`
- 工具实现的 `checkPermissions()` 方法若返回 `passthrough`，上层会将其转换为 `ask`（`src/utils/permissions/permissions.ts:1300-1310`）
- `bypassPermissions` 模式是唯一能跳过所有检查的模式，但该模式可以通过 Statsig 门控（`tengu_disable_bypass_permissions_mode`）被完全禁用

### 1.2 人类决策权威

用户始终拥有最终决定权。在任何权限模式下，用户都可以通过终端对话框批准或拒绝操作。即使在 `auto` 模式下，当分类器（Classifier）判定需阻止操作时，用户仍可通过交互式对话框覆盖分类器决定。

系统通过以下机制保障人类决策权威：

- **建议系统**（`generateSuggestions`, `src/utils/permissions/filesystem.ts:1414-1473`）：当询问用户时，同时提供可操作的建议（如"允许本次会话的所有编辑"、"添加目录到工作区"）
- **权限解释器**（`PermissionExplainer`, `src/utils/permissions/permissionExplainer.ts`）：使用 Haiku 模型解释命令的风险等级（LOW/MEDIUM/HIGH）、目的和潜在风险，辅助用户决策
- **渐进式暴露**：只对高风险操作发起询问，低风险操作在适当模式下自动批准

### 1.3 防御纵深

系统采用**多层重叠的安全机制**，而非依赖单一安全边界。这意味着即使某一层被绕过，后续层仍能提供保护。

```
┌─────────────────────────────────────────────────────┐
│                   防御纵深架构                         │
├─────────────────────────────────────────────────────┤
│ 1. 规则系统 (deny/allow/ask rules)                   │
│ 2. PreToolUse Hook (用户自定义拦截)                   │
│ 3. 路径安全检查 (Dangerous Files, Windows 模式)       │
│ 4. 模式驱动的权限处理 (Mode-based Decision)            │
│ 5. 自动模式分类器 (Auto Mode Classifier)              │
│ 6. 用户确认对话框 (User Confirmation Dialog)           │
│ 7. 沙箱 (Sandbox) 容器化执行                          │
│ 8. 拒绝跟踪 (Denial Tracking) 防滥用                  │
└─────────────────────────────────────────────────────┘
```

### 1.4 渐进信任

系统支持用户通过时间建立信任轨迹。随着用户批准更多操作，系统会逐步提高自动化程度：

- **默认模式**：auto-approve rate 起始约 20%，每一步都需确认
- **auto 模式改进**：系统通过拒绝跟踪（`denialTracking.ts`）记录分类器连续拒绝次数，超过阈值（连续 3 次或总计 20 次）后回退到用户询问模式
- **规则积累**：用户可逐步添加 `alwaysAllow` 规则（如 `Bash(ls:*)`），减少未来对低风险操作的询问
- **acceptEdits 模式**：一旦用户选择此模式，工作目录内的所有文件编辑操作自动批准

---

## 2. 七种权限模式

权限模式定义在 `src/types/permissions.ts:16-36`，运行时配置在 `src/utils/permissions/PermissionMode.ts:42-91`。

### 模式总览

| 模式 | 内部名称 | 符号 | 自动批准 | 需要确认 | 风险等级 |
|------|----------|------|----------|----------|----------|
| 默认 | `default` | — | 无 | 所有操作 | 低（最安全） |
| 接受编辑 | `acceptEdits` | ⏵⏵ | 工作目录内文件编辑 | Bash 命令、目录外写入、MCP | 中低 |
| 计划 | `plan` | ⏸ | 读操作（文件读取、搜索） | 写操作、Bash 命令 | 低 |
| 自动 | `auto` | ⏵⏵ | 分类器批准的 + 安全放行列表 | 分类器阻止的 | 中 |
| 不询问 | `dontAsk` | ⏵⏵ | 无（所有 ask → deny） | 无法操作 | 高 |
| 绕过权限 | `bypassPermissions` | ⏵⏵ | 所有操作（除安全检查外） | 安全检查（.git/ 等） | 最高 |
| Bubble | `bubble` | — | Ant 内部使用 | Ant 内部使用 | — |

### 2.1 Default（默认模式）

**文件**: `src/utils/permissions/PermissionMode.ts:45-50`

```typescript
default: {
  title: 'Default',
  shortTitle: 'Default',
  symbol: '',
  color: 'text',
  external: 'default',
}
```

- **行为**: 每一步操作都需要用户确认
- **自动批准**: 无
- **询问**: 所有工具调用
- **适用场景**: 新项目、不信任 AI 操作时
- **风险**: 最低，但效率也最低

### 2.2 AcceptEdits（接受编辑模式）

**文件**: `src/utils/permissions/PermissionMode.ts:59-65`

```typescript
acceptEdits: {
  title: 'Accept edits',
  shortTitle: 'Accept',
  symbol: '⏵⏵',
  color: 'autoAccept',
  external: 'acceptEdits',
}
```

- **行为**: 自动批准工作目录内的文件编辑操作（`FileEditTool`, `FileWriteTool`）
- **自动批准**: 工作目录（`getOriginalCwd()` 已在 `additionalWorkingDirectories` 中的路径）内的文件写入
- **询问**: Bash 命令、工作目录外的文件写入、MCP 工具、网络操作
- **实现参考**: `src/utils/permissions/filesystem.ts:1360-1375` — 当 `mode === 'acceptEdits'` 且路径在工作目录内时，直接返回 `allow`
- **适用场景**: 用户希望 AI 可以直接修改代码，但不想让其执行任意命令

### 2.3 Plan（计划模式）

**文件**: `src/utils/permissions/PermissionMode.ts:52-58`

```typescript
plan: {
  title: 'Plan Mode',
  shortTitle: 'Plan',
  symbol: PAUSE_ICON,
  color: 'planMode',
  external: 'plan',
}
```

- **行为**: 只读模式 + 计划讨论
- **自动批准**: 所有读操作（文件读取、搜索、列表等）
- **询问**: 文件编辑、Bash 命令、网络操作
- **内部机制**: 当从 auto 模式进入 plan 时，auto 分类器仍在后台运行（`prePlanMode` 记录），退出 plan 时恢复 auto 状态（`src/utils/permissions/permissionSetup.ts:1462-1493`）
- **适用场景**: 探索代码库、制定重构计划、代码审查

**与 Auto 模式的联动**（`permissionSetup.ts:1446-1455`）：

当用户已选择加入 auto 模式且 `useAutoModeDuringPlan` 启用时，plan 模式下分类器仍处于激活状态。这通过 `shouldPlanUseAutoMode()` 函数判断。

### 2.4 Auto（自动模式）

**文件**: `src/utils/permissions/PermissionMode.ts:80-90`

```typescript
...(feature('TRANSCRIPT_CLASSIFIER')
  ? {
      auto: {
        title: 'Auto mode',
        shortTitle: 'Auto',
        symbol: '⏵⏵',
        color: 'warning',
        external: 'default',
      },
    }
  : {}),
```

- **行为**: 使用 AI 分类器自动审批操作
- **内部依赖**: `feature('TRANSCRIPT_CLASSIFIER')` — 编译期 feature flag，外部构建中通过 DCE（死代码消除）完全移除
- **自动批准**:
  1. `acceptEdits` 快速路径可批准的（工作目录内编辑）
  2. 安全放行列表中的工具（`isAutoModeAllowlistedTool`, `classifierDecision.ts:96-100`）
  3. 分类器判定为安全的操作
- **询问**: 分类器判定为需阻止的操作（可被用户覆盖）
- **拒绝限制**: 连续 3 次阻止 → 回退到询问；总计 20 次阻止 → 重置并回退（`denialTracking.ts:12-14`）

### 2.5 DontAsk（不询问模式）

**文件**: `src/utils/permissions/PermissionMode.ts:73-79`

```typescript
dontAsk: {
  title: "Don't Ask",
  shortTitle: 'DontAsk',
  symbol: '⏵⏵',
  color: 'error',
  external: 'dontAsk',
}
```

- **行为**: 将所有 `ask` 决策转换为 `deny`
- **转换**: `src/utils/permissions/permissions.ts:505-518`
  ```typescript
  if (appState.toolPermissionContext.mode === 'dontAsk') {
    return {
      behavior: 'deny',
      decisionReason: { type: 'mode', mode: 'dontAsk' },
      message: DONT_ASK_REJECT_MESSAGE(tool.name),
    }
  }
  ```
- **适用场景**: 测试、CI/CD 环境或不想让 AI 执行任何操作的场景

### 2.6 BypassPermissions（绕过权限模式）

**文件**: `src/utils/permissions/PermissionMode.ts:66-72`

- **行为**: 绕过所有权限检查（除安全检查和内容特定 ask 规则外）
- **禁用机制**: 可通过 Statsig 门控 `tengu_disable_bypass_permissions_mode` 或 settings 中 `permissions.disableBypassPermissionsMode` 完全禁用（`permissionSetup.ts:695-711`）
- **例外**: `bypassPermissions` 不影响 `requiresUserInteraction` 检查（`permissions.ts:1231-1236`）、安全检查（`permissions.ts:1255-1260`）和内容特定 ask 规则（`permissions.ts:1244-1250`）

### 2.7 Bubble（气泡模式）

- **用途**: Ant 内部使用模式，外部构建不可见（`PermissionMode.ts:104` 中 `process.env.USER_TYPE !== 'ant'` 时被排除）
- **文档**: 无外部可用信息

---

## 3. 授权管道 (Authorization Pipeline)

核心实现位于 `src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseToolInner()` 函数（第 1158-1319 行）和 `hasPermissionsToUseTool()`（第 473-956 行）。

### 管道全景图

```
用户输入工具调用
        │
        ▼
┌─────────────────────────────────────┐
│ 1. 预过滤                           │
│    1a. 全局 deny 规则检查            │
│    1b. 全局 ask 规则检查             │
│    1c. 工具特定 checkPermissions()   │
│    1d. 工具实现 deny                 │
│    1e. requiresUserInteraction 检查  │
│    1f. 内容特定 ask 规则检查          │
│    1g. 安全检查 (safety check)       │
└─────────────────┬───────────────────┘
                  │ (2a-2b)
                  ▼
┌─────────────────────────────────────┐
│ 2. 权限处理                         │
│    2a. bypassPermissions 模式放行    │
│    2b. 全局 allow 规则放行           │
│    2c. passthrough → ask 转换       │
└─────────────────┬───────────────────┘
                  │ (返回 ask/allow/deny)
                  ▼
┌─────────────────────────────────────┐
│ 3. 模式转换 (在 hasPermissionsToUse) │
│    3a. dontAsk 模式: ask → deny     │
│    3b. Auto 模式:                   │
│        ├ 非分类器可批准的安全检查: 返回 │
│        ├ PowerShell 默认拒绝         │
│        ├ acceptEdits 快速路径        │
│        ├ 安全放行列表                 │
│        └ YOLO 分类器评估              │
│    3c. 无提示模式: hooks → auto-deny│
└─────────────────┬───────────────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ 用户确认对话框    │
         │ (useCanUseTool)  │
         └─────────────────┘
```

### 3.1 第 1 步：规则预过滤

在 `hasPermissionsToUseToolInner()`（第 1158-1260 行）中执行：

**1a. 全局 Deny 规则**（第 1171-1181 行）：
```typescript
const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
if (denyRule) { return { behavior: 'deny', message: `Permission to use ${tool.name} has been denied.` } }
```

**1b. 全局 Ask 规则**（第 1184-1206 行）：检查工具是否在 alwaysAsk 列表中。例外：如果 sandbox 启用且 `autoAllowBashIfSandboxed` 为 true，sandbox 内运行的 Bash 命令可跳过此检查。

**1c. 工具特定权限检查**（第 1214-1223 行）：
```typescript
const parsedInput = tool.inputSchema.parse(input)
toolPermissionResult = await tool.checkPermissions(parsedInput, context)
```
每个工具实现自己的 `checkPermissions()` 方法。例如 `BashTool` 实现命令级规则（前缀匹配、通配符匹配）。

**1d. 工具实现 Deny**（第 1226-1228 行）：如果工具的 `checkPermissions` 返回 `deny`，直接返回。

**1e. 用户交互要求**（第 1231-1236 行）：如果工具标记为 `requiresUserInteraction()`，即使是 `bypassPermissions` 模式也必须询问。

**1f. 内容特定 Ask 规则**（第 1244-1250 行）：如 `Bash(npm publish:*)` 这样的规则，即使是 `bypassPermissions` 也必须尊重。

**1g. 安全检查**（第 1255-1260 行）：`checkPathSafetyForAutoEdit` 返回的安全检查（如 `.git/`、`.claude/`、shell 配置文件）是 bypass-immune 的。

### 3.2 第 2 步：权限处理

**2a. bypassPermissions 模式**（第 1268-1281 行）：直接放行所有操作（1a-1g 已过滤的危险操作除外）。

**2b. 全局 Allow 规则**（第 1284-1297 行）：如果工具在 `alwaysAllow` 列表中，直接放行。

**2c. passthrough → ask 转换**（第 1300-1310 行）：如果 `checkPermissions` 返回 `passthrough`，转换为 `ask`。

### 3.3 第 3 步：模式转换

在 `hasPermissionsToUseTool()`（第 473-956 行）中执行：

**3a. dontAsk**: 将所有 `ask` 转换为 `deny`（第 505-518 行）。

**3b. Auto 模式**: 复杂的分类器驱动审批流程（第 520-926 行）：
1. 非分类器可批准的安全检查 → 保持询问
2. `requiresUserInteraction()` 的工具 → 保持询问
3. 拒绝跟踪检查
4. PowerShell 默认拒绝（除非 `POWERSHELL_AUTO_MODE` 特性启用）
5. **acceptEdits 快速路径**: 如果当前操作在 acceptEdits 模式下会被批准，直接放行（第 600-655 行）
6. **安全放行列表**: `isAutoModeAllowlistedTool()` 中的工具（第 660-685 行）
7. **分类器评估**: `classifyYoloAction()` 执行完整的安全评估（第 692-926 行）

**3c. 无提示模式**: `shouldAvoidPermissionPrompts` 为 true 时（后台/headless agent），执行 PermissionRequest hooks，若 hook 未决定则 auto-deny（第 932-952 行）。

### 3.4 CLI Hook 整合

在 `src/hooks/useCanUseTool.tsx` 中，结果经过：
1. `hasPermissionsToUseTool()` 管道
2. 如果 `allow` → 立即批准，记录分类器批准信息
3. 如果 `deny` → 拒绝，记录 auto mode denial，发送通知
4. 如果 `ask` → 进入交互式权限处理流程：
   - `awaitAutomatedChecksBeforeDialog` → 协调器处理
   - Swarm Worker 处理（`handleSwarmWorkerPermission`）
   - 竞争性分类器检查（Bash 命令的投机性分类器评估，`peekSpeculativeClassifierCheck`）
   - 最终 `handleInteractivePermission` 显示对话框

---

## 4. Auto-Mode 分类器

### 4.1 架构概览

Auto mode 分类器是系统的核心智能审批组件，使用 Claude 模型（默认使用主循环模型，可被 `CLAUDE_CODE_AUTO_MODE_MODEL` 环境变量或 GrowthBook 配置覆盖）对每个待审批的工具调用进行安全评估。

**核心文件**:
- `src/utils/permissions/yoloClassifier.ts` — 分类器主逻辑、2 阶段 XML 分类器
- `src/utils/permissions/classifierDecision.ts` — 安全放行列表
- `src/utils/permissions/classifierShared.ts` — 共享解析工具
- `src/utils/permissions/yolo-classifier-prompts/` — 系统提示模板

### 4.2 两阶段分类器

系统支持三种分类器模式，通过 GrowthBook `tengu_auto_mode_config.twoStageClassifier` 配置：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `both` (默认) | Stage 1 (fast) + Stage 2 (thinking) | 平衡速度与准确率 |
| `fast` | 仅 Stage 1，max_tokens=256，最终裁定 | 追求速度 |
| `thinking` | 仅 Stage 2，跳过 Stage 1 | 需要深度推理 |

**Stage 1 - 快速判断**（`yoloClassifier.ts:769-858`）：
- `max_tokens=64`（fast-only 模式为 256）
- `stop_sequences=['</block>']` — 一旦输出 `</block>` 立即停止
- 后缀：`"\nErr on the side of blocking. <block> immediately."`
- 如果 stage 1 判定允许（`<block>no</block>`），直接返回
- 如果 stage 1 判定阻止（`<block>yes</block>`），进入 stage 2

**Stage 2 - 深度推理**（`yoloClassifier.ts:861-940`）：
- `max_tokens=4096`
- 包含 `xml_s2_t2` 后缀，要求 chain-of-thought 推理
- 可包含 `<thinking>` 标签
- 最终输出 `<block>yes/no</block>` 和可选的 `<reason>...</reason>`

### 4.3 双阶段上下文预算

```
┌──────────────────────────────────────────────────────┐
│  上下文窗口管理                                       │
├──────────────────────────────────────────────────────┤
│ System Block (cache_control) ← 稳定缓存前缀            │
│   └ 基础提示 + 权限模板 + 用户 allow/deny 规则         │
│                                                       │
│ CLAUDE.md (cache_control) ← 静态用户指令               │
│                                                       │
│ Transcript Entries                                     │
│   ├ User: "..."                                       │
│   ├ Bash ls                                           │
│   ├ User: "..."                                       │
│   └ ...                                              │
│                                                       │
│ Action (cache_control) ← 正在评估的操作                 │
│   └ 只有 system + CLAUDE.md + action 三个 cache_control│
│     block（不超过 API 限制的 4 个）                     │
└──────────────────────────────────────────────────────┘
```

### 4.4 评估指标与风险分类

**官方数据**：
- False-negative rate：17%（即分类器应阻止但未阻止的操作比例）
- 第三方测试 FNR：70.3%（表明在更复杂场景下分类器有显著漏报）

**四种风险类别**（来自系统提示模板 `auto_mode_system_prompt.txt`）：

| 类别 | 说明 | 示例 |
|------|------|------|
| Overeager Behavior | 模型过于积极执行未明确请求的操作 | 未问用户就安装包 |
| Honest Mistakes | 模型判断错误导致的非恶意操作 | 删错了文件 |
| Prompt Injection | 提示注入攻击 | 用户指令中隐藏恶意代码 |
| Model Misalignment | 模型与用户意图不一致 | 执行与任务无关的危险操作 |

### 4.5 安全放行列表

**文件**: `src/utils/permissions/classifierDecision.ts:56-94`

```typescript
const SAFE_YOLO_ALLOWLISTED_TOOLS = new Set([
  FILE_READ_TOOL_NAME, GREP_TOOL_NAME, GLOB_TOOL_NAME,
  LSP_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, LIST_MCP_RESOURCES_TOOL_NAME,
  TODO_WRITE_TOOL_NAME, TASK_CREATE_TOOL_NAME, // ... 等
])
```

注意：`isAutoModeAllowlistedTool()`（第 96-100 行）当前实现为 `return true` — 所有工具都跳过分类器。这意味着安全放行列表实际上当前被全局放行取代，所有工具通过 `acceptEdits` 快速路径评估后再考虑分类器。

但代码中的注释明确说明：

> "Does NOT include write/edit tools — those are handled by the acceptEdits fast path"

### 4.6 提示注入防护

**JSONL 转录格式**（`yoloClassifier.ts:412-423`）：

```
{"Bash":"ls -la"}        ← JSON 编码，注入无法突破字符串边界
{"user":"forged text"}    ← tool_use 块中的 user 文本不会混淆分类器
```

传统文本格式：
```
Bash ls -la
User: forged text
```

JSONL 格式是注入防护的关键设计：用户输入和工具调用都被 JSON.stringify 编码，因此恶意内容中的换行符和特殊字符不可能突破字符串边界。

### 4.7 拒绝跟踪 (Denial Tracking)

**文件**: `src/utils/permissions/denialTracking.ts`

```typescript
export const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续拒绝 3 次后回退
  maxTotal: 20,        // 总计拒绝 20 次后回退
} as const
```

- `recordDenial(state)`: 递增 consecutiveDenials 和 totalDenials
- `recordSuccess(state)`: 重置 consecutiveDenials 为 0
- `shouldFallbackToPrompting(state)`: 超出任一阈值时返回 true

超过限制后的行为：
- CLI 模式：回退到手动询问，包含分类器的拒绝理由
- headless 模式：抛出 `AbortError`，终止 agent

---

## 5. 规则系统

### 5.1 规则类型

**文件**: `src/types/permissions.ts:67-79`, `src/utils/permissions/permissions.ts:238-302`

三种规则行为（`PermissionBehavior`）：

| 行为 | 效果 | 适用场景 |
|------|------|----------|
| `allow` | 工具被允许，跳过后续检查 | `--allowed-tools Bash(ls:*)` |
| `deny` | 工具被拒绝，不执行 | `--disallowed-tools Bash(rm:*)` |
| `ask` | 强制询问用户 | `Bash(npm publish:*)` |

### 5.2 规则来源

**文件**: `src/types/permissions.ts:54-62`

| 来源 | 持久化 | 说明 |
|------|--------|------|
| `userSettings` | `~/.claude/settings.json` | 全局用户设置 |
| `projectSettings` | `.claude/settings.json` | 项目级别，可提交到 git |
| `localSettings` | `.claude/settings.local.json` | 项目级别，gitignored |
| `policySettings` | 企业策略 | 只读，不可删除 |
| `flagSettings` | 编译期标志 | 只读 |
| `cliArg` | CLI 参数 | `--allowed-tools`, `--disallowed-tools` |
| `command` | 斜杠命令 | 命令前导块中的规则 |
| `session` | 内存 | 临时会话规则 |

规则加载流程（`permissionsLoader.ts:120-133`）：
1. 如果 `allowManagedPermissionRulesOnly` 为 true → 只加载 `policySettings`
2. 否则加载所有已启用的设置源

### 5.3 路径模式匹配

**文件**: `src/utils/permissions/filesystem.ts:960-1025`

使用 gitignore 风格的 `ignore` 库进行路径匹配：

```typescript
export function matchingRuleForInput(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null
```

**关键要点**：
- 路径被规范化为 POSIX 格式（`relativePath` 函数，第 170-179 行）
- 双斜杠前缀 `//` 表示相对于根 `/` 的路径
- 波浪号前缀 `~/` 表示相对于用户主目录的路径
- 模式 `/**` 后缀被简化为匹配目录本身及其所有子项
- 大小写标准化（`normalizeCaseForComparison`）防止大小写绕过

### 5.4 路径安全检查

**文件**: `src/utils/permissions/filesystem.ts:620-665`

`checkPathSafetyForAutoEdit()` 检查：

1. **Windows 可疑路径模式**（`hasSuspiciousWindowsPathPattern`, `filesystem.ts:537-602`）：
   - NTFS Alternate Data Streams（`:` 号，仅 Windows/WSL）
   - 8.3 短文件名（`~` 后跟数字）
   - 长路径前缀（`\\?\`, `//?/` 等）
   - 尾部点和空格（`.git.`, `.claude.`）
   - DOS 设备名（`CON`, `PRN`, `AUX` 等）
   - 三个连续点（`...`）
   - UNC 路径（`\\server\share`）

2. **Claude 配置文件**（`isClaudeConfigFilePath`, `filesystem.ts:225-242`）：
   - `settings.json`, `settings.local.json`
   - `.claude/commands/`, `.claude/agents/`, `.claude/skills/`

3. **危险文件**（`DANGEROUS_FILES`, `filesystem.ts:57-68`）：
   - `.gitconfig`, `.gitmodules`
   - `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`
   - `.ripgreprc`, `.mcp.json`, `.claude.json`

4. **危险目录**（`DANGEROUS_DIRECTORIES`, `filesystem.ts:74-79`）：
   - `.git`, `.vscode`, `.idea`, `.claude`

安全检查也适用于解析后的符号链接路径，防止通过符号链接绕过。

### 5.5 危险权限检测

**文件**:
- `src/utils/permissions/permissionSetup.ts:94-285`
- `src/utils/permissions/dangerousPatterns.ts`

进入 auto 模式时，系统自动检测并剥离（strip）危险权限：

**危险 Bash 规则**（`isDangerousBashPermission`）：
```typescript
// 完全通配: Bash, Bash(*), Bash() → 允许所有命令 → 危险
// 解释器通配: Bash(python:*) → 允许任意 Python 代码 → 危险
// 包管理器: Bash(npm run:*) → 可执行任意脚本 → 危险
```

匹配模式列表（`dangerousPatterns.ts`）：
```typescript
CROSS_PLATFORM_CODE_EXEC = [
  'python', 'python3', 'node', 'deno', 'ruby', 'perl', 'php', 'lua',
  'npx', 'bunx', 'npm run', 'yarn run', 'pnpm run', 'bun run',
  'bash', 'sh', 'ssh',
]
// ant-only: gh, curl, wget, git, kubectl, aws, gcloud, gsutil
```

**危险 PowerShell 规则**（`isDangerousPowerShellPermission`, `permissionSetup.ts:157-233`）：
额外包含 `iex`, `invoke-expression`, `start-process`, `add-type`, `new-object` 等。

**危险 Agent 规则**（`isDangerousTaskPermission`）：
任何 `Agent` 工具的 allow 规则都会绕过分类器对子 agent 的评估。

### 5.6 影子规则检测

**文件**: `src/utils/permissions/shadowedRuleDetection.ts`

检测 allow 规则是否被 ask/deny 规则"屏蔽"（即永远无法生效）：

```typescript
// 示例: allow 规则 Bash(ls:*) 被全局 ask 规则 Bash 屏蔽
// 因为 ask 规则在评估顺序中先于 allow 规则
```

- **Deny 屏蔽**: 工具级别的 deny 规则使该工具的所有 allow 规则不可达
- **Ask 屏蔽**: 工具级别的 ask 规则使带内容的 allow 规则不可达（总是会先询问）
- **沙箱例外**: 如果 sandbox 启用且 `autoAllowBashIfSandboxed` 为 true，个人设置的 ask 规则不屏蔽 allow 规则

---

## 6. Shell 沙箱

### 6.1 容器化执行环境

**文件**: `src/utils/sandbox/sandbox-adapter.ts`

SandboxManager 提供容器化的命令执行环境，支持：

- **文件系统隔离**: `getFsReadConfig()` / `getFsWriteConfig()` 控制可读写的路径
- **网络隔离**: `getNetworkRestrictionConfig()` 控制网络访问
- **命令排除**: `excludedCommands` 列表中的命令不被沙箱化

### 6.2 AutoAllowBashIfSandboxed

**文件**: `src/utils/sandbox/sandbox-adapter.ts:469-472`

```typescript
function isAutoAllowBashIfSandboxed(): boolean {
  const settings = getSettings_DEPRECATED()
  return settings?.sandbox?.autoAllowBashIfSandboxed ?? true  // 默认开启
}
```

当此选项启用时：
1. 所有 Bash 命令在沙箱内运行
2. Bash 命令的权限检查被自动放行（`permissions.ts:1189-1193`）
3. 命令不在沙箱内运行时（`dangerouslyDisableSandbox = true` 或 `excludedCommands`），仍遵循正常权限检查

### 6.3 平台支持

支持通过 `enabledPlatforms` 配置控制哪些平台启用沙箱：
```typescript
// src/entrypoints/sandboxTypes.ts:108-112
// 为了 NVIDIA 企业部署，最初仅 macOS 启用沙箱
// Linux/WSL 沙箱支持较新，在扩展前需要更多验证
```

### 6.4 Sandbox 写允许列表

在路径验证中（`pathValidation.ts:101-123`），当沙箱启用时，沙箱配置的写允许列表作为额外的工作目录：

```typescript
export function isPathInSandboxWriteAllowlist(resolvedPath: string): boolean {
  const { allowOnly, denyWithinAllow } = SandboxManager.getFsWriteConfig()
  // 检查路径是否在 allowOnly 中且不在 denyWithinAllow 中
}
```

---

## 7. 安全相关实现细节

### 7.1 Protected Paths

**文件**: `src/utils/permissions/filesystem.ts`

系统定义了多层保护路径，防止 AI 修改关键配置：

**内部可编辑路径**（`checkEditableInternalPath`, `filesystem.ts:1479-1605`）——自动允许编辑：
- 当前会话的计划文件（`isSessionPlanFile`）
- 临时目录（`isScratchpadPath`）
- 模板任务目录（`CLAUDE_JOB_DIR`，`feature('TEMPLATES')` 时）
- Agent 记忆目录（`isAgentMemoryPath`）
- 自动记忆目录（`isAutoMemPath`，无覆盖路径时）
- `.claude/launch.json`（桌面预览配置）

**内部可读路径**（`checkReadableInternalPath`, `filesystem.ts:1611-1777`）——自动允许读取：
- 会话记忆目录（`isSessionMemoryPath`）
- 项目目录（`isProjectDirPath`）
- 计划文件
- 工具结果目录（`getToolResultsDir`）
- 临时目录
- Agent 记忆目录
- 任务目录（`.claude/tasks/`）
- 团队目录（`.claude/teams/`）
- 内置技能参考文件（`getBundledSkillsRoot`）

### 7.2 Hook 系统

**文件**: `src/utils/hooks.ts:4157-4192`

#### PreToolUse Hooks

`executePermissionRequestHooks()` 在权限检查流程中调用，提供用户自定义的拦截逻辑：

```typescript
export async function* executePermissionRequestHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  permissionSuggestions?: PermissionUpdate[],
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  // ...
)
```

Hook 可以返回：
- `{ behavior: 'allow', updatedInput, updatedPermissions }` → 放行（含输入修改和权限更新）
- `{ behavior: 'deny', message, interrupt }` → 拒绝（含可选的中断信号）

使用场景：
- headless/async agent 不能显示权限提示框时通过 hook 授权
- CI/CD 环境中的自动化策略执行

#### PostToolUse Hooks

代码中存在 `PostToolUse` 钩子类型（在 hook 类型定义中），用于工具执行后的审计、日志记录和副作用处理。

### 7.3 远程会话权限桥接

**文件**: `src/utils/permissions/permissionSetup.ts:748-758`

当 `CLAUDE_CODE_REMOTE` 环境变量设置时，运行在远程桥接模式，权限模式受限：

```typescript
if (
  isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
  !['acceptEdits', 'plan', 'default'].includes(settingsMode)
) {
  // 只有 acceptEdits、plan、default 模式支持 CCR
  logEvent('tengu_ccr_unsupported_default_mode_ignored', { mode: settingsMode })
}
```

这意味着在远程会话中，`bypassPermissions` 和 `auto` 模式被禁用，增强了对远程连接的安全控制。

### 7.4 权限解释器

**文件**: `src/utils/permissions/permissionExplainer.ts`

在询问用户时，系统可调用 Haiku 模型生成操作的风险评估：

```typescript
export async function generatePermissionExplanation({
  toolName, toolInput, toolDescription, messages, signal,
}): Promise<PermissionExplanation | null>
```

输出包含：
- `riskLevel`: `LOW` | `MEDIUM` | `HIGH`
- `explanation`: 操作说明（1-2 句话）
- `reasoning`: 执行此操作的原因
- `risk`: 可能的风险（15 字以内）

此功能可通过 `permissionExplainerEnabled` 配置禁用。

### 7.5 权限更新的持久化

**文件**: `src/utils/permissions/PermissionUpdate.ts`, `PermissionUpdateSchema.ts`

权限变更（添加规则、删除规则、更改模式、添加目录）通过 `permissionRuleParser.ts` 进行序列化和反序列化，并写入到对应的设置文件。

```typescript
export type PermissionUpdate =
  | { type: 'addRules'; destination: PermissionUpdateDestination; rules: PermissionRuleValue[]; behavior: PermissionBehavior }
  | { type: 'replaceRules'; destination: ...; rules: ...; behavior: ... }
  | { type: 'removeRules'; destination: ...; rules: ...; behavior: ... }
  | { type: 'setMode'; destination: ...; mode: ExternalPermissionMode }
  | { type: 'addDirectories'; destination: ...; directories: string[] }
  | { type: 'removeDirectories'; destination: ...; directories: string[] }
```

### 7.6 特征标识与死代码消除

整个权限系统大量使用 Bun 编译期的 `feature()` 函数进行条件编译：

| Feature Flag | 控制的特性 | 文件 |
|-------------|-----------|------|
| `TRANSCRIPT_CLASSIFIER` | 整个 auto 模式系统（分类器、状态管理、危险权限剥离） | 多处 |
| `BASH_CLASSIFIER` | Bash 命令提示词分类器 | `bashClassifier.ts` |
| `POWERSHELL_AUTO_MODE` | PowerShell 自动模式 | `yoloClassifier.ts` |
| `TEMPLATES` | 模板任务目录自动编辑 | `filesystem.ts` |

这样，外部构建中所有 auto 模式相关代码被完全消除，减小了二进制体积并简化了安全模型。

### 7.7 拒绝统计与滥用防护

**文件**: `src/utils/permissions/denialTracking.ts`

```typescript
export const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续 3 次拒绝 → 回退到手动
  maxTotal: 20,        // 总计 20 次拒绝 → 回退到手动
} as const
```

拒绝跟踪统计记录在 `AppState.denialTracking` 中，在 auto 模式下每次分类器判定后更新：

- 成功（allow）→ `recordSuccess()` → 重置连续拒绝计数
- 失败（block）→ `recordDenial()` → 递增两个计数器
- 超出阈值 → `shouldFallbackToPrompting()` → 回退到交互式询问

headless agent 模式下，超出限制直接终止 agent（`permissions.ts:1023-1027`）。

### 7.8 CLI 与 Settings 初始化流程

**文件**: `src/utils/permissions/permissionSetup.ts:872-1033`

`initializeToolPermissionContext()` 的完整流程：

1. 解析 `--allowed-tools`, `--disallowed-tools`, `--base-tools` CLI 参数
2. 检测 `bypassPermissions` 模式是否可用（Statsig 门控 + settings 检查）
3. 从磁盘加载所有权限规则（`loadAllPermissionRulesFromDisk`）
4. 检测危险和过宽的 Shell 权限
5. 应用规则到 `ToolPermissionContext`
6. 处理工作目录的符号链接（`process.env.PWD` 与 `getOriginalCwd()` 的差异）
7. 验证并添加附加目录（`--add-dir`）

---

## 附录 A：关键文件索引

| 文件 | 职责 | 关键行 |
|------|------|--------|
| `src/types/permissions.ts` | 权限类型定义 | 16-36 (模式), 54-62 (规则来源), 75-79 (规则), 271-324 (DecisionReason) |
| `src/utils/permissions/PermissionMode.ts` | 权限模式配置与 UI 展示 | 42-91 (模式配置), 97-105 (外部模式过滤) |
| `src/utils/permissions/permissions.ts` | 核心权限检查管道 | 473-956 (hasPermissionsToUseTool), 1158-1319 (hasPermissionsToUseToolInner), 1060-1156 (checkRuleBasedPermissions) |
| `src/utils/permissions/filesystem.ts` | 文件系统权限检查 | 57-68 (危险文件), 74-79 (危险目录), 620-665 (安全检查), 960-1025 (路径匹配), 1479-1605 (内部可编辑路径), 1611-1777 (内部可读路径) |
| `src/utils/permissions/pathValidation.ts` | 路径验证 | 101-123 (沙箱写允许), 141-263 (isPathAllowed), 331-367 (危险删除路径), 373-485 (validatePath) |
| `src/utils/permissions/yoloClassifier.ts` | Auto 模式分类器 | 711-996 (XML 2 阶段分类器), 1012-1306 (classifyYoloAction), 1484-1495 (formatActionForClassifier) |
| `src/utils/permissions/classifierDecision.ts` | 分类器决策与放行列表 | 56-94 (SAFE_YOLO_ALLOWLISTED_TOOLS), 96-100 (isAutoModeAllowlistedTool) |
| `src/utils/permissions/permissionSetup.ts` | 模式切换、危险权限剥离 | 94-147 (isDangerousBashPermission), 157-233 (isDangerousPowerShellPermission), 510-553 (stripDangerousPermissionsForAutoMode), 597-646 (transitionPermissionMode), 872-1033 (initializeToolPermissionContext) |
| `src/utils/permissions/permissionsLoader.ts` | 规则加载与持久化 | 120-133 (loadAllPermissionRulesFromDisk), 229-296 (addPermissionRulesToSettings) |
| `src/utils/permissions/shellRuleMatching.ts` | Shell 规则解析与匹配 | 43-48 (prefix 提取), 90-153 (通配符匹配) |
| `src/utils/permissions/denialTracking.ts` | 拒绝跟踪 | 12-15 (DENIAL_LIMITS), 40-44 (shouldFallbackToPrompting) |
| `src/utils/permissions/shadowedRuleDetection.ts` | 影子规则检测 | 193-234 (detectUnreachableRules) |
| `src/utils/permissions/dangerousPatterns.ts` | 危险命令模式 | 18-42 (CROSS_PLATFORM_CODE_EXEC), 44-80 (DANGEROUS_BASH_PATTERNS) |
| `src/utils/permissions/permissionExplainer.ts` | 权限解释器 | 147-250 (generatePermissionExplanation) |
| `src/hooks/useCanUseTool.tsx` | React 权限 hook | 28-203 (useCanUseTool) |
| `src/utils/sandbox/sandbox-adapter.ts` | 沙箱适配器 | 469-472 (isAutoAllowBashIfSandboxed) |
| `src/utils/hooks.ts` | Hook 执行系统 | 4157-4192 (executePermissionRequestHooks) |
| `src/utils/permissions/bypassPermissionsKillswitch.ts` | 绕过权限禁用开关 | 19-47 (checkAndDisableBypassPermissionsIfNeeded), 74-117 (checkAndDisableAutoModeIfNeeded) |

## 附录 B：数据流图（权限检查）

```
工具调用请求
    │
    ▼
┌──────────────────────────────────────┐
│  hasPermissionsToUseTool()           │
│  src/utils/permissions/permissions.ts│
│                                      │
│  1. 规则预过滤段                       │
│     ├── 全局 deny 规则                │
│     ├── 全局 ask 规则 (sandbox 快速放行)│
│     ├── tool.checkPermissions()       │
│     ├── tool.requiresUserInteraction  │
│     ├── 内容 ask 规则                  │
│     └── 安全检查                       │
│                                      │
│  2. 权限处理段                         │
│     ├── bypassPermissions / plan      │
│     └── 全局 allow 规则                │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  hasPermissionsToUseTool() — 模式后处理│
│                                      │
│  3. dontAsk → ask→deny               │
│  4. Auto 模式:                       │
│     ├─ acceptEdits 快速路径           │
│     ├─ 放行列表                       │
│     └─ YOLO 分类器评估                 │
│  5. Headless → hooks → auto-deny     │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────────────────────┐
│  useCanUseTool (React Hook)          │
│  src/hooks/useCanUseTool.tsx         │
│                                      │
│  allow → 立即执行                     │
│  deny → 拒绝 + 通知                   │
│  ask → 交互式处理                      │
│     ├─ 协调器检查                      │
│     ├─ Swarm Worker 转发              │
│     ├─ 投机性分类器 (Bash)            │
│     └─ 用户确认对话框                  │
└──────────────────────────────────────┘
```

---

## 附录：AskUserQuestion 独立问答通道

`AskUserQuestion` 用于向用户提出多选题（澄清需求、在方案间做选择）。它**不再借道权限系统的 `ask` 流程**，而是走一条独立的问答通道，与权限确认队列解耦。

### 与权限 `ask` 的区别

| 维度 | 权限式 `ask`（早期实现） | 独立问答通道（当前实现） |
|------|----------------------|----------------------|
| `checkPermissions` 返回 | `behavior: 'ask'` | `behavior: 'allow'` |
| 阻塞方式 | 权限回调回填 `answers` | `call` 内 `await questionService.ask(...)` |
| 本地渲染 | 进 `toolUseConfirmQueue`，由 `PermissionRequest` 渲染 | 独立 overlay（`QuestionPrompt`），与 `toolPermissionOverlay` 并列 |
| 焦点协调 | `tool-permission` 对话框 | `question` 对话框 + `useRegisterOverlay('question')` |

### 运行时组件

- **`src/services/question/questionService.ts`** — 独立问答通道。`ask(questions)` 存入 `pending: Map<id, ...>` 并返回 Promise；`reply` / `reject` 解析对应 Promise；通过 EventEmitter 广播 `asked` / `replied` / `rejected`。
- **`src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`** — `call` 内 `await questionService.ask(...)`，再把结果按题映射为 `answers`。
- **`src/components/question/QuestionPrompt.tsx`** — 独立 overlay，复用 `QuestionView` / `SubmitQuestionsView` / `use-multiple-choice-state` 渲染，并用 `useKeybindings`（`Tabs` 上下文）绑定多题切换。
- **`src/screens/REPL.tsx`** — 订阅 `asked` 弹出 overlay；订阅 `replied` / `rejected` 关闭 overlay。

### 桥接 / CCR 远程转发

桥接（`BRIDGE_MODE`）连接时，`asked` 事件会**同时**把问题作为 `can_use_tool` control_request 转发给远程用户（claude.ai），与本地 overlay 竞速：

- 远程 `allow` 且带 `updatedInput.answers` → 按题映射后 `questionService.reply(...)`；通用 `allow`（无 answers）降级为每题选第一个选项。
- 远程 `deny` → `questionService.reject(...)`。
- 任一端先应答，都会清掉本地 overlay 并 `cancelRequest` 另一端的 prompt，避免残留。

> 注：因 `checkPermissions` 现返回 `allow`，AskUserQuestion 不再进入 `handleInteractivePermission`，故不会与桥接路径重复转发。

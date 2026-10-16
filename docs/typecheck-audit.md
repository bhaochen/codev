# TypeScript 类型错误审计与分批修复计划

> 状态：审计完成（2026-10-16）。本文档是修复工作的基线记录与分批计划；每完成一批，
> 在文末「进度」表更新并附对应提交号。目标：`tsc --noEmit -p tsconfig.json` 达到 0 errors，
> 且不引入 `any` / `@ts-ignore` / 排除目录 / 关闭检查。

## 0. 复现方式

```
bunx tsc --noEmit -p tsconfig.json        # TypeScript 6.0.3, bun 1.4.2
```

环境事实：`tsconfig.json` 当前 `"strict": false`、`"verbatimModuleSyntax": true`、`"target": "ESNext"`。
即这 131 个错误全部是在**非严格模式**下仍然暴露的**无歧义错误**（模块解析、重复声明、不可达分支、
明显的属性缺失等），不涉及 strict 系列的噪音。是否开启 `strict` 是独立决策，不在本计划内。

## 1. 基线对照（第 2 项要求）

- 基线：`34ced38e`（本次会话首个提交 `9504657c` 之前的 HEAD），在独立 worktree 中以同一
  TypeScript 6.0.3 运行同一命令。
- 对比方法：将两边输出按 `文件 + 错误码 + 消息` 归一化（剥离行列号）后做集合差。

| 集合 | 数量 |
|---|---|
| HEAD (18e658d0) | 131 |
| 基线 (34ced38e) | 131 |
| 两侧完全相同（逐条 file+code+message） | **131** |
| HEAD 新增 | **0** |
| 基线有而 HEAD 已消失 | **0** |

**结论：131 个错误全部为既有错误；配置路径修复、voice key 修复与 Jina 死代码清理未引入任何新错误，
也未掩盖任何旧错误。** 与此前"131 个"的汇总数字一致，但本次是逐条比对而非计数比对。

## 2. 分簇根因分析（第 3 项要求）

共 131 个错误、20 种错误码、约 20 个文件，按根因分 5 簇。每簇标注活性（是否在运行图中）。

### 簇 A — browser 模块（73 个：services/browser 68 + tools/BrowserTool 5）

BrowserTool 经 `tools.ts:121` 的 `feature('WEB_BROWSER_TOOL')` 接入，**在默认构建中是活代码**；
例外：`wire.ts` 全仓无 import 方（死代码），`QuotaManager` 式的"库代码"见各条。

| # | 文件 | 错误 | 数量 | 根因 | 性质 | 修复策略 |
|---|------|------|------|------|------|----------|
| A1 | `wire.ts` | TS2307 | 7 | 相对导入路径错误：`../execFileNoThrow.js` / `../sleep.js` 实际位于 `src/utils/`，应为 `../../utils/…`。该文件若被 import 将直接模块解析失败 | 潜在运行时 bug（当前死代码） | 修正路径（`computerUse/__tests__` 同类错误一并修） |
| A2 | `wire.ts` | TS1117 | 11 | `KEY_CODES` 字面量中 Home/End/PageUp/PageDown/Up/Down/Left/Right/Insert/Tab/BackSpace 整块**逐字重复**（两次键值完全相同） | 数据重复，零行为差异 | 删除重复块 |
| A3 | `wire.ts` | TS2300 | 2 | 同名冲突：私有字段 `onNamedSeat`（109 行）与 getter `onNamedSeat`（148 行） | 声明冲突 | 字段改名（如 `namedSeat`），getter 保持对外名 |
| A4 | `watchdog.ts` | TS2300 ×2 + TS2717 ×1 | 3 | `dialog:opened` 事件成员把判别字段 `type: "dialog:opened"` 与载荷字段 `type: string` 写重 | 事件建模错误 | 载荷字段改名 `dialogType`（全仓无消费者读取旧名，已核实） |
| A5 | `watchdog.ts` | TS2339 | 1 | `BaseWatchdog.detach()` 调 `this.removeAllListeners()`，但基类不是 EventEmitter | API 误用 | 改为清理自身总线/监听器的显式方法 |
| A6 | watchdogs ×5 + BrowserTool | TS2341 | 20 | watchdog 与 BrowserTool 访问 `BrowserSessionService` 的 **private** `client`(15)/`waitForSettle`(3)/`activeTargetId`(1)/`evaluate`(1)；`getActiveTab` 方法不存在(TS2339 ×1) | 接口漂移：watchdog 按更宽的 API 编写 | 为确需跨类访问的成员提供显式公开访问器（最小面），或调整归属；逐个评估，不加 `// @ts-` |
| A7 | `storageWatchdog.ts` | TS2339 | 10 | CDP 响应按 `unknown`/`{}` 使用（`frameTree`/`cookies`/`result`/`executionContextId`） | 类型缺失 | 为用到的 CDP 载荷定义最小类型并收窄 |
| A8 | `securityWatchdog.ts` | TS2345 | 2 | `RegExp[]` 传入 `string[]` 形参 | 签名不匹配 | 以调用点真实意图为准统一签名 |
| A9 | 7 个文件 | TS1484/TS1485 | 16 | `verbatimModuleSyntax` 要求 type-only import（`WatchdogEvent`/`WatchdogConfig`/`BrowserSessionService`/`ContextArchive`） | 机械性 | 改 `import type` / 内联 `type` 修饰符 |

### 簇 B — utils/model：kiro 接口漂移（23 个）

| # | 文件 | 错误 | 数量 | 根因 | 修复策略 |
|---|------|------|------|------|----------|
| B1 | `configs.ts` | TS2741 + TS1360 | 22 | `APIProvider` 新增 `'kiro'`（providers.ts:16）后，`ModelConfig = Record<Exclude<APIProvider, 'openai'\|'opencode'\|'openrouter'\|'nvidia'\|'local'>, ModelName>` 自动要求每条模型配置带 `kiro` 键；11 条静态配置均未提供 | 把 `'kiro'` 加入 `ModelConfig` 的 Exclude 列表。理由：Kiro 的模型 ID 来自 CodeWhisperer `ListAvailableModels` **运行时目录**（kiroModels.ts 动态拉取缓存），与 openai/opencode/nvidia 一样没有静态 per-Claude-model ID；且全仓**无任何代码读取 `config.kiro`**（已核实）。补写静态 ID 反而要凭空造数据 |
| B2 | `contextWindowStore.ts` + `kiroModels.ts` | TS2345 | 1 | `kiroModels.ts:93` 调 `recordProviderContextWindows('kiro', …)`，但 `CatalogProvider = 'openrouter'\|'opencode'\|'nvidia'` 未随之扩展（**真实消费者**） | `CatalogProvider` 增加 `'kiro'`（`providers` 存储本就是 `Partial<Record<…>>`，兼容） |

### 簇 C — LLM runtime / usage / rtk / protocols（20 个）

| # | 文件 | 错误 | 数量 | 根因 | 性质 | 修复策略 |
|---|------|------|------|------|------|----------|
| C1 | `usage/QuotaManager.ts` | TS2339 | 6 | 字段声明为 `private usage = new Map(…)`，方法体全部访问 `this.used`（`used.get/set` ×6 处）——**一旦被调用即 TypeError** | **真运行时炸弹**（当前无调用方，`UsageTracker` 仅注释提及） | 统一命名（读全文件后定为 `usage` 或 `used`），补最小单测锁行为 |
| C2 | `runtime/ComboEngine.ts` | TS2678 ×4 + TS2322/TS2345 ×2 | 6 | switch 判别 `"tool_use"/"tool_result"/"thinking"/"text"` 不在 `AgentStreamEvent["type"]` 联合中；`SystemAPIErrorMessage \| AssistantMessage` 传给 `AgentStreamEvent` 形参 | 事件联合建模与实现脱节（该文件当前无外部 import 方） | 按运行时真实事件流扩展联合或收敛实现；需要读 SDK 事件源后定案 |
| C3 | `runtime/ComboEngine.test.ts` | TS2741 + TS2353 | 2 | 测试夹具缺 `hasAppendSystemPrompt`、`content` 字段与 `LLMRuntimeContext`/`SystemPrompt` 类型漂移 | 测试漂移 | 修夹具 |
| C4 | `rtk/RTKIntegration.ts` + `filters/index.ts` | TS2339 | 5 | 局部 `Message` 类型缺 `message` 字段（`message.message?.content`）；`unknown` 上调 `.includes` | 类型缺失（**活代码**：sessionStorage 动态导入） | 补类型/收窄 |
| C5 | `protocols/awsEventStream/index.ts` | TS2322 | 1 | `Uint8Array<ArrayBufferLike>` 赋给 `Uint8Array<ArrayBuffer>`（TS 5.7+ 类型化 ArrayBuffer 泛型与 AWS SDK Smithy 类型交集） | 依赖类型定义摩擦 | 用类型安全的缓冲构造（如 `new Uint8Array(view)` 复制）或与 SDK 类型对齐的泛型标注；不改运行行为 |

### 簇 D — utils/computerUse（13 个，活代码：query.ts / stopHooks / cli.tsx 动态导入）

| # | 文件 | 错误 | 数量 | 根因 | 性质 | 修复策略 |
|---|------|------|------|------|------|----------|
| D1 | `linuxExecutor.ts:41` | TS2304 | 1 | `releaseHeldButton()`（SIGTERM 清理）调用**未定义**的 `ydotool([...])` | **真运行时炸弹**：按钮被按住时收到 SIGTERM → ReferenceError | 改为该文件既有的 `execFileNoThrow('ydotool', …)` 调用形式 |
| D2 | `linuxExecutor.ts:635` | TS2367 | 1 | `isWayland()`：`!!env.XDG_SESSION_TYPE === 'wayland'` —— 取反后与字符串比较，恒为 false（运算符优先级） | **真逻辑 bug** | `!!env.WAYLAND_DISPLAY \|\| env.XDG_SESSION_TYPE === 'wayland'` |
| D3 | `linuxExecutor.ts:509` | TS2300 | 1 | `getActiveWindow` 重复声明（426 行对象成员与 509 行再声明） | 声明冲突 | 读上下文后去重 |
| D4 | `linuxExecutor.ts:17` | TS2305 | 1 | 从 `utils/execFileNoThrow` 导入不存在的 `execFile` | 导入错误 | `node:child_process` 导入或补导出（按文件内实际用法） |
| D5 | `linuxHostAdapter.ts` | TS1308 + TS2739 | 2 | 非 async 函数中 `await`；`CuSubGates` 字面量缺 `pixelValidation`/`clipboardPasteMultiline` | 真实缺陷 ×2 | 补 async/补字段（取调用方默认值） |
| D6 | `__tests__/linuxExecutor.test.ts` | TS2307 + TS2459 ×2 + TS2339 ×4 | 7 | 同 A1 的错路径；导入未导出的 `setHeldButton`/`getHeldButton`；`unknown` 上取属性 | 测试漂移 | 修路径；导出这两个内部函数或改走公共 API；为探测结果定类型 |

### 簇 E — utils/auth.ts（2 个）

`bun:sqlite` 的 `.get()` 返回 `unknown`（新版类型定义），`row?.value` 直接取属性。仓库已有
`workflows/store.ts` 的类型化用法可循。TS2339 ×2。

## 3. 分批修复计划（第 5 项要求）

原则：真实类型安全/逻辑缺陷优先；每批独立提交、独立可回滚；每批完成后跑
`bun test`（相关文件）、全量 `bunx tsc --noEmit`、`bun run build`；不使用
`any` / `@ts-ignore` / `strict:false` 之外的降级 / tsconfig `exclude`。

| 批次 | 内容 | 错误数 | 主要风险 | 提交信息（拟） |
|------|------|--------|----------|----------------|
| 1 | 运行时/解析级真 bug：C1 QuotaManager、D1 ydotool、D2 isWayland、D5 linuxHostAdapter、A1+D6(2307 部分) 导入路径 | 19 | QuotaManager 命名统一需读全文件定案；`isWayland` 修正是行为变化（原恒 false → 按语义生效），需在提交信息中明示 | `fix: typecheck batch 1 — runtime-breaking defects surfaced by tsc` |
| 2 | kiro 接口漂移：B1 ModelConfig Exclude、B2 CatalogProvider | 23 | 低；纯类型层对齐动态目录现实 | `fix(model): align ModelConfig/CatalogProvider with the kiro provider` |
| 3 | browser wire.ts：A2 重复键块、A3 字段/getter 重名 | 13 | 低（死代码，键值相同的重复块） | `fix(browser): dedupe wire.ts key table and onNamedSeat declaration` |
| 4 | verbatimModuleSyntax：A9 type-only import | 16 | 零运行时差异 | `fix(types): type-only imports for verbatimModuleSyntax` |
| 5 | browser 剩余：A4-A8（private 访问面、CDP 载荷类型、RegExp 签名、dialog 事件建模、removeAllListeners） | 37 | 最高：涉及 BrowserSessionService 公开面设计与 CDP 类型定义；可能需要拆成 5a/5b 两批 | `fix(browser): watchdogs access typed session surface`（拆分则 a/b） |
| 6 | 其余：C2-C5、E、D3/D4/D6 剩余 | 23 | ComboEngine 事件联合建模需读 SDK 事件源；awsEventStream 涉及依赖类型交集 | `fix: typecheck batch 6 — llm/rtk/auth/computerUse residuals` |

合计 19+23+13+16+37+23 = **131**。

第三方/生成代码说明（第 7 项）：本次 131 个错误中**没有**需要"放弃修复"的第三方或生成代码问题；
最接近的是 C5（AWS Smithy 的 `Uint8Array` 泛型交集）与 D6/E（bun:sqlite 的 `unknown` 返回），
两者都可在不改运行行为的前提下类型安全地解决。若后续开启 `strict`，将另立审计（数量级会显著上升）。

## 4. 进度

| 批次 | 状态 | 提交 | 剩余错误 |
|------|------|------|----------|
| 审计 | ✅ | 本文档 | 131 |
| 1 | ⬜ | | |
| 2 | ⬜ | | |
| 3 | ⬜ | | |
| 4 | ⬜ | | |
| 5 | ⬜ | | |
| 6 | ⬜ | | |

## 附录：基线与 HEAD 的完整错误清单（131 行，两者逐条一致）

清单由 `bunx tsc --noEmit -p tsconfig.json`（TypeScript 6.0.3）在 `34ced38e` 与 `18e658d0`
各运行一次，归一化后比对为同一集合。完整原始输出留存于本次审计记录，格式：

```
src/<file>(line,col): error TSxxxx: <message>
```

（详见提交时的验证输出；逐文件×错误码分布见第 2 节各表。）

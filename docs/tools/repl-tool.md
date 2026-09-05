# REPL Tool — VM 沙箱批量执行引擎

> 让模型从"每步一次工具调用"升级为"一段代码批量完成多步操作"。
> REPL 是一个运行在 Bun `node:vm` 沙箱中的 JavaScript 执行环境，
> 通过 `callTool()` 直接调用 primitive tools（Read/Write/Edit/Glob/Grep/Bash）。
>
> 相关源码：
> - `src/tools/REPLTool/engine.ts` — VM 执行引擎
> - `src/tools/REPLTool/REPLTool.ts` — 工具定义
> - `src/tools/REPLTool/primitiveTools.ts` — primitive 工具集
> - `src/tools/REPLTool/constants.ts` — 启用开关（默认开；`/config` 的 `replEnabled` 字段；环境变量 `CODEV_REPL` / `CLAUDE_CODE_REPL` 优先级最高，`=0` 关、`=1` 开）
> - `src/tools/REPLTool/__tests__/engine.test.ts` — VM 引擎测试
> - `src/tools/REPLTool/__tests__/replToggle.test.ts` — 开关回归测试（6 用例）
>
> 注册方式：`REPLTool` 不在模块 import 阶段静态注册，而由 `src/tools.ts:getReplTool()` 在每次工具装配时按当前 `isReplModeEnabled()` 运行时解析（lazy require），结果与 import 顺序无关；`getTools()` 另有 defense-in-depth 不变量兜底（见 §3.7）。

---

## 1. 为什么需要 REPL？

传统模式下模型做批量操作（如重命名 20 个文件）需要 20 次独立工具调用，
每次都有完整的 round-trip：模型生成 → API 传输 → 权限检查 → 执行 → 结果回传。

```
传统: [调用 Glob] → [调用 Read] → [调用 Edit] → [调用 Edit] → ...   N 次 round-trip
REPL: [一段 JS 代码] → for 循环内 await callTool(...)              1 次 round-trip
```

更深层价值：**把模型从"推理者"变成"程序员"**。

| | 推理计算 | REPL 计算 |
|---|---------|----------|
| `typeof x`、`1+1`、字符串处理 | 靠 token 概率"猜"，可能错 | 引擎精确执行，必对 |
| 批量文件操作 | N 次调用，N 倍延迟 | 循环 + 变量，单次完成 |
| 中间状态 | 全部塞进上下文 | 留在 VM 里，不占 token |

---

## 2. 架构

```
┌─────────────────────────────────────────────────┐
│ LLM 发出 REPL tool_use { code: "..." }           │
│      │                                          │
│      ▼                                          │
│ REPLTool.call() ── engineCache.get(sessionId)   │
│      │                                          │
│      ▼                                          │
│ ReplEngine.execute(code)                        │
│   ├─ hasTopLevelAwait? ── sync / async 双路径    │
│   ├─ new Script(code).runInContext(vm)          │
│   │      │                                      │
│   │      ▼  VM 内部                              │
│   │   callTool("Glob", {...})                   │
│   │      ├─ findToolByName (大小写不敏感回退)       │
│   │      ├─ inputSchema.safeParse               │
│   │      ├─ tool.call(parsed, ctx, allowAll)    │
│   │      ├─ ToolResult 统一事实模型                 │
│   │      └─ isVirtual innerMessages → UI/history  │
│   ├─ console.log/error/warn → output 缓冲        │
│   ├─ ContextAggregator → ContextResult 聚合       │
│   └─ return { result: JSON(ContextResult),       │
│              toolCalls, innerMessages, output }  │
│                                                 │
│ isTransparentWrapper=true                       │
│ → UI 只显示内部 tool 调用，不显示 REPL 本身          │
│ → innerMessages (isVirtual:true) 仅 UI/history,  │
│   不进 LLM API (normalizeMessagesForAPI 过滤)     │
│ → ContextResult 唯一进 LLM API                  │
└─────────────────────────────────────────────────┘
```

---

## 3. 关键实现细节

### 3.1 Sync / Async 双路径执行（Bun node:vm 的坑）

Bun 的 `node:vm` 有个特性：**async 函数内的 `var` 声明不会持久化到 context**
（因为代码跑在 async wrapper 的函数作用域里）。而 REPL 的核心诉求恰恰是
跨调用变量持久化：

```js
// 第一次调用
var files = await callTool("Glob", { pattern: "src/**/*.ts" })
// 第二次调用 — files 还在吗？
console.log(files.length)
```

解法：检测代码是否含 top-level `await`，走两条不同路径：

- **同步路径**（无 top-level await）：直接 `script.runInContext()`，
  `var` 自然持久化到 context。表达式返回值也捕获进输出（如 `typeof x`）。
- **异步路径**：`(async () => { code })()` 包装支持 await；
  事后用正则提取 `var` 名称手动注入 context（值尽力而为）。

```typescript
if (ReplEngine.hasTopLevelAwait(code)) {
  await this.executeAsync(code, timeoutMs)   // async IIFE 包装
} else {
  this.executeSync(code, timeoutMs)          // var 持久化
}
```

`hasTopLevelAwait` 先剥离字符串/模板串/注释再匹配 `\bawait\s`，
避免把 `'await foo'` 字符串误判为异步代码。

### 3.2 Proxy 沙箱安全

VM context 只绑定白名单全局（JSON/Math/Date/Array/Promise/Error 等 30+ 个），
再用 Proxy 拦截危险标识符：

```typescript
const BLOCKED_GLOBALS = new Set(['eval','Function','import','process','require','globalThis'])

const proxyHandler = {
  get(target, prop) {
    if (typeof prop === 'string' && BLOCKED_GLOBALS.has(prop)) {
      throw new ReferenceError(`${prop} is not allowed in sandbox`)
    }
    return Reflect.get(target, prop, receiver)
  },
}

createContext(new Proxy(sandbox, proxyHandler), {
  name: 'repl-sandbox',
  codeGeneration: { strings: false, wasm: false },  // 禁 new Function / WebAssembly
})
```

三层防御：
1. 白名单注入 — 未列出的全局不存在
2. Proxy get 拦截 — 显式黑名单抛 ReferenceError
3. `codeGeneration.strings: false` — 从根上禁掉 `new Function` 动态编译

### 3.3 callTool — primitive 工具桥接

```typescript
async callTool(toolName: string, input): Promise<CallToolResult>
// CallToolResult = { data: string; toolName: string; isError: boolean }
```

流程：

1. **查找**：`findToolByName()` 精确匹配 → 失败则全表大小写不敏感回退
   （LLM 常写 `"glob"` 而工具名是 `"Glob"`）
2. **校验**：`inputSchema.safeParse(input)`，失败返回结构化错误文本
3. **构造 synthetic assistant message**（tool_use block），传入真实 ToolUseContext
4. **执行**：`tool.call(parsed.data, {...ctx, toolUseId}, canUseToolAllowAll, syntheticAssistant)`
5. **结果序列化**（关键修复）：按类型正确处理 —

```typescript
const resultText =
  typeof result === 'object' && result !== null && 'data' in result
    ? (typeof result.data === 'string'
        ? result.data                              // string 直接用
        : JSON.stringify(result.data, null, 2))    // 对象 JSON 化
    : typeof result === 'string'
      ? result
      : JSON.stringify(result, null, 2)
```

早期版本用 `String(result.data)` 导致所有对象变成 `[object Object]` —
这是 LLM 无法读到 Glob 结果的直接原因。

6. **virtual messages**：每次内部调用产生一对 `isVirtual: true` 的
   assistant(tool_use) + user(tool_result) 消息，推入 `innerMessages`
   随 REPL 结果返回，注入对话历史供后续 turn 引用。

### 3.4 会话级引擎缓存与透明包装

```typescript
// 同一会话内 VM 上下文持久化，变量跨 turn 保留
const engineCache = new Map<string, ReplEngine>()
```

两个 UI 层配合：

- `isTransparentWrapper(): true` — REPL 自己的 tool_use 不单独渲染，
  进度回调把内部每次 callTool 以 `repl_tool_call` 进度消息透出
- 内部工具的权限全部自动放行（`canUseToolAllowAll`）— primitive 工具本身
  已经过注册期筛选，且 REPL 整体仍受外层权限系统管控

### 3.5 统一事实模型与上下文聚合（REPL Tool Result Contract）

**问题**：`innerMessages (isVirtual:true)` 在 `utils/messages.ts:1999 normalizeMessagesForAPI` 被过滤，不进 LLM API；若模型未 `console.log(r.data)` 则 `engine.ts:131 "(no output)"` 使 `gh auth status` 这类空 `stdout` 成功被误判为不可用，而 `Read` 全量 `console.log` 又致上下文臃肿。

**三层解耦**：

```text
Tool → ToolResult → ExecutionStore(innerMessages, isVirtual, UI/history)
                → ContextAggregator → ContextResult → LLM API
```

```ts
// src/tools/REPLTool/engine.ts
type ToolResult = {
  tool: string; ok: boolean; isError: boolean;
  exitCode?: number; stdout?: string; stderr?: string;
  data?: unknown; truncated?: boolean;
  noOutputExpected?: boolean; outputPath?: string; error?: string;
}
type ContextCall = {
  tool: string; ok: boolean; exitCode?: number;
  summary?: string; preview?: string;
  truncated?: boolean; outputPath?: string;
  noOutputExpected?: boolean; error?: string;
}
type ContextResult = {
  ok: boolean; tool_calls: number;
  calls: ContextCall[]; logs?: string; error?: string;
}
```

- `ToolResult` 统一 `Bash{stdout,stderr,exitCode,noOutputExpected,persistedOutputPath}` 与 `Read/Glob/Grep{data}`；
- `ExecutionStore` 仍产生 `isVirtual` 的 `assistant(tool_use)+user(tool_result)` 供 `collapse`/`audit`，但不再假设进模型上下文；
- `ContextAggregator.buildContextResult()` 将每个 `ToolResult` 转 `ContextCall`：`Bash` 合并 `stdout+stderr` 截断 `4000` 字符、`mkdir` 标 `summary="no output expected"`，`Read` 取 `data` 的 `JSON.stringify` 预览 `head 2000+tail 500`、`truncated=true`，超大走 `outputPath` 按需二次 `Read`；
- `execute()` 有工具调用时返回 `JSON.stringify(ContextResult)` 而非 `output||"(no output)"`，`toolCalls==0` 的纯 JS 仍保持原 `output` 行为以兼容 `1+1`/`console.log` 测试；
- **不变量**：`callTool()成功 → ToolResult必捕获 → ContextAggregator决定暴露`，`console.log` 降为可选的额外 `logs` 字段，不再决定结果可见性。

### 3.6 REPL ≠ SubAgent（批量执行器 vs 另一个 Agent）

一句话：**REPL 不是 subagent，只是主 Agent 调用的批量工具执行器；REPL 自己执行多个工具并在内部聚合后把结果返回给主 Agent，无二次 LLM 调用。**

```text
主 Agent ──调用 REPL──▶ REPL { Read, Grep, Bash, Edit } ──ContextAggregator──▶ REPL Result(JSON) ──▶ 主 Agent
  无 SubAgent。isVirtual 的 innerMessages 仅 UI/history，真正进 LLM 的只有 ContextResult。
```

对比 `AgentTool/task` 的 `主 Agent → SubAgent → (SubAgent 内再调 REPL) → 汇总回主 Agent` 独立会话；普通 `Read/Grep` 批量走 `REPL` 即可。`ContextAggregator` 为纯程序聚合，不消耗额外模型调用。

### 3.7 开关与工具注册（toggle correctness）

`isReplModeEnabled()`（`constants.ts`）在 `enableConfigs()` 之前不可读配置（此时恒返 `true`），因此 `REPLTool` 绝不能在模块顶层按开关静态初始化——否则 `replEnabled=false` 也会被冻结进工具池。当前实现：

- `getAllBaseTools()` / `getTools()` / `assembleToolPool({ forAgent })` 每次都经 `getReplTool()` 运行时决议是否注册 `REPL`；
- `getTools()` 出口强制不变量：关闭 → `REPL` 必不存在、原语（`REPL_ONLY_TOOLS`）可直接调用；开启 → `REPL` 存在（若未被 deny-rule 剔除）、原语从直接调用隐藏（仍可在 VM 内 `callTool`）；
- `/config` 切换下次工具装配（下一轮对话）生效；提示词分支（`prompts.ts:getUsingYourToolsSection`）同步切换。

---

## 4. 与投机执行的联动

REPL 是 spec-ptc Layer 3（Shadow Execution）的目标宿主：
流式输出 REPL 代码时，可以在语句边界 fork 影子 VM 提前执行已完整的语句。
当前已落地的是 Layer 1/2（见 [speculative-execution.md](../architecture/speculative-execution.md)）。

另外 REPL 天然减少投机需求 — 一段代码内的多次 callTool 本来就是顺序执行的，
不再需要逐次等待模型生成下一个 tool_use block。

---

## 5. 测试覆盖

`src/tools/REPLTool/__tests__/engine.test.ts`（VM 引擎行为）：

- 基本算术/表达式执行（含返回值捕获）
- console.log/error/warn 输出捕获
- callTool 调用 mock 工具
- 跨调用变量持久化（sync 路径核心保障）
- 死循环超时保护
- eval/import/process 等沙箱禁止项
- 大小写不敏感工具查找
- tool_calls 计数

`src/tools/REPLTool/__tests__/replToggle.test.ts`（开关正确性，6 用例）：

- `replEnabled=false` → 无 `REPL`，原语可直接调用；`true` → 有 `REPL`，原语隐藏
- `CODEV_REPL=0/1` 覆盖配置文件开关
- `assembleToolPool({ forAgent: true })` 跟随开关
- 该文件静态 import `tools.ts`（static-first 顺序），冻结回归会直接失败

---

## 6. 已知限制

| 限制 | 原因 |
|------|------|
| async 代码中 `let/const` 不持久化 | Bun node:vm 函数作用域问题，仅 `var` 尽力恢复 |
| 解构声明不支持 (`var {a,b} = obj`) | 正则提取 var 名的已知盲区 |
| 无 setTimeout/setInterval | 事件循环归属宿主，VM 内未提供 |
| require()/import() 被禁 | 沙箱设计目标，非缺陷 |

---

## 7. 面试视角

**Q: 为什么用 node:vm 而不是 worker/子进程？**
同进程零拷贝共享 toolUseContext，callTool 直接函数调用；worker 需要序列化
context 或 IPC。且 node:vm 的 timeout 参数提供同步死循环保护，worker 反而麻烦。

**Q: 这个沙箱安全吗？**
它是"防呆"级别而非安全边界级：node:vm 官方文档明确不保证隔离。
真正的防线是：(1) 能进 REPL 的 primitive 工具集合可控；(2) 外层权限系统
仍然管控 REPL 整体调用；(3) codegen 关闭堵住逃逸的主要路径。若要硬隔离应换
isolated-vm 或独立进程。

**Q: 为什么不直接让模型多调几次工具？**
成本与延迟都是 N 倍；且中间状态污染上下文。REPL 把控制流交给引擎，
模型只描述"做什么"，符合"代码即最精确的意图表达"的理念。

**Q: 为什么 `innerMessages(isVirtual:true)` 不直接进 LLM，而要 ContextAggregator？**
`normalizeMessagesForAPI`（`src/utils/messages.ts:1999`）过滤 `isVirtual`，且 `engine.ts:131` 旧 `output||"(no output)"` 会使 `gh auth status` 这类空 `stdout` 成功被误判为失败、`Read` 全量又致上下文臃肿。三层解耦后 `ToolResult` 为统一事实，`isVirtual` 仅 UI/history/audit 可视，真正进 LLM 的只有 `ContextResult` 的 `preview/summary/truncated/outputPath` 聚合，不变量 `callTool成功→ToolResult必捕获→ContextAggregator决定暴露`。

**Q: ToolResult vs ContextCall/ContextResult 的分工？**
`ToolResult`（`src/tools/REPLTool/engine.ts:35`）保留完整 `stdout/stderr/data/outputPath` 供本地/回放；`ContextCall` 为进 LLM 的精简视图（`preview` 4000 截断、`head2000+tail500`、`summary="no output expected"`、`truncated/outputPath`），`ContextResult` 再聚合 `ok/tool_calls/calls/logs/error`，控制 token 成本与可二次 `Read` 的按需加载。

**Q: REPL 与 SubAgent 的边界？**
REPL 是主 Agent 的**批量工具执行器**（`主 Agent→REPL{Read,Grep,Bash}→ContextResult→主 Agent`，无二次 LLM）；SubAgent（`AgentTool/task`）是独立会话另起 LLM 调用。普通批量 `Read/Grep/Bash` 走 REPL 即可，需独立推理/探索再用 SubAgent；`ContextAggregator` 为纯程序聚合，不耗额外模型调用。

**Q: P6.6 后 `toolCalls==0` 的纯 JS 如何处理？**
保持原 `output||"(no output)"` 行为（兼容 `1+1`/`console.log` 测试），仅 `toolCalls>0` 时才产出 `JSON(ContextResult)`，避免无工具调用的计算被 JSON 包裹污染。

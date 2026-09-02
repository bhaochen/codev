# 投机工具执行（spec-ptc）架构

> 灵感来源：`~/Code/Agent/spec-ptc` 原型项目。核心思想是"提前下注"—— 在模型还在流式输出时，
> 就猜测接下来会调用哪些只读工具并提前执行，等真正的 tool_use block 到达时直接领取缓存结果。
>
> 相关源码：
> - `src/services/tools/speculation.ts` — 核心数据结构
> - `src/services/tools/StreamingSpecDispatcher.ts` — 流式层投机 dispatch
> - `src/services/tools/StreamingToolExecutor.ts` — claim 集成点
> - `src/services/llm/clients/anthropicMessages.ts` — streaming loop hooks（经 `src/services/api/queryModel.ts:17` Facade）

---

## 1. 为什么需要投机执行？

Agent 循环的延迟构成：

```
用户感知总延迟 = LLM 流式输出时间 + 工具执行时间
                                  ↑
                    这部分在模型输出完 tool_use 之前完全串行
```

典型场景：模型要连续调用 3 个 Glob/Grep 搜索。传统流程：

```
[输出 tool_use #1] → [等待] → [执行 #1 (200ms)] → [输出 #2] → [等待] → [执行 #2] → ...
```

投机执行把"等待+执行"并行化：

```
[输出 tool_use #1 ...#2 ...#3]
      │ JSON 完整即触发
      ├──→ 投机执行 #1 ──┐
      ├──→ 投机执行 #2 ──┼── 结果已在 SpecStore 中
      └──→ 投机执行 #3 ──┘
[content_block_stop] → addTool() → claim() 命中 → 直接 yield 缓存结果（0ms）
```

---

## 2. 三层架构总览

| 层 | 组件 | 状态 | 职责 |
|----|------|------|------|
| Layer 1 | `SpecStore` / `BudgetTracker` / `SpecValue` | ✅ 已实现 | 数据结构与预算控制 |
| Layer 2 | `StreamingSpecDispatcher` | ✅ 已实现 | 流式 token 中检测完整 JSON 并投机 dispatch |
| Layer 3 | Shadow Execution（fork VM 提前跑 REPL 代码） | ❌ 未实现 | 对应原型 shadow.py |

---

## 3. Layer 1 — 核心数据结构（`speculation.ts`）

### SpecKey — 调用指纹

```typescript
type SpecKey = { toolName: string; argsHash: string }

function specKey(toolName: string, input: unknown): SpecKey {
  const raw = JSON.stringify(input ?? {})
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  return { toolName, argsHash: hash }
}
```

- `(toolName, argsHash)` 唯一标识一次工具调用
- argsHash 取 sha256 前 16 hex 字符 — 足够去重，避免长 key
- 相同输入 → 相同 key → 可命中缓存；不同输入 → 不同 key → 不误伤

### Speculation 状态机

```
pending → running → ready → claimed    （正常路径：dispatch 后被领走）
                  ↘ failed             （执行抛错）
                  ↘ evicted            （bet retraction / turn 结束清理）
```

```typescript
type SpecState = 'pending' | 'running' | 'ready' | 'claimed' | 'evicted' | 'failed'
```

### SpecStore — FIFO 领取仓库

关键设计点：

1. **多重度安全**：`Map<string, Speculation[]>`，同一 key 的 N 次相同调用产生 N 个条目，
   每次只能被 claim 一次 — 避免"两个相同调用共享同一个结果条目"的竞态。
2. **FIFO claim**：按入队顺序找第一个 `ready` 的条目领走。
3. **evict（撤注）**：turn 边界或 key 失效时批量标记 `evicted`。

```typescript
claim(key): SpecValue | null   // 命中返回 SpecValue，未命中 null
dispatch(key, promise)         // 注册新的投机执行
evict(key): number             // 撤销所有 in-flight 的该 key 下注
clear()                        // turn 边界全清
stats                          // { dispatched, claimed, evicted, failed, inflight }
```

### SpecValue — 惰性结果代理

包装 speculation promise，`force()` 时若已 resolve 立即返回，否则 await。

### NonSpeculated — 反模式哨兵

原型的防御性设计：一个任何读取都会抛 `AbortSpeculationError` 的不透明代理，
用于标记"这个值不能被投机使用"，一旦下游误用立即失败而非静默产出错误结果。
codev 移植版保留了类定义，当前路径未启用。

### BudgetTracker — 投机预算

```typescript
const DEFAULT_BUDGET = {
  maxInflight: 5,           // 同时 in-flight 的投机调用上限
  maxDispatchesPerTurn: 20, // 每 turn 总 dispatch 次数硬上限
}
```

防止失控：如果模型的输出触发大量投机（如循环生成相似调用），预算封顶后不再 dispatch。

### isSpeculatable — 准入条件

```typescript
export function isSpeculatable(tool): boolean {
  return tool.speculatable === true && tool.pure === true
}
```

只有同时声明 `speculatable: true` **且** `pure: true` 的工具才可投机。
`pure`（无副作用）是硬性要求 — 投机执行的调用可能永远不会被"正式"使用，
有副作用的工具（Write/Bash）投机执行会造成不可逆的意外操作。

---

## 4. Layer 2 — 流式投机 Dispatch（`StreamingSpecDispatcher.ts`）

### ToolBlockTracker — 增量 JSON 完整性检测

LLM 以 `input_json_delta` 分片流出 tool input。问题：何时知道 JSON 已经完整？

答案：**增量 brace-depth 扫描**，每个 delta 只扫描新增字符：

```typescript
feed(delta: string): boolean {
  // 从 prevLen 开始扫描新增部分，维护:
  // - depth: {} / [] 嵌套深度（字符串外才计数）
  // - inString: 是否在 "..." 内（跨 delta 的字符串）
  // - escaped: 上个字符是否为转义符
  if (this.depth <= 0 && this.inputJson.length > 0) {
    this.done = true
    return true   // 顶层对象闭合 → input 完整
  }
}
```

三个易错边界都处理了：

| 边界 | 处理 |
|------|------|
| 字符串内的 `{ } " \` | `inString` 为 true 时跳过 depth 计数 |
| 跨 delta 的转义序列 `\"` | `escaped` flag 吞掉下一个字符 |
| 数组括号 `[ ]` | 与 `{}` 同一 depth 计数 |

### StreamingSpecDispatcher — hook 进 streaming loop

`src/services/llm/clients/anthropicMessages.ts` 中三处 hook（原 `claude.ts` 约 L2023/L2138/L2211，`ff00aaf` 后职责归位至 `anthropicMessages.ts`，经 `src/services/api/queryModel.ts:17` Facade）：

```typescript
// content_block_start → 注册 tracker
specDispatcher?.onBlockStart(part.index, part.name)
// input_json_delta → feed & 尝试 dispatch
specDispatcher?.onInputDelta(part.index, delta.partial_json)
// content_block_stop → 清理 tracker
specDispatcher?.onBlockStop(part.index)
```

`tryDispatch()` 的完整闸门链：

```
JSON 完整
  → findToolByName() 找到定义？
  → isSpeculatable()？（pure + speculatable）
  → budget.canDispatch()？（预算内）
  → JSON.parse 成功且为 object？
  → inputSchema.safeParse() 通过？
  → store.claim() 未命中（防重）？
  → 全部通过 → executeToolSpeculatively() 异步执行 → specStore.dispatch()
```

投机执行使用最小化 mock `ToolUseContext` 和自动 allow 的 `canUseTool` —
因为能到达这里的工具已经过 pure 白名单筛选。

---

## 5. 集成点 — StreamingToolExecutor 的 claim 路径

`StreamingToolExecutor.addTool()`（L130-154）：

```typescript
// 正常收到完整 tool_use block 时，先尝试 claim
if (isSpeculatable(toolDefinition) && parsedInput?.success) {
  const key = specKey(block.name, parsedInput.data)
  if (this.specBudget.canDispatch(this.specStore)) {
    const hit = this.specStore.claim(key)
    if (hit) { /* HIT: 记录 specKey，跳过真实执行 */ }
  }
}
```

结果回收（L426-440）：即使没有 streaming 层的投机，普通执行完成后也会把结果
`specStore.dispatch(tool.specKey, Promise.resolve(text))` 存入 store —
这样同一 turn 内后续出现的**重复调用**（模型常见行为：改一点参数重试搜索）
也能命中缓存。

三条 debug 日志（`logForDebugging`，需 `--debug`）：

```
[spec-ptc] HIT          — claim 命中，跳过执行
[spec-ptc] DISPATCH     — 结果存入 store
[spec-ptc] YIELD        — 使用缓存结果 yield
[spec-ptc] STREAM-DISPATCH — 流式中投机 dispatch
```

---

## 6. 安全设计要点

| 关注点 | 措施 |
|--------|------|
| 副作用风险 | 只有 `pure === true` 的工具可投机 |
| 投机风暴 | BudgetTracker 双上限（5 inflight / 20 per turn） |
| 错误传播 | 投机失败 → state=failed，claim 返回 null，正常执行兜底 |
| 结果污染 | FIFO 多重度队列，每个条目只被 claim 一次 |
| turn 边界泄漏 | clear()/evict() 在 turn 结束时清理 |
| 可观测性 | stats 聚合指标 + logForDebugging 日志 |

---

## 7. 面试视角

**Q: 这本质是什么模式？**
Memoization + 预测执行（speculative execution）。CPU 领域的分支预测思想应用到
Agent loop：把"模型生成参数"和"工具执行"这两段原本串行的阶段重叠起来。

**Q: 为什么用 FIFO 队列而不是 Map<key, result>？**
多重度语义。两次相同的 Read 调用应该各自消耗一个缓存条目；Map 会把第二次
也命中同一个结果，导致第一个调用的消费者拿到被"偷走"的结果（虽然本例中无害，
但语义上 FIFO 更严格、更接近原型的 bet/claim 模型）。

**Q: 什么时候投机失败？代价是什么？**
模型最终输出的参数与投机时解析的不同（key 不匹配）、schema 校验不过、
或预算耗尽。代价 = 浪费的执行资源（受预算约束），正确性不受影响 —
claim miss 只是回退到正常执行路径。

**Q: 如何扩展到 Layer 3？**
对 REPLTool 这类代码执行工具，可以在代码流式输出过程中 fork 一个影子 VM
上下文，边解析边执行已完整的语句（shadow.py 的思路）；主 VM 只在
content_block_stop 后接管。难点在于语句级解析与副作用隔离。

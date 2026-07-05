# Ink 终端 UI 框架

## 概述

Codev 的 Ink 是基于 [vadimdemedes/ink](https://github.com/vadimdemedes/ink) v6 的深度定制分叉（fork）。Ink 使用 React 组件模型渲染终端用户界面。它将 React 的虚拟 DOM 映射到终端字符网格，支持 Yoga Flexbox 布局、样式继承、事件处理、文本选择、搜索高亮等丰富的交互能力。

> 与上游相比，Codev 的 Ink 新增/修改了以下核心能力：自定义 DOM 节点树、压缩屏幕缓冲区（Int32Array）、基于 Yoga WASM 的布局引擎、Kitty 键盘协议支持、SGR 鼠标跟踪、文本选择模式、搜索高亮、双向文本处理、scrollable 容器、声明式光标位置等。

---

## 核心架构

Ink 的渲染管线分为以下几个层次：

```
React 组件树
    │
    ▼
React Reconciler (自定义 Fiber 协调器)
    │
    ▼
DOM 节点树 (ink-root, ink-box, ink-text, ...)
    │
    ▼
Yoga 布局引擎 (WASM Flexbox)
    │
    ▼
Renderer → Output (screen buffer)
    │
    ▼
LogUpdate (差异比较)
    │
    ▼
Patch[] → ANSI 序列 → stdout
```

### Ink 主类

文件：`src/ink/ink.tsx`

`Ink` 类（约 1723 行）管理整个渲染生命周期：

- **构造函数**：设置 `LogUpdate`、节流渲染调度器（`scheduleRender`，使用 `FRAME_INTERVAL_MS=16ms`）、`FocusManager`、Yoga `onComputeLayout` 回调、React reconciler 容器
- **`onRender()`**：核心帧循环，每个渲染周期执行以下步骤：
  1. 调用 `createRenderer` 执行 DOM → Yoga 布局 → 屏幕缓冲区的渲染
  2. 处理选择滚动追踪
  3. 应用选择/搜索覆盖层
  4. 全损坏回退（full-damage backstop）
  5. 计算差异（diff）
  6. 缓冲池交换
  7. 补丁优化与序列化
  8. 光标定位（原生光标或声明式光标）
  9. 写入 stdout
- **选择管理**：`startSelection`, `extendSelection`, `wordSelect`, `lineSelect`, `dragScrollCapture`, `shiftSelection`
- **stdin 挂起/恢复**：用于外部编辑器集成
- **控制台/stderr 补丁**：拦截 console.log 等输出重定向
- **drainStdin**：清理时清空 stdin 缓冲区

### React Reconciler（协调器）

文件：`src/ink/reconciler.ts`

使用 `react-reconciler` 包创建自定义 Fiber 协调器，将 React 组件映射到 Ink 的 DOM 节点。

**关键宿主配置**：

| 钩子 | 说明 |
|------|------|
| `createInstance` | 创建 `DOMElement`（`ink-box`, `ink-text` 等），在 `<Text>` 内部嵌套时将 `ink-text` 转换为 `ink-virtual-text` |
| `createTextInstance` | 创建 `TextNode`，要求必须在 `<Text>` 内使用 |
| `commitUpdate` | React 19 使用新旧 props 直接比较，调用 `setStyle`, `setAttribute`, `setTextStyles`, `setEventHandler` |
| `commitTextUpdate` | 更新文本节点 |
| `appendChild` / `insertBefore` / `removeChild` | DOM 树操作，同步更新 Yoga 节点树 |
| `resetAfterCommit` | 提交后触发 `onComputeLayout`（Yoga 布局）和 `onRender`（渲染帧） |
| `hideInstance` / `unhideInstance` | 设置/取消 Yoga `display: none` |

**调试工具**：
- `getOwnerChain()`：从 React Fiber `_debugOwner` 提取组件名链，用于识别重绘来源
- `CLAUDE_CODE_DEBUG_REPAINTS` 环境变量：启用后记录组件树归属
- `CLAUDE_CODE_COMMIT_LOG`：记录提交/渲染性能日志

### DOM 节点树

文件：`src/ink/dom.ts`

自定义 DOM 树，与浏览器 DOM 不同，专为终端渲染优化。

**节点类型**：

| 节点名 | 说明 |
|--------|------|
| `ink-root` | 根节点，持有 `FocusManager` |
| `ink-box` | 容器（类似 `<div>`），有 Yoga 节点 |
| `ink-text` | 文本容器，有测量函数 |
| `ink-virtual-text` | `<Text>` 内嵌套的文本，无 Yoga 节点 |
| `ink-link` | 超链接，无 Yoga 节点 |
| `ink-progress` | 进度条，无 Yoga 节点 |
| `ink-raw-ansi` | 预渲染 ANSI 字符串，固定尺寸测量 |
| `#text` | 文本叶子节点 |

**DOM 操作**：
- `createNode()` / `createTextNode()` —— 创建节点
- `appendChildNode()` / `insertBeforeNode()` / `removeChildNode()` —— DOM 树操作，同步更新 Yoga 节点
- `setStyle()` / `setAttribute()` / `setTextStyles()` —— 属性更新，含脏检测（shallow equal 跳过未变更的渲染）
- `markDirty()` —— 标记节点及其所有祖先为脏
- `scheduleRenderFrom()` —— 从指定节点触发渲染（用于非 React 触发的 DOM 变更）

**脏标记（Dirty Flag）**：每个 `DOMElement` 有 `dirty` 属性（boolean），`markDirty()` 从当前节点向上遍历直到根节点。渲染完成后清除。这允许增量重绘 —— 只有脏子树被重新布局和渲染。

### Screen（屏幕缓冲区）

文件：`src/ink/screen.ts`

Screen 是终端渲染的核心数据结构，使用**压缩的 Int32Array** 存储每个单元格，避免为每个单元格分配对象（200x120 屏幕可避免分配 24000 个对象）。

**单元格存储布局**：
每个单元格占用 2 个 Int32（共 8 字节）：
- `word0`：字符 ID（索引到 `CharPool`，32 位）
- `word1`：`styleId[31:17] | hyperlinkId[16:2] | width[1:0]`

**池化系统**：

| 池 | 说明 |
|----|------|
| `CharPool` | 字符字符串池，共享跨所有屏幕。ASCII 字符使用 `Int32Array` 快速查找；非 ASCII 使用 `Map`。索引 0 固定为空格，索引 1 为 spacer 空字符串。 |
| `StylePool` | ANSI 样式池，位 0 标识样式是否在空格上可见（背景色、反色、下划线等）。提供 `transition(fromId, toId)` 方法生成缓存的 ANSI 过渡字符串。`withInverse()`、`withCurrentMatch()`、`withSelectionBg()` 用于选择/搜索覆盖层。 |
| `HyperlinkPool` | OSC 8 超链接池，索引 0 表示无链接。 |

**单元格宽度枚举（`CellWidth`）**：
| 值 | 名称 | 说明 |
|----|------|------|
| 0 | Narrow | 单宽字符 |
| 1 | Wide | 宽字符（CJK、emoji），占用两列 |
| 2 | SpacerTail | 宽字符的第二列占位符 |
| 3 | SpacerHead | 软换行时在行尾标记宽字符延续 |

**关键函数**：
- `createScreen()` —— 创建屏幕，8 字节/单元格的 ArrayBuffer
- `resetScreen()` —— 重用屏幕，使用 `BigInt64Array.fill()` 快速清空
- `setCellAt()` —— 写入单元格，自动创建宽字符的 SpacerTail
- `setCellStyleId()` —— 仅更新样式 ID，用于选择/搜索覆盖层
- `cellAt()` / `cellAtIndex()` —— 读取单元格
- `diff()` / `diffEach()` —— 比较两个屏幕，使用 `findNextDiff()` 快速跳过相同区域
- `blitRegion()` —— 批量复制矩形区域（`TypedArray.set()`）
- `clearRegion()` —— 快速清空矩形区域
- `shiftRows()` —— 行位移（`copyWithin`），用于 DECSTBM 滚动优化
- `markNoSelectRegion()` —— 标记选择排除区域
- `migrateScreenPools()` —— 跨代池重置时重新 intern

### Output（输出缓冲）

文件：`src/ink/output.ts`

收集渲染操作（Operations），在 `get()` 中统一应用到 Screen 缓冲区。

**操作类型**：
| 类型 | 说明 |
|------|------|
| `write` | 写入 ANSI 文本到指定位置 |
| `blit` | 复制源屏幕的矩形区域 |
| `clear` | 清空矩形区域 |
| `clip` / `unclip` | 裁剪区域（嵌套 `overflow:hidden`） |
| `shift` | 行位移 |
| `noSelect` | 标记选择排除区域（最后应用） |

**字符缓存**（`charCache`）：
每行文本经过 tokenize（ANSI 解析）、grapheme 聚类、双向文本重排、样式 ID + 超链接预计算后缓存。大多数行在帧间不变，缓存命中后只需读取属性并调用 `setCellAt()`。

**`writeLineToScreen()`**：
核心写入函数，处理：
- C0 控制字符（tab → 空格展开，ESC → CSI/single-char 序列跳过）
- 零宽字符（组合标记等）静默跳过
- 宽字符在行尾时放置 SpacerHead
- 写时损坏区域追踪（`screen.damage`）

### LogUpdate（差异比较与补丁生成）

文件：`src/ink/log-update.ts`

比较前一帧和当前帧的 Screen 缓冲区，生成最小补丁序列（`Diff = Patch[]`）。

**补丁类型**：
| 类型 | 说明 |
|------|------|
| `stdout` | 原始 ANSI 字符串输出 |
| `clear` | 清空 N 行 |
| `clearTerminal` | 完全清屏（全损坏，引发闪烁） |
| `cursorHide` / `cursorShow` | 光标显隐 |
| `cursorMove` | 光标相对移动 |
| `cursorTo` | 光标绝对定位到列 |
| `carriageReturn` | CR |
| `hyperlink` | OSC 8 超链接 |
| `styleStr` | 预序列化的 ANSI 样式过渡字符串 |

**DECSTBM 滚动优化**：
当 ScrollBox 的 `scrollTop` 变化时，使用硬件滚动（CSI `top;bottom r` + CSI `n S/T`）替代重写整个滚动区域，大幅减少输出字节。

**全损坏重置**（`fullResetSequence_CAUSES_FLICKER`）：
在以下情况触发终端完全清屏：
- 终端尺寸变化（resize）
- 内容高度超出视口后又缩小到视口内
- 需要更新的行在滚动缓冲区中（不可达）
- 这些重置会引发可见的闪烁

**VirtualScreen**：
内部辅助类，追踪虚拟光标位置和差异补丁列表，支持事务性操作（`txn()`）批量提交补丁。

### Frame（帧结构）

文件：`src/ink/frame.ts`

```typescript
type Frame = {
  screen: Screen          // 屏幕缓冲区
  viewport: Size           // 视口尺寸
  cursor: Cursor           // 光标状态
  scrollHint?: ScrollHint  // DECSTBM 滚动提示
  scrollDrainPending?: boolean  // 是否需要继续帧
}
```

辅助函数：
- `shouldClearScreen()` —— 判断是否需要清屏（resize 或 offscreen）
- `emptyFrame()` —— 创建空帧

---

## 布局引擎（Yoga）

文件：`src/ink/layout/` 目录

使用 [Yoga](https://yogalayout.com/) 的 WASM 实现进行 Flexbox 布局计算。

**在渲染管线中的位置**：
1. React commit 后，`resetAfterCommit` 调用 `rootNode.onComputeLayout()`
2. `ink.tsx` 中的 `onComputeLayout` 调用 `root.yogaNode.calculateLayout()`
3. Yoga 执行完整的 Flexbox 布局计算（含 `measureFunc` 回调用于文本测量）
4. Renderer 读取 `getComputedWidth/Height/Top/Left` 获取布局结果

**布局节点**：文件 `src/ink/layout/node.ts`，定义 `LayoutNode` 接口和所有布局常量（`LayoutEdge`, `LayoutDisplay`, `LayoutFlexDirection`, `LayoutJustify`, `LayoutAlign`, `LayoutOverflow`, `LayoutPositionType`, `LayoutWrap`, `LayoutGutter`）。

**布局引擎**：文件 `src/ink/layout/engine.ts`，创建和管理 Yoga WASM 实例。提供 `createLayoutNode()` 和 `getYogaCounters()` 等函数。

**测量函数**：
- `ink-text`：`measureTextNode()` —— 处理文本换行、tab 展开、bi-di 重排
- `ink-raw-ansi`：`measureRawAnsiNode()` —— 使用预设的 rawWidth/rawHeight

---

## 样式系统

文件：`src/ink/styles.ts`

样式类型定义（`Styles`）涵盖所有 CSS Flexbox 属性：

**布局**：`display`, `position`, `overflow`, `flexDirection`, `flexWrap`, `flexGrow`, `flexShrink`, `flexBasis`, `alignItems`, `alignSelf`, `justifyContent`

**尺寸**：`width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`（支持数值和百分比字符串）

**间距**：`margin`, `padding`, `gap`（含 X/Y 方向缩写）

**边框**：`borderStyle`（圆角/单线/双线等）, `borderColor`, `borderTop/Right/Bottom/Left`（控制各边显隐）

**文本**：`textWrap`（8 种模式：`wrap`, `wrap-trim`, `end`, `middle`, `truncate-end`, `truncate`, `truncate-middle`, `truncate-start`）

**其他**：`backgroundColor`, `opaque`, `noSelect`（选择排除）, `borderText`（边框内文本）

`applyStyles()` 函数将 `Styles` 对象映射到 Yoga 节点属性。每个样式类别有独立的函数（`applyPositionStyles`, `applyOverflowStyles`, `applyFlexStyles` 等）。

### TextStyles

文件：`src/ink/styles.ts`

```typescript
type TextStyles = {
  color?, backgroundColor?  // 颜色
  dim?, bold?, italic?       // 字体样式
  underline?, strikethrough? // 装饰
  inverse?                   // 反色
}
```

`TextStyles` 在 `<Text>` 组件中声明，通过 `ink-text` 节点的 `textStyles` 属性传递。渲染时由 `render-node-to-output.ts` 的 `buildTextStyles()` 转换为 ANSI SGR 序列。

---

## 事件系统

### 键盘事件

**Kitty 键盘协议**：在 raw mode 中启用 CSI u 扩展键编码（`ENABLE_KITTY_KEYBOARD` + `ENABLE_MODIFY_OTHER_KEYS`），使 Ctrl+Shift+字母 与 Ctrl+字母 可区分。终端识别通过在 XTVERSION 查询后设置。

**输入解析**：文件 `src/ink/parse-keypress.ts`，状态机解析 stdin 的原始字节流。支持：
- 普通字符（UTF-8）
- CSI 序列（方向键、功能键等）
- Kitty CSI u 序列（带修饰键编码）
- SGR 鼠标编码（`<row;col;button M/m`)
- DEC 私有模式响应（DCS 序列）
- OSC 序列（操作系统命令）
- 粘贴模式（`IN_PASTE` 状态）

**`App` 组件中的处理**（文件 `src/ink/components/App.tsx`）：
- `handleReadable()` —— stdin `readable` 事件回调
- `processInput()` —— 调用 `parseMultipleKeypresses()` 解析多按键
- `processKeysInBatch()` —— 在 `reconciler.discreteUpdates` 中批量处理按键，避免"最大更新深度超出"错误
- 处理 `Ctrl+C`（退出）、`Ctrl+Z`（挂起）、终端焦点事件（DECSET 1004）

### 鼠标事件

通过 DECSET 1003（SGR 鼠标跟踪）启用/禁用。

**`processKeysInBatch` 中的鼠标处理**（`handleMouseEvent()`）：
- **press**：开始选择、多击检测（双击选中单词、三击选中行）
- **drag**：扩展选择（字符/单词/行模式）
- **release**：结束选择
- **no-button motion**（模式 1003）：悬停事件分发（`onMouseEnter`/`onMouseLeave`）
- **超链接**：单点击时延迟打开，双击取消

**`handleMouseEvent()` 中的选择逻辑**：
- `startSelection()` / `finishSelection()` / `hasSelection()`
- 多击跟踪：`clickCount` 在 500ms 内递增，支持双击单词选择和三击行选择
- `lastPressHadAlt`：记录 Alt 修饰键，用于终端判定

### 焦点管理

文件：`src/ink/focus.ts`

`FocusManager` 存储在每个根节点，类似于浏览器 `document.activeElement`。

**功能**：
- `focus(node)` / `blur()` —— 获取/失去焦点
- `handleNodeRemoved()` —— 节点移除时自动恢复焦点到栈中上一个
- `handleAutoFocus()` —— 自动聚焦（`autoFocus` prop）
- `handleClickFocus()` —— 点击聚焦（`tabIndex` prop）
- `focusNext()` / `focusPrevious()` —— Tab / Shift+Tab 导航

**焦点栈**：最多 32 层，用于节点移除后的焦点恢复。

**事件分发**：事件系统使用 `Dispatcher` 类（`src/ink/events/dispatcher.ts`）处理捕获（Capture）和冒泡（Bubble）阶段。`EVENT_HANDLER_PROPS` 集合定义哪些 props 是事件处理器（`onClick`, `onKeyDown` 等）。

---

## 组件库

文件：`src/ink/components/`

| 组件 | 文件 | 说明 |
|------|------|------|
| `App` | `App.tsx` | 根组件，管理 stdin/stdout、raw mode、光标、挂起/恢复、事件分发、多击选择 |
| `Box` | `Box.tsx` | 布局容器（类似 `<div>`），支持完整 Flexbox 样式和事件处理器（onClick, onKeyDown, onMouseEnter, onMouseLeave, onFocus, onBlur） |
| `Text` | `Text.tsx` | 文本组件，支持颜色（color, backgroundColor）、加粗（bold）、斜体（italic）、下划线（underline）、删除线（strikethrough）、反色（inverse）、换行模式（wrap） |
| `Button` | `Button.tsx` | 按钮组件（继承 Box 的点击能力） |
| `Link` | `Link.tsx` | 超链接（使用 OSC 8 协议），终端不支持时回退到纯文本 |
| `Spacer` | `Spacer.tsx` | 弹性空间填充（`flexGrow: 1`） |
| `Newline` | `Newline.tsx` | 插入空白行 |
| `ScrollBox` | `ScrollBox.tsx` | 滚动容器（`overflow: scroll`），支持 `scrollTo()`, `scrollToElement()` 和粘性滚动 |
| `AlternateScreen` | `AlternateScreen.tsx` | 替代屏幕（alt-screen）管理 |
| `RawAnsi` | `RawAnsi.tsx` | 原始 ANSI 字符串渲染（预计算的宽度和高度） |
| `NoSelect` | `NoSelect.tsx` | 选择排除区域（如行号、diff 标记） |
| `Ansi` | (在 ink.ts 中 re-export) | ANSI 文本渲染 |
| `ErrorOverview` | `ErrorOverview.tsx` | 错误概览组件 |

**Context 提供者**：

| Context | 文件 | 提供内容 |
|---------|------|----------|
| `AppContext` | `AppContext.ts` | `exit()` 退出函数 |
| `StdinContext` | `StdinContext.ts` | `stdin`, `setRawMode`, `internal_eventEmitter`, `internal_querier` |
| `TerminalSizeContext` | `TerminalSizeContext.tsx` | `columns`, `rows` 终端尺寸 |
| `TerminalFocusContext` | `TerminalFocusContext.tsx` | `isTerminalFocused` 终端焦点状态 |
| `ClockContext` | `ClockContext.tsx` | 时钟/定时器（根据焦点状态调整间隔） |
| `CursorDeclarationContext` | `CursorDeclarationContext.ts` | 声明式光标位置 |

---

## Hooks

文件：`src/ink/hooks/`

| Hook | 文件 | 说明 |
|------|------|------|
| `useInput` | `use-input.ts` | 处理用户键盘输入（`useLayoutEffect` 同步启用 raw mode），注册 `input` 事件监听器 |
| `useStdin` | `use-stdin.ts` | 访问 stdin/setRawMode/EventEmitter |
| `useApp` | `use-app.ts` | 访问 `exit()` 函数 |
| `useAnimationFrame` | `use-animation-frame.ts` | 动画帧钩子（使用 `FRAME_INTERVAL_MS=16ms` 节流渲染） |
| `useInterval` | `use-interval.ts` | 定时器（终端失焦时可选减速） |
| `useSelection` | `use-selection.ts` | 文本选择状态管理（anchor, focus, word/line 模式） |
| `useSearchHighlight` | `use-search-highlight.ts` | 搜索高亮状态（匹配位置、当前匹配导航） |
| `useDeclaredCursor` | `use-declared-cursor.ts` | 声明式光标位置（用于 IME 输入和屏幕阅读器） |
| `useTabStatus` | `use-tab-status.ts` | Tab 状态管理 |
| `useTerminalFocus` | `use-terminal-focus.ts` | 终端焦点变化监听 |
| `useTerminalTitle` | `use-terminal-title.ts` | 终端标题设置 |
| `useTerminalViewport` | `use-terminal-viewport.ts` | 终端视口信息 |

---

## 文本选择

文件：`src/ink/selection.ts`

`SelectionState` 管理全屏模式下的文本选择：

- **anchor**：选择起点（鼠标按下处）
- **focus**：选择终点（鼠标拖动处）
- **anchorSpan**：多击（双击/三击）时初始单词/行的范围
- **scrolledOffAbove/Below**：选择过程中滚动出视口的文本
- **softWrap 标记**：跟踪软换行位置

**选择操作**：
- `startSelection()` / `updateSelection()` / `finishSelection()`
- `extendSelection()` —— 字符/单词/行模式扩展
- `getSelectedText()` —— 获取选中文本（拼接跨行的选择，含滚动出视口的文本）
- `applySelectionOverlay()` —— 在屏幕覆盖层中高亮选中区域

---

## 搜索高亮

文件：`src/ink/render-to-screen.ts` 和 `src/ink/components/App.tsx`

搜索高亮系统分为两个层次：

1. **`renderToScreen()`** —— 在独立屏幕缓冲区中渲染单个消息，扫描查询字符串的位置
2. **`applySearchHighlight()`** / **`applyPositionedHighlight()`** —— 将搜索匹配覆盖层应用到实际屏幕

**匹配视觉风格**：
- 普通匹配：反色（SGR 7，白色底，从主题继承）
- 当前匹配（用户导航到的位置）：黄色背景（通过黄色前景 + 反色实现）+ 加粗 + 下划线

---

## 渲染管线完整流程

从 React 组件到终端输出的完整流程：

```
1. React 更新 (setState / 新 props)
    │
2. Reconciler commit (resetAfterCommit)
    ├── onComputeLayout: Yoga calculateLayout()
    └── onRender: scheduleRender (节流, 16ms)
    │
3. createRenderer → renderNodeToOutput
    ├── 递归遍历 DOM 树
    ├── 应用 scrollTop 偏移
    ├── 写操作 -> Output buffer
    └── blit 操作 -> Output buffer
    │
4. Output.get()
    ├── 应用所有操作到 Screen
    ├── 处理裁剪区域
    ├── 处理 absolute 清除
    └── 更新 softWrap 标记
    │
5. LogUpdate.render()
    ├── 检查是否要全损坏重置
    ├── DECSTBM 滚动优化
    ├── diffEach 比较前后帧
    ├── 处理增长/收缩
    └── 生成 Patch[]
    │
6. optimize() — 补丁合并与去重
    │
7. writeDiffToTerminal() — 补丁序列化为 ANSI → stdout
    │
8. 屏幕选择/搜索覆盖层更新
    │
9. 光标定位
    └── 下一帧
```

---

## 特殊功能

### 双缓冲（Double Buffering）

使用前后帧（`frontFrame` / `backFrame`）实现双缓冲：
- `backFrame.screen` 是当前渲染目标
- `frontFrame.screen` 是前一帧的屏幕，用于差异比较和 blit
- 渲染帧切换后进行缓冲池交换（`swapFrames()`）

### 屏幕伤害追踪（Damage Tracking）

每个 `Screen` 有一个 `damage` 矩形区域，记录自上次重置以来发生写操作的区域。`diffEach()` 只扫描损伤区域，避免遍历整个屏幕。

### 双向文本（BiDi）

文件：`src/ink/bidi.ts`

使用 Unicode Bidirectional Algorithm 对文本行进行重排。在 `writeLineToScreen()` 中，每行文本在 tokenize 和 grapheme 聚类后执行 `reorderBidi()`。

### ANSI 解析与 Grapheme 聚类

使用 `@alcalzone/ansi-tokenize` 解析 ANSI 序列，然后通过 `Intl.Segmenter` 进行 grapheme 聚类（支持家族 emoji 等多码点字符）。结果缓存到 `charCache`，帧间重用。

### 终端查询（Terminal Querier）

文件：`src/ink/terminal-querier.ts`

`TerminalQuerier` 通过 DEC 请求序列（如 DA1、XTVERSION、DECRPM）与终端通信。它维护一个待处理请求的 Promise 队列，在收到终端响应时解析相应的 Promise。

### DEC 私有模式

文件：`src/ink/termio/dec.ts`

管理 DEC 私有模式：
- 鼠标跟踪：`ENABLE_MOUSE_TRACKING(SGR, 1003)` / `DISABLE_MOUSE_TRACKING`
- 光标显隐：`HIDE_CURSOR` / `SHOW_CURSOR`
- 焦点报告：`EFE` / `DFE`（DECSET 1004）
- 滚轮支持：通过 `DECRPM` 查询终端能力

### Kitty 键盘协议

文件：`src/ink/termio/ansi.ts` 和 `src/ink/termio/csi.ts`

通过 CSI `>1u`（Kitty 协议）和 CSI `>4;2m`（xterm modifyOtherKeys）启用扩展键盘报告，使修饰键组合（Ctrl+Shift+A 等）可区分。

### 替代屏幕（Alt Screen）

`<AlternateScreen>` 组件管理终端的替代屏幕缓冲区。启用时：
- 内容始终恰好占满终端行数
- 光标隐藏
- 启用 DECSET 1000/1002/1003 鼠标跟踪
- 支持 DECSTBM 滚动优化
- 退出时恢复主屏幕内容

### 声明式光标（Declared Cursor）

`useDeclaredCursor` 钩子和 `CursorDeclarationContext` 允许组件声明当前光标位置（如输入框），使 Ink 在每一帧后将终端光标放置在该位置，支持 IME 输入和屏幕阅读器。

### 滚动容器（ScrollBox）

`<ScrollBox>` 组件（`overflow: scroll`）实现：
- `scrollTop`：可编程滚动位置
- `pendingScrollDelta`：累积的滚动增量（限制 SCROLL_MAX_PER_FRAME 行/帧，防止大幅跳动）
- `stickyScroll`：粘性滚动（内容增长时自动保持在底部）
- `scrollTo(y)` / `scrollToElement(el, offset)`：可编程滚动
- `scrollHeight` / `scrollViewportHeight`：滚动信息查询
- `scrollClampMin` / `scrollClampMax`：虚拟滚动边界保护
- 渲染时通过 `output.shift()` 实现 DECSTBM 硬件滚动

### 选择排除（NoSelect）

`<NoSelect>` 组件标记区域为选择排除：
- `noSelect` 模式：仅排除该盒子的精确区域
- `from-left-edge` 模式：从第 0 列到盒子右边缘的整行区域
- `screen.noSelect` 位图每帧重置，`blitRegion` 复制时连带复制

### 调试与性能分析

- `CLAUDE_CODE_DEBUG_REPAINTS`：追踪重绘来源组件
- `CLAUDE_CODE_COMMIT_LOG`：记录提交/渲染时间日志
- YOGA 计数器：`getYogaCounters()` 报告每个框架的节点访问、测量、缓存命中
- `FRAME_INTERVAL_MS = 16`：60fps 帧率
- Blit/Write 比率日志：高频写入（而非 blit）时发出警告

---

## 文件索引

按功能类别整理的核心文件：

| 类别 | 文件 |
|------|------|
| 主入口 | `src/ink.ts`, `src/ink/ink.tsx` |
| DOM | `src/ink/dom.ts` |
| Reconciler | `src/ink/reconciler.ts` |
| Renderer | `src/ink/renderer.ts`, `src/ink/render-node-to-output.ts` |
| Screen | `src/ink/screen.ts` |
| Output | `src/ink/output.ts` |
| LogUpdate | `src/ink/log-update.ts` |
| Frame | `src/ink/frame.ts` |
| Styles | `src/ink/styles.ts` |
| Focus | `src/ink/focus.ts` |
| Selection | `src/ink/selection.ts` |
| Layout | `src/ink/layout/engine.ts`, `node.ts` |
| Event Dispatcher | `src/ink/events/dispatcher.ts` |
| Event Handlers | `src/ink/events/event-handlers.ts` |
| Components | `src/ink/components/` (App, Box, Text, Button, Link, Spacer, Newline, ScrollBox, AlternateScreen, RawAnsi, NoSelect, ErrorOverview) |
| Hooks | `src/ink/hooks/` (use-input, use-stdin, use-app, use-animation-frame, use-interval, use-selection, use-search-highlight, use-declared-cursor, use-tab-status, use-terminal-focus, use-terminal-title, use-terminal-viewport) |
| Termio | `src/ink/termio/ansi.ts`, `csi.ts`, `dec.ts`, `osc.ts` |
| Bidi | `src/ink/bidi.ts` |
| Constants | `src/ink/constants.ts` |
| Contexts | `src/ink/components/AppContext.ts`, `StdinContext.ts`, `TerminalSizeContext.tsx`, `TerminalFocusContext.tsx`, `ClockContext.tsx`, `CursorDeclarationContext.ts` |

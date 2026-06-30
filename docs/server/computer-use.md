# Computer Use 系统

## 概述

Computer Use 功能允许 AI 模型直接控制桌面 — 截取屏幕、移动鼠标、点击、键盘输入、窗口管理等。系统由两部分组成：

1. **TypeScript API 层** (`src/server/api/computer-use.ts`) — 环境检测、Python venv 创建、依赖安装
2. **Python Runtime 辅助脚本** (`runtime/`) — 通过子进程 `spawn` 执行，通过 stdout JSON 协议通信

## Python Runtime 辅助脚本

### 架构

```
┌─────────────────────────────────────────────┐
│             CLI 进程 (Bun/TypeScript)          │
│  src/server/api/computer-use.ts                │
│      │                                         │
│      │ child_process.spawn("python3", ...)      │
│      ▼                                         │
│  ~/.claude/.runtime/                           │
│      ├── mac_helper.py  (macOS)                │
│      ├── win_helper.py  (Windows)              │
│      ├── requirements.txt                      │
│      └── venv/                                 │
│           └── pip install pyautogui mss ...    │
│      │                                         │
│      ▼ stdout (JSON)                           │
│  {"ok": true, "result": ...}                   │
└─────────────────────────────────────────────┘
```

**编译时**: 脚本通过 Bun 的 `with { type: 'text' }` 嵌入 bundle（`computer-use.ts:27-33`）。

**运行时**: 首次使用 Computer Use 时，`ensureRuntimeFiles()` 将脚本提取到 `~/.claude/.runtime/`，创建 Python venv 并安装依赖。之后每次调用通过 `child_process.spawn` 启动 `python3 mac_helper.py <command> --payload <json>`。

### 文件说明

| 文件 | 平台 | 行数 | 依赖 |
|------|------|------|------|
| `runtime/mac_helper.py` | macOS | ~775 | pyautogui, mss, Pillow, pyobjc (Quartz/AppKit) |
| `runtime/win_helper.py` | Windows | ~770 | pyautogui, mss, Pillow, pywin32, psutil, screeninfo, pyperclip |
| `runtime/test_helpers.py` | 跨平台 | ~322 | unittest (标准库) |
| `runtime/requirements.txt` | macOS | — | pip 依赖声明 |
| `runtime/requirements-win.txt` | Windows | — | pip 依赖声明 |

### 通信协议

严格的 JSON 行协议。每次调用：

```
$ python3 mac_helper.py screenshot --payload '{"displayId": null, "targetWidth": 1024, "targetHeight": 768}'
{"ok": true, "result": {"base64": "...", "width": 1024, "height": 768, ...}}
```

失败时返回：
```json
{"ok": false, "error": {"code": "runtime_error", "message": "..."}}
```

### 命令列表

两个 helper 暴露完全相同的命令集：

**屏幕捕获：**
- `list_displays` — 列举所有显示器（分辨率、缩放因子、原点坐标）
- `get_display_size` — 获取指定显示器的尺寸
- `screenshot` — 截取全屏（可选 resize）
- `resolve_prepare_capture` — 带 fallback 的屏幕捕获
- `zoom` — 截取指定区域

**窗口管理：**
- `list_windows` — 列举可见窗口（标题、位置、所属应用）
- `find_window_displays` — 查询窗口所在的显示器
- `frontmost_app` — 获取当前前台应用
- `app_under_point` — 获取屏幕坐标下的应用
- `list_installed_apps` — 列举已安装应用
- `list_running_apps` — 列举运行中的应用
- `open_app` — 打开指定应用

**鼠标控制：**
- `click` — 点击（支持修饰键、多击）
- `drag` — 拖拽
- `move_mouse` — 移动鼠标
- `scroll` — 滚动（支持水平和垂直）
- `mouse_down` / `mouse_up` — 鼠标按键按下/释放
- `cursor_position` — 获取当前光标位置

**键盘控制：**
- `key` — 按键组合（如 `cmd+v`）
- `hold_key` — 按住键指定时长
- `type` — 输入文本

**剪贴板：**
- `read_clipboard` — 读取剪贴板文本
- `write_clipboard` — 写入剪贴板
- `paste_clipboard` — 执行粘贴（cmd+v / ctrl+v）

**权限检测：**
- `check_permissions` — 检测 Accessibility / Screen Recording 权限

**空操作（桌面应用兼容）：**
- `prepare_for_action` — 返回空数组
- `preview_hide_set` — 返回空数组

### 跨平台设计

两套 helper 遵循 **同一 JSON 协议**，差异仅限平台相关底层实现：

| 能力 | macOS (`mac_helper.py`) | Windows (`win_helper.py`) |
|------|------------------------|---------------------------|
| 显示器枚举 | Quartz `CGGetActiveDisplayList` | `screeninfo.get_monitors` |
| 窗口枚举 | Quartz `CGWindowListCopyWindowInfo` | `win32gui.EnumWindows` |
| 应用管理 | `NSWorkspace` (AppKit) | `psutil` + `winreg` |
| 剪贴板 | `NSPasteboard` (AppKit) | `pyperclip` |
| 修饰键 | `command` | `win` |
| 粘贴快捷键 | osascript `cmd+v` | pyautogui `ctrl+v` |
| 权限模型 | TCC (Transparency, Consent, and Control) | 始终返回 `True` |

`test_helpers.py` 通过静态分析验证两者的 KEY_MAP 一致性、命令集完整性和辅助函数签名。

### 与桌面 HTTP API 的关系

桌面服务器通过 `/api/computer-use/status` (GET) 和 `/api/computer-use/setup` (POST) 管理 Python runtime 的安装和状态检测。实际执行 Computer Use 动作时，CLI 进程直接 `spawn` helper 脚本，不经过 HTTP 层。

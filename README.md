# VersperClaw: Not Only AI Assistant Code Agent

<div align="center">
  <img src="assets/Versper.png" alt="VersperAI" width="60%">
</div>


## 📢 News

- **2026-05-25** 🤖 AI Friend on Desktop — Companion mode with `real-time audio/video`, avatar & background image upload, edge glow effect on transcript, and localStorage persistence.
- **2026-05-25** 🖥️ Desktop app launched — Tauri-based native UI with sidebar, tabs, title bar, and session management. Subagent inherits parent class config. Branding updated to Versper AI.
- **2026-05-23** 🧘 Added OpenCode Zen Provider — a new model provider for calm, focused AI interactions.
- **2026-05-22** 🔧 Fixed OpenCode login flow and refined prompt identity for clearer agent behavior.
- **2026-05-08** 🐛 Fixed model list not refreshing after `/login` opencode freemodel exit; subagent creation now works without API key in free mode.
- **2026-05-06** 🚀 Added OpenCode as a free provider — includes GPT-5 Nano and Big Pickle 🥒 models, `/model` list with life-free model display, and auto-refresh. Introduced ctx_line context tracking with online persistence. Better collapsing fetch results and auto-compact documentation polish. Merged PR #6 for Tavily search backend migration.
- **2026-04-30** 🔍 Added Tavily as optional search backend in WebSearchTool via PR #6.
- **2026-04-24** 🧹 Cleaned up empty contributor docs.
- **2026-04-21** 🛡️ Fixed auto-compact env in settings.json; VersperClaw now handles Ctrl+C resume gracefully.
- **2026-04-20** 📝 Documented ToolSearch behavior and <tr> table formatting.
- **2026-04-19** 📖 Described auto-dream and subagent features in README; punctuation and layout polish. Tagged **v2.0.1** 🏷️.
- **2026-04-18** 💭 Snapshot auto-dream feature; ToolSearch now uses WebSearch under the hood.
- **2026-04-15** 🌙 Auto Dream — AI autonomously reflects and builds internal memory. Fixed chatId overflow by migrating from Number to String.
- **2026-04-13** 🧠 All tools allowed in auto mode without classifier; auto-compact triggers on context size exceeded; ToolSearch enabled by default for all providers; OpenRouter full model loading. Tagged **v2.0.0** 🏷️.
- **2026-04-12** ⚡ Live refresh typing status; WebFetch now supports shouldDefer for lazy loading; symbol links documented as usable everywhere.
- **2026-04-09** 🎨 Major README overhaul — VersperAI branding with Banner & Logo, tabular layout, websearch/webfetch documentation, TypeScript main branch vs Python legacy explained. Tagged **v2.0.0** 🏷️.
- **2026-04-08** 🌐 Full WebSearch toolchain — SearXNG integration, Jina AI websearch & fetch, WebFetch UI notes, build fix. Four search approaches landed in one day.
- **2026-04-07** 🔍 Zero-search prototype; Python env removed; TLS-enabled web search working end-to-end.
- **2026-04-06** 🛠️ Open ripgrep via USE_BUILTIN_RIPGREP=0; WebFetch UI notes; skill message renamed; WebSearch API error fixed.
- **2026-04-05** 🤖 AutoMode — autonomous decision-making execution mode. `/sandbox` with sandbox-runtime @0.0.44. Project renamed to versperclaw. OpenRouter ↔ Local model switching, auto-refresh TUI, Telegram `/login` local model transition.
- **2026-04-04** 📱 Telegram backend — `/telegram` command, interactive commands, message receiving in TUI, chatId overflow fixed. `/buddy` companion mode; recent activity in individual directories.
- **2026-04-03** 🔄 Reborn as verspercode **v0.1.0** — complete `/login` system (OpenRouter + local models), `/model` search & UI, free OpenRouter model auto-load, onboarding flow. Local model filesystem-based provider.

<details>
<summary>Earlier news</summary>

- **2026-04-01** 🧹 Removed autoresearch, evolve modules, and Cursor scripts — streamlining toward v2. Tagged **v1.0.0** 🏷️.
- **2026-03-31** 🖥️ CLI update for better terminal interaction.
- **2026-03-30** 🐛 Fixed error type-in when using `/resume` session.
- **2026-03-29** 🧠 Memory routing — route-runtime-long_term for persistent context. CLI shell split to <10K lines. Browser vision click/control fixes. Paper GIF in README; --paper API call optimization.
- **2026-03-28** 📄 Academic paper pipeline — `/evolve` autonomous evolution, `/compact` context compression, LaTeX paper template, main.pdf compilation. Chrome-based research v1.0.
- **2026-03-27** 🔬 Research workflow — `/paper` and `/code` commands, 4-step research + autoresearch, ANN vector index, hybrid retrieval with semantic cache, external memory, token-budgeted evidence pipeline, IncompleteRead retry, long-term index cache. Workflows engine, `/resume` session toggle, CLI UI refresh.
- **2026-03-26** 🏗️ Configuration overhaul — YAML → JSON + .env + TOML. Clean config dir.
- **2026-03-24** 🌐 Browser control — Chrome DevTools MCP integration, WeChat gateway, Telegram gateway. Setup wizard, README with demo GIF, version menu.
- **2026-03-22** 🎉 Initial commit — versperclaw **v0.1.0** born.

</details>


## 📦 Install

```bash
# script install
curl -fsSL https://raw.githubusercontent.com/versperai/VersperClaw/main/install.sh | bash

# source install
git clone https://github.com/versperai/VersperClaw.git && cd VersperClaw && bun install && bun run build:dev:full && ./VersperClaw 

# if want global use bin file
cp VersperClaw ~/.local/bin
# then can use VersperClaw in everywhere after `/login`
```


## 🚀 Quick Start

> [!IMPORTANT]
> If you no need `auto-compact / dream / control context-window` 
> and `websearch` feature. you can no configuration anything
>
> if you no need free `local-websearch` you can skip config `searxng``
> and just set `TAVILY_API_KEY` in env 

```bash
# Maximum_Context_Window = min(CLAUDE_CODE_MAX_CONTEXT_TOKENS, CLAUDE_CODE_AUTO_COMPACT_WINDOW) - 20000
# set 200k env in ~/.claude/settings.json or terminal
# the 20k is used to compact as buffer band
# set tool_search env
# set agentteam in tmux
{
  "env": {
    "USER_TYPE": "ant",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "200000",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000",
    "ENABLE_TOOL_SEARCH": "true",
    "TAVILY_API_KEY": "",
    "teammateMode": "tmux"
  }

  # set auto-dream config
  "autoMemoryEnabled": true,
  "autoDreamEnabled": true
}
```

```bash
# Config SearXNG
# 1. docker configuration
# local config search engine - searxng in archlinux
# make sure have install docker and docker-compose
sudo pacman -S docker-compose && docker
docker --version && docker compose version
sudo usermod -aG docker $USER

# make sure open pc and now start docker daemon
sudo systemctl enable --now docker

# 2. docker-compose pull
# use VersperSearch a pre-build docker config in https://github.com/versperai/VersperSearch
# or install searxng in docker-compose by yourself
curl -fsSL \
-O https://raw.githubusercontent.com/searxng/searxng/master/container/docker-compose.yml \
-O https://raw.githubusercontent.com/searxng/searxng/master/container/.env.example

# add json source in formats behind html - jsonl in 87 lines
cd searxng/core-config/ && sudo nvim settings.yml

# start searxng engine
docker compose up -d

# 3. check search feature
# check in every browser
firefox http://localhost:8080
```

```bash
cd desktop && bun run tauri dev
# ai_friend api in 8889 so local build Omni model or use cloud service on 8889
```


## 🌐 Desktop

<table align="center">
  <tr>
    <td><img src="assets/desktop.png"></td>
  </tr>
</table>


## ✨ Features

### Agent Team and View via Tmux



### Auto Compact & Dream & SubAgent

#### 🧠 Core Mechanisms of Cycle Long Run

* **Auto Compact** — Automatically optimizes and compresses historical context to bypass sequence length bottlenecks.
* **Dream** — Consolidates raw operational data into structured, long-term parametric insights asynchronously.

#### 🗂️ SubAgent Swarm Topology

| SubAgent Type | Core Responsibility | Operational Gate |
| :--- | :--- | :--- |
| 🛡️ **General-Purpose** | Orchestrates routing, high-level user interaction, and dispatching. | Active |
| 🔍 **Explore** | Conducts deep semantic search and autonomous tool discovery. | Active |
| 📋 **Plan** | Handles multi-step chain-of-thought strategy and task decomposition. | Active |
| 🧪 **Verification** | Executes automated runtime validation, assertion checks, and fault tolerance. | Active |

<table align="center">
  <tr>
    <td><img src="assets/ctx_auto_compose/compact_dream_subagent.png"></td>
  </tr>
</table>

### WebSearch & WebFetch Tools

<table align="center">
  <tr>
    <td><img src="assets/WebSearchTool.png"></td>
    <td><img src="assets/WebSearchTool2.png"></td>
    <td><img src="assets/WebSearchTool3.png"></td>
  </tr>
</table>

### AI Friend via Omni model

<table align="center">
  <tr>
    <td><img src="assets/ai_friend.png"></td>
  </tr>
</table>

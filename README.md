# VersperClaw: Not Only AI Assistant Code Agent

<div align="center">
  <img src="assets/VersperAI_Banner.png" alt="VersperAI">
</div>

## Quick Start

```bash
# script install
curl -fsSL https://raw.githubusercontent.com/versperai/VersperClaw/main/install.sh | bash

# source install
git clone https://github.com/versperai/VersperClaw.git && cd VersperClaw && bun install && bun run build:dev:full && ./VersperClaw
```

```bash
# make symbol link
ln -sf "$(pwd)/VersperClaw" "$HOME/.local/bin/VersperClaw"

# make sure `~/.local/bin` in PATH 
# check if have in path
echo $PATH | grep -q "$HOME/.local/bin" && echo "In PATH" || echo "Out PATH"

# if not in PATH ，need add to your shell configuration

# for bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# for zsh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## WebSearch & WebFetch Tools - 100% local free no remote api fee

<table align="center">
  <tr>
    <td><img src="assets/WebSearchTool.png"></td>
    <td><img src="assets/WebSearchTool2.png"></td>
    <td><img src="assets/WebSearchTool3.png"></td>
  </tr>
</table>

```bash
# local config search engine - searxng in archlinux
# make sure have install docker and docker-compose
sudo pacman -S docker-compose && docker
docker --version && docker compose version
sudo usermod -aG docker $USER

# make sure open pc and now start docker daemon
sudo systemctl enable --now docker

# install searxng in docker-compose
curl -fsSL \
  -O https://raw.githubusercontent.com/searxng/searxng/master/container/docker-compose.yml \
  -O https://raw.githubusercontent.com/searxng/searxng/master/container/.env.example

# add json source in formats behind html - jsonl in 87 lines
cd searxng/core-config/ && sudo nvim settings.yml

# start searxng engine
docker compose up -d

# check in every browser
firefox http://localhost:8080
```

## Telegram - Interactive Config

```bash
# On startup, the CLI runs silently in the background, maintains a persistent Telegram connection, and listens for messages.
# start VersperClaw Cli
./cli-dev

# enter it into the cli input field and interactive configuration parameters
/telegram
```

## Legacy Python Version

### Demos dev/python

#### 1. Auto Scientific Research & evolve code experiment and write AI ccf/sci draft paper also support checkpoint

<table align="center">
  <tr>
    <td><img src="assets/legacy/paper.gif"/></td>
    <td><img src="assets/legacy/versper.gif"/></td>
  </tr>
</table>

#### 2. WebToolAgent

<table align="center">
  <tr>
    <td align="center"><b>Web Search</b></td>
    <td align="center"><b>Deep Search</b></td>
    <td align="center"><b>Live Chrome Control</b></td>
  </tr>
  <tr>
    <td><img src="assets/legacy/versperclaw1.jpg" width="100%"></td>
    <td><img src="assets/legacy/versperclaw2.jpg" width="100%"></td>
    <td><img src="assets/legacy/control_browser_use_gemini.jpg" width="100%"></td>
  </tr>
</table>

#### 3. Gateway - WeXin, Telegram and so on

```bash
# telegram, wechat and whatsapp
versper setup gateway

# then start listen
versper gateway
```

```bash
# Source install
git clone -b dev/python https://github.com/versperai/VersperClaw.git

# If you want check out the have been legacyed python version code, just switch to the dev/python branch

# make sure you have installed uv and creat .venv via uv venv
uv pip install -r requirements.txt # or uv sync
source .venv/bin/activate
uv pip install -e .

# use codex, openrouter, or claude remote model via api
versper setup
```

```bash
# if use vllm or llama.cpp in local model for inference 
# for example use llama.cpp
llama-server \
  --model unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf \
  --mmproj unsloth/Qwen3.5-4B-GGUF/mmproj-F16.gguf \
  --seed 3407 \
  --temp 1.0 \
  --top-p 0.95 \
  --min-p 0.01 \
  --top-k 40 \
  -c 49152 \
  --port 8001 \
  --chat-template-kwargs '{"enable_thinking":true}' \
  --host 0.0.0.0

# check model name and pass inference
curl http://localhost:8001/v1/models

curl http://localhost:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen",
    "messages": [
      {"role": "user", "content": "hello"}
    ]
  }'

cd ~/.versper && nvim config.yaml
# model:
#  api_key: sk-no-key-required
#  base_url: http://localhost:8001/v1
#  default: unsloth/Qwen3.5-4B-GGUF
#  provider: custom
```

```bash
versper doctor # make sure all checks passed
```

### Add-on

```bash
if ban mcp in ~/.versper/.env:
export VERSPER_BROWSER_USE_MCP=0
```

```bash
# live chrome control
npm install -g chrome-devtools-mcp@latest
npm install -g agent-browser@latest

# make sure you have installed chrome
google-chrome-stable

# fill it in the search bar and click the box
chrome://inspect/#remote-debugging

# check chrome connect
versper
/browser status
```

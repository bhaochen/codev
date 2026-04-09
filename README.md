# VersperClaw: Not Only AI Assistant Code Agent

<div align="center">
  <img src="assets/VersperAI_Banner.png" alt="VersperAI" width="500">
</div>

## Quick Start

```bash
# script install
curl -fsSL https://raw.githubusercontent.com/versperai/VersperClaw/main/install.sh | bash

# source install
git clone https://github.com/versperai/VersperClaw && cd VersperClaw && bun install && bun run build:dev:full && ./cli-dev
```

## WebSearch && WebFetch Tools

```bash
# config search engine - searxng in archlinux
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

## Telegram

```bash
# On startup, the CLI runs silently in the background, maintains a persistent Telegram connection, and listens for messages.
# start VersperClaw Cli
./cli-dev

# enter it into the cli input field and interactive configuration parameters
/telegram
```

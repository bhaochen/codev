#!/usr/bin/env bash
set -euo pipefail

# codev installer
# Usage: curl -fsSL https://raw.githubusercontent.com/chenbhao/Codev/main/install.sh | bash
#
# This script tries to download a pre-built binary from GitHub Releases first.
# If that fails, it falls back to building from source.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

REPO="chenbhao/Codev"
REPO_URL="https://github.com/${REPO}"
INSTALL_DIR="$HOME/codev"
BUN_MIN_VERSION="1.3.11"
LATEST_RELEASE_API="https://api.github.com/repos/${REPO}/releases/latest"

info() { printf "${CYAN}[*]${RESET} %s\n" "$*"; }
ok() { printf "${GREEN}[+]${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
fail() {
  printf "${RED}[x]${RESET} %s\n" "$*"
  exit 1
}

header() {
  echo ""
  printf "${BOLD}${CYAN}"
  cat <<'ART'

  ____          _
 / ___|___   __| | _____   __
| |   / _ \ / _` |/ _ \ \ / /
| |__| (_) | (_| |  __/\ V /
 \____\___/ \__,_|\___| \_/

ART
  printf "${RESET}"
  printf "${DIM}  The free build of Claude Code${RESET}\n"
  echo ""
}

# -------------------------------------------------------------------
# System checks
# -------------------------------------------------------------------

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) OS="macos" ;;
    Linux) OS="linux" ;;
    *) fail "Unsupported OS: $OS. macOS or Linux required." ;;
  esac

  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) fail "Unsupported architecture: $ARCH" ;;
  esac

  PLATFORM="${OS}-${ARCH}"
  ok "Platform: $PLATFORM"
}

check_curl() {
  if ! command -v curl &>/dev/null; then
    fail "curl is not installed. Install it first:
    macOS:  xcode-select --install
    Linux:  sudo pacman -S curl (or your distro's equivalent)"
  fi
  ok "curl: $(curl --version | head -1)"
}

check_git() {
  if ! command -v git &>/dev/null; then
    warn "git is not installed. Required for source build fallback."
    return 1
  fi
  ok "git: $(git --version | head -1)"
  return 0
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  [ "$(printf '%s\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

check_bun() {
  if command -v bun &>/dev/null; then
    local ver
    ver="$(bun --version 2>/dev/null || echo "0.0.0")"
    if version_gte "$ver" "$BUN_MIN_VERSION"; then
      ok "bun: v${ver}"
      return 0
    fi
    warn "bun v${ver} found but v${BUN_MIN_VERSION}+ required."
  fi
  return 1
}

install_bun() {
  info "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    fail "bun installation failed."
  fi
  ok "bun: v$(bun --version) (just installed)"
}

# -------------------------------------------------------------------
# Download pre-built binary
# -------------------------------------------------------------------

get_latest_version() {
  curl -fsSL "$LATEST_RELEASE_API" 2>/dev/null | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/'
}

download_binary() {
  local version="$1"
  local binary_name="codev-${PLATFORM}"
  local download_url="https://github.com/${REPO}/releases/download/v${version}/${binary_name}"
  local link_dir="$HOME/.local/bin"
  local target="$link_dir/codev"

  info "Downloading codev v${version} for ${PLATFORM}..."

  mkdir -p "$link_dir"

  if curl -fLo "$target" "$download_url"; then
    chmod +x "$target"
    ok "Downloaded: $target"
    return 0
  else
    warn "Download failed from $download_url"
    return 1
  fi
}

install_from_release() {
  local version
  version=$(get_latest_version)

  if [ -z "$version" ]; then
    warn "Could not determine latest version"
    return 1
  fi

  info "Latest release: v${version}"

  if download_binary "$version"; then
    return 0
  fi

  return 1
}

# -------------------------------------------------------------------
# Build from source (fallback)
# -------------------------------------------------------------------

clone_repo() {
  if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists"
    if [ -d "$INSTALL_DIR/.git" ]; then
      info "Pulling latest changes..."
      git -C "$INSTALL_DIR" pull --ff-only origin main 2>/dev/null || {
        warn "Pull failed, continuing with existing copy"
      }
    fi
  else
    info "Cloning repository..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  ok "Source: $INSTALL_DIR"
}

install_deps() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"
  bun install --frozen-lockfile 2>/dev/null || bun install
  ok "Dependencies installed"
}

build_binary() {
  info "Building Codev (all experimental features enabled)..."
  cd "$INSTALL_DIR"
  bun run build
  ok "Binary built: $INSTALL_DIR/dist/codev"
}

link_binary() {
  local link_dir="$HOME/.local/bin"
  mkdir -p "$link_dir"

  ln -sf "$INSTALL_DIR/dist/codev" "$link_dir/codev"
  ok "Symlinked: $link_dir/codev"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$link_dir"; then
    warn "$link_dir is not on your PATH"
    echo ""
    printf "${YELLOW}  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):${RESET}\n"
    printf "${BOLD}    export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n"
    echo ""
  fi
}

install_from_source() {
  info "Falling back to source build..."
  echo ""

  local has_git=0
  check_git && has_git=1 || true

  if [ "$has_git" -eq 0 ]; then
    fail "git is required for source build. Please install git first."
  fi

  check_bun || install_bun
  echo ""

  clone_repo
  install_deps
  build_binary
  link_binary
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------

header
info "Starting installation..."
echo ""

detect_platform
check_curl
echo ""

# Try pre-built binary first
if install_from_release; then
  echo ""
  printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
  echo ""
  printf "  ${BOLD}Run it:${RESET}\n"
  printf "    ${CYAN}codev${RESET}                          # interactive REPL\n"
  printf "    ${CYAN}codev -p \"your prompt\"${RESET}          # one-shot mode\n"
  echo ""
  printf "  ${BOLD}Set your API key:${RESET}\n"
  printf "    ${CYAN}export ANTHROPIC_API_KEY=\"sk-ant-...\"${RESET}\n"
  echo ""
  printf "  ${BOLD}Or log in with Claude.ai:${RESET}\n"
  printf "    ${CYAN}codev /login${RESET}\n"
  echo ""
  printf "  ${DIM}Binary: ~/.local/bin/codev${RESET}\n"
  echo ""
  exit 0
fi

# Fallback to source build
echo ""
warn "Pre-built binary not available for $PLATFORM"
info "Building from source..."
echo ""

install_from_source

echo ""
printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
echo ""
printf "  ${BOLD}Run it:${RESET}\n"
printf "    ${CYAN}codev${RESET}                          # interactive REPL\n"
printf "    ${CYAN}codev -p \"your prompt\"${RESET}          # one-shot mode\n"
echo ""
printf "  ${BOLD}Set your API key:${RESET}\n"
printf "    ${CYAN}export ANTHROPIC_API_KEY=\"sk-ant-...\"${RESET}\n"
echo ""
printf "  ${BOLD}Or log in with Claude.ai:${RESET}\n"
printf "    ${CYAN}codev /login${RESET}\n"
echo ""
printf "  ${DIM}Source: $INSTALL_DIR${RESET}\n"
printf "  ${DIM}Binary: $INSTALL_DIR/dist/codev${RESET}\n"
printf "  ${DIM}Link:   ~/.local/bin/codev${RESET}\n"
echo ""

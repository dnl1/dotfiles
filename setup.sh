#!/usr/bin/env bash
# Bootstrap a fresh WSL/Ubuntu machine with this dotfiles setup.
# Run once after cloning the repo to ~/.dotfiles/
#
# Usage:
#   git clone https://github.com/dnl1/dotfiles ~/.dotfiles
#   ~/.dotfiles/setup.sh

set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"

step()  { echo; echo "==> $*"; }
ok()    { echo "    [ok] $*"; }
skip()  { echo "    [skip] $*"; }
warn()  { echo "    [warn] $*"; }

# ── System packages ────────────────────────────────────────────────────────────
step "System packages"
sudo apt-get update -qq
sudo apt-get install -y -qq \
  zsh tmux curl git unzip build-essential \
  bat zoxide fzf ripgrep jq xclip wget gnupg ca-certificates

# ── eza (ls replacement) ───────────────────────────────────────────────────────
step "eza"
if command -v eza &>/dev/null; then
  skip "already installed ($(eza --version 2>/dev/null | head -1))"
elif apt-cache show eza &>/dev/null 2>&1; then
  sudo apt-get install -y -qq eza
  ok "installed via apt"
else
  # Ubuntu < 24.04: install from GitHub releases
  EZA_VERSION="$(curl -fsSL https://api.github.com/repos/eza-community/eza/releases/latest \
    | grep '"tag_name"' | cut -d'"' -f4)"
  curl -fsSL "https://github.com/eza-community/eza/releases/download/${EZA_VERSION}/eza_x86_64-unknown-linux-gnu.tar.gz" \
    | sudo tar -xzf - -C /usr/local/bin eza
  ok "installed $EZA_VERSION from GitHub"
fi

# ── GitHub CLI ────────────────────────────────────────────────────────────────
step "GitHub CLI (gh)"
if command -v gh &>/dev/null; then
  skip "already installed ($(gh --version | head -1))"
else
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq gh
  ok "installed"
fi

# ── Oh My Zsh ─────────────────────────────────────────────────────────────────
step "Oh My Zsh"
if [ -d "$HOME/.oh-my-zsh" ]; then
  skip "already installed"
else
  RUNZSH=no CHSH=no sh -c \
    "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
  ok "installed"
fi

# ── Powerlevel10k ─────────────────────────────────────────────────────────────
step "Powerlevel10k theme"
if [ -d "$ZSH_CUSTOM/themes/powerlevel10k" ]; then
  skip "already installed"
else
  git clone --depth=1 https://github.com/romkatv/powerlevel10k.git \
    "$ZSH_CUSTOM/themes/powerlevel10k"
  ok "installed"
fi

# ── zsh plugins ───────────────────────────────────────────────────────────────
step "zsh-autosuggestions"
if [ -d "$ZSH_CUSTOM/plugins/zsh-autosuggestions" ]; then
  skip "already installed"
else
  git clone https://github.com/zsh-users/zsh-autosuggestions \
    "$ZSH_CUSTOM/plugins/zsh-autosuggestions"
  ok "installed"
fi

step "zsh-syntax-highlighting"
if [ -d "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting" ]; then
  skip "already installed"
else
  git clone https://github.com/zsh-users/zsh-syntax-highlighting \
    "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting"
  ok "installed"
fi

# ── nvm + Node LTS ────────────────────────────────────────────────────────────
step "nvm"
if [ -d "$HOME/.nvm" ]; then
  skip "already installed"
else
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  ok "installed"
fi

step "Node LTS"
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if command -v node &>/dev/null; then
  skip "already installed ($(node --version))"
else
  nvm install --lts
  ok "installed Node $(node --version)"
fi

# ── bun ───────────────────────────────────────────────────────────────────────
step "bun"
if [ -x "$HOME/.bun/bin/bun" ] || command -v bun &>/dev/null; then
  skip "already installed"
else
  curl -fsSL https://bun.sh/install | bash
  ok "installed"
fi

# ── Go ────────────────────────────────────────────────────────────────────────
step "Go"
if [ -d /usr/local/go ]; then
  skip "already installed ($(go version 2>/dev/null || echo 'version unknown'))"
else
  GO_VERSION="1.24.3"
  ARCH="$(dpkg --print-architecture)"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
    | sudo tar -xzf - -C /usr/local
  ok "installed Go $GO_VERSION"
fi

# ── pnpm ──────────────────────────────────────────────────────────────────────
step "pnpm"
if command -v pnpm &>/dev/null || [ -x "$HOME/.local/share/pnpm/pnpm" ]; then
  skip "already installed"
else
  curl -fsSL https://get.pnpm.io/install.sh | sh -
  ok "installed"
fi

# ── opencode ──────────────────────────────────────────────────────────────────
step "opencode"
if [ -x "$HOME/.opencode/bin/opencode" ]; then
  skip "already installed"
else
  curl -fsSL https://opencode.ai/install | sh
  ok "installed"
fi

# ── Dotfiles ──────────────────────────────────────────────────────────────────
step "Dotfiles (symlink mode)"
"$DOTFILES_DIR/install-dotfiles.sh" --symlink

# ── Default shell ─────────────────────────────────────────────────────────────
step "Default shell"
ZSH_BIN="$(command -v zsh)"
if [ "$SHELL" = "$ZSH_BIN" ]; then
  skip "already zsh"
else
  chsh -s "$ZSH_BIN"
  ok "changed to $ZSH_BIN (takes effect on next login)"
fi

echo
echo "Setup complete."
echo "Run 'exec zsh' or open a new terminal to start using the new shell."
echo
warn "Remember to run 'gh auth login' to authenticate with GitHub."

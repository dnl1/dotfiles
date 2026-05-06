#!/usr/bin/env bash
# Bootstrap a fresh WSL/Ubuntu machine.
# Safe to re-run — resumes automatically from the last failed step.
#
# Usage:
#   ~/.dotfiles/setup.sh          # run or resume
#   ~/.dotfiles/setup.sh --reset  # clear saved progress and start over

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
STATE_FILE="$HOME/.dotfiles-setup.state"

# ── Colors ────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
  BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; DIM=''; RESET=''
fi

# ── Step registry (ordered) ───────────────────────────────────────────────────

STEPS=(
  system-packages
  eza
  gh-cli
  oh-my-zsh
  powerlevel10k
  zsh-autosuggestions
  zsh-syntax-highlighting
  nvm
  node-lts
  bun
  go
  pnpm
  opencode
  dotfiles
  default-shell
)

TOTAL=${#STEPS[@]}

# ── State helpers ─────────────────────────────────────────────────────────────

step_done() { grep -qxF "$1" "$STATE_FILE" 2>/dev/null; }
mark_done() { echo "$1" >> "$STATE_FILE"; }

completed_count() {
  local count=0
  for s in "${STEPS[@]}"; do step_done "$s" && count=$((count + 1)); done
  echo $count
}

# ── UI helpers ────────────────────────────────────────────────────────────────

STEP_NUM=0

print_banner() {
  echo -e "${BOLD}"
  echo "  ┌─────────────────────────────────┐"
  echo "  │   dotfiles setup — dnl1/dotfiles │"
  echo "  └─────────────────────────────────┘"
  echo -e "${RESET}"
}

print_progress() {
  local done
  done=$(completed_count)
  echo -e "${DIM}  Progress: ${done}/${TOTAL} steps completed${RESET}"
  echo
}

run_step() {
  local name="$1"
  local label="$2"
  local fn="do_${name//-/_}"
  STEP_NUM=$((STEP_NUM + 1))

  if step_done "$name"; then
    echo -e "  ${GREEN}✓${RESET} ${DIM}[$STEP_NUM/$TOTAL]${RESET} $label"
    return 0
  fi

  echo
  echo -e "  ${BLUE}→${RESET} ${BOLD}[$STEP_NUM/$TOTAL] $label${RESET}"
  local start=$SECONDS

  if $fn; then
    mark_done "$name"
    local elapsed=$((SECONDS - start))
    echo -e "  ${GREEN}✓${RESET} $label ${DIM}(${elapsed}s)${RESET}"
  else
    echo
    echo -e "  ${RED}✗  $label failed.${RESET}"
    echo -e "  ${YELLOW}Fix the error above, then re-run:${RESET}"
    echo -e "  ${BOLD}    ~/.dotfiles/setup.sh${RESET}"
    echo
    exit 1
  fi
}

# ── Step implementations ──────────────────────────────────────────────────────

do_system_packages() {
  sudo apt-get update -qq
  sudo apt-get install -y -qq \
    zsh tmux curl git unzip build-essential \
    bat zoxide fzf ripgrep jq xclip wget gnupg ca-certificates
}

do_eza() {
  if command -v eza &>/dev/null; then return 0; fi

  if apt-cache show eza &>/dev/null 2>&1; then
    sudo apt-get install -y -qq eza
  else
    local ver arch
    ver="$(curl -fsSL https://api.github.com/repos/eza-community/eza/releases/latest \
      | grep '"tag_name"' | cut -d'"' -f4)"
    case "$(dpkg --print-architecture)" in
      arm64) arch="aarch64" ;;
      *)     arch="x86_64"  ;;
    esac
    curl -fsSL \
      "https://github.com/eza-community/eza/releases/download/${ver}/eza_${arch}-unknown-linux-gnu.tar.gz" \
      | sudo tar -xzf - -C /usr/local/bin eza
  fi
}

do_gh_cli() {
  if command -v gh &>/dev/null; then return 0; fi

  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq gh
}

do_oh_my_zsh() {
  if [ -d "$HOME/.oh-my-zsh" ]; then return 0; fi
  RUNZSH=no CHSH=no sh -c \
    "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
}

do_powerlevel10k() {
  if [ -d "$ZSH_CUSTOM/themes/powerlevel10k" ]; then return 0; fi
  git clone --depth=1 https://github.com/romkatv/powerlevel10k.git \
    "$ZSH_CUSTOM/themes/powerlevel10k"
}

do_zsh_autosuggestions() {
  if [ -d "$ZSH_CUSTOM/plugins/zsh-autosuggestions" ]; then return 0; fi
  git clone https://github.com/zsh-users/zsh-autosuggestions \
    "$ZSH_CUSTOM/plugins/zsh-autosuggestions"
}

do_zsh_syntax_highlighting() {
  if [ -d "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting" ]; then return 0; fi
  git clone https://github.com/zsh-users/zsh-syntax-highlighting \
    "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting"
}

do_nvm() {
  if [ -d "$HOME/.nvm" ]; then return 0; fi
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
}

do_node_lts() {
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  if command -v node &>/dev/null; then return 0; fi
  nvm install --lts
}

do_bun() {
  if [ -x "$HOME/.bun/bin/bun" ] || command -v bun &>/dev/null; then return 0; fi
  curl -fsSL https://bun.sh/install | bash
}

do_go() {
  if [ -d /usr/local/go ]; then return 0; fi
  local ver="1.24.3"
  local arch
  arch="$(dpkg --print-architecture)"
  curl -fsSL "https://go.dev/dl/go${ver}.linux-${arch}.tar.gz" \
    | sudo tar -xzf - -C /usr/local
}

do_pnpm() {
  if command -v pnpm &>/dev/null || [ -x "$HOME/.local/share/pnpm/pnpm" ]; then return 0; fi
  curl -fsSL https://get.pnpm.io/install.sh | sh -
}

do_opencode() {
  if [ -x "$HOME/.opencode/bin/opencode" ]; then return 0; fi
  curl -fsSL https://opencode.ai/install | sh
}

do_dotfiles() {
  "$DOTFILES_DIR/install-dotfiles.sh" --symlink
}

do_default_shell() {
  local zsh_bin
  zsh_bin="$(command -v zsh)"
  if [ "$SHELL" = "$zsh_bin" ]; then return 0; fi
  chsh -s "$zsh_bin"
}

# ── Main ──────────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--reset" ]]; then
  echo -e "${YELLOW}Clearing saved progress...${RESET}"
  rm -f "$STATE_FILE"
  echo "Done. Run the script again to start from scratch."
  exit 0
fi

print_banner

# Prompt for sudo upfront so it doesn't interrupt mid-run
sudo -v
# Keep sudo alive for the duration of the script
(while true; do sudo -n true; sleep 50; done) 2>/dev/null &
SUDO_KEEPER=$!
trap 'kill $SUDO_KEEPER 2>/dev/null' EXIT

print_progress

for step in "${STEPS[@]}"; do
  case "$step" in
    system-packages)       run_step "$step" "System packages (apt)"         ;;
    eza)                   run_step "$step" "eza  (modern ls)"               ;;
    gh-cli)                run_step "$step" "GitHub CLI (gh)"                ;;
    oh-my-zsh)             run_step "$step" "Oh My Zsh"                      ;;
    powerlevel10k)         run_step "$step" "Powerlevel10k theme"            ;;
    zsh-autosuggestions)   run_step "$step" "zsh-autosuggestions plugin"     ;;
    zsh-syntax-highlighting) run_step "$step" "zsh-syntax-highlighting plugin" ;;
    nvm)                   run_step "$step" "nvm (Node version manager)"     ;;
    node-lts)              run_step "$step" "Node.js LTS"                    ;;
    bun)                   run_step "$step" "bun"                            ;;
    go)                    run_step "$step" "Go toolchain"                   ;;
    pnpm)                  run_step "$step" "pnpm"                           ;;
    opencode)              run_step "$step" "opencode"                       ;;
    dotfiles)              run_step "$step" "Dotfiles (symlink)"             ;;
    default-shell)         run_step "$step" "Set zsh as default shell"       ;;
  esac
done

echo
echo -e "  ${GREEN}${BOLD}All done!${RESET}"
echo
echo -e "  ${DIM}Next steps:${RESET}"
echo -e "    • Run ${BOLD}exec zsh${RESET} or open a new terminal"
echo -e "    • Run ${BOLD}gh auth login${RESET} to authenticate with GitHub"
echo -e "    • Run ${BOLD}p10k configure${RESET} to customize your prompt"
echo

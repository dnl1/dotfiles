#!/usr/bin/env bash
# One-liner install — clones dotfiles and runs the full bootstrap.
# Safe to re-run: resumes from the last failed step automatically.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dnl1/dotfiles/main/install.sh | bash

set -euo pipefail

REPO="https://github.com/dnl1/dotfiles.git"
DOTFILES="$HOME/.dotfiles"

# Ensure both curl and git are available before proceeding.
# On a fresh Ubuntu, git is often missing; curl is usually present but may not
# be if the user bootstrapped via wget.
_needs_install=()
for pkg in curl git; do
  command -v "$pkg" &>/dev/null || _needs_install+=("$pkg")
done
if (( ${#_needs_install[@]} )); then
  echo "==> Installing missing deps: ${_needs_install[*]}"
  DEBIAN_FRONTEND=noninteractive sudo apt-get update -qq
  DEBIAN_FRONTEND=noninteractive sudo apt-get install -y -qq "${_needs_install[@]}"
fi

if [ -d "$DOTFILES/.git" ]; then
  echo "==> Updating existing dotfiles at $DOTFILES"
  git -C "$DOTFILES" pull --ff-only
elif [ -d "$DOTFILES" ]; then
  echo "Error: $DOTFILES already exists but is not a git repository." >&2
  echo "Move or remove it and re-run." >&2
  exit 1
else
  echo "==> Cloning dotfiles to $DOTFILES"
  git clone "$REPO" "$DOTFILES"
fi

if [ ! -f "$DOTFILES/setup.sh" ]; then
  echo "Error: setup.sh not found in $DOTFILES" >&2
  exit 1
fi

chmod +x "$DOTFILES/setup.sh"
exec "$DOTFILES/setup.sh"

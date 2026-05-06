#!/usr/bin/env bash
# One-liner install — clones dotfiles and runs the full bootstrap.
# Safe to re-run: resumes from the last failed step automatically.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dnl1/dotfiles/main/install.sh | bash

set -euo pipefail

REPO="https://github.com/dnl1/dotfiles.git"
DOTFILES="$HOME/.dotfiles"

if [ -d "$DOTFILES/.git" ]; then
  echo "==> Updating existing dotfiles at $DOTFILES"
  git -C "$DOTFILES" pull --ff-only
else
  echo "==> Cloning dotfiles to $DOTFILES"
  git clone "$REPO" "$DOTFILES"
fi

exec "$DOTFILES/setup.sh"

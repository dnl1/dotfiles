#!/usr/bin/env bash
# One-liner install — clones dotfiles and runs the full bootstrap.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dnl1/dotfiles/master/install.sh | bash

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

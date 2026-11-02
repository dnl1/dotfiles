#!/usr/bin/env bash
# Install the pinned suite without activating skills or starting the viewer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="$HOME/.local/share/ub-mode"
export PATH="$HOME/.local/bin:$PATH"
for bin in git uv; do
  command -v "$bin" >/dev/null || { echo "ub-mode: $bin is required" >&2; exit 1; }
done

install_repo() {
  local name="$1" revision="$2" dir="$base/$1"
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "https://github.com/unclebob/$name.git"
  fi
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    echo "ub-mode: local changes in $dir; left untouched" >&2
    exit 1
  fi
  if [ "$(git -C "$dir" rev-parse --verify HEAD 2>/dev/null || true)" != "$revision" ]; then
    git -C "$dir" fetch --quiet --depth=1 origin "$revision"
    git -C "$dir" checkout --quiet --detach "$revision"
  fi
}

while read -r name revision; do
  if [ "$name" = uml-viewer ] && [ "${UB_MODE_WITH_UML_VIEWER:-0}" != 1 ]; then
    continue
  fi
  install_repo "$name" "$revision"
done < "$SCRIPT_DIR/revisions.tsv"

mkdir -p "$HOME/.claude/skills" "$HOME/.local/bin"
skill="$HOME/.claude/skills/ub-mode"
if [ -L "$skill" ] && [ "$(readlink "$skill")" = "$base/ub-mode" ]; then
  :
elif [ -e "$skill" ] || [ -L "$skill" ]; then
  echo "ub-mode: $skill already exists; left untouched" >&2
  exit 1
else
  ln -s "$base/ub-mode" "$skill"
fi
for name in crapper dryer mutator; do
  revision="$(git -C "$base/$name" rev-parse HEAD)"
  if [ "$name" = mutator ]; then
    revision="$revision:$(git -C "$base/crapper" rev-parse HEAD)"
  fi
  stamp="$base/.installed-$name"
  if [ -x "$HOME/.local/bin/$name" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$revision" ]; then
    continue
  fi
  if [ "$name" = mutator ]; then
    uv tool install --force --reinstall --no-python-downloads --python '>=3.11' --with "$base/crapper" "$base/$name"
  else
    uv tool install --force --reinstall --no-python-downloads --python '>=3.11' "$base/$name"
  fi
  printf '%s\n' "$revision" > "$stamp"
done

if [ "${UB_MODE_WITH_UML_VIEWER:-0}" = 1 ]; then
  launcher="$HOME/.local/bin/uml-viewer"
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    if [ -L "$launcher" ] || ! grep -Fqx '# Managed by dotfiles: ai/ub-mode/uml-viewer' "$launcher"; then
      echo "ub-mode: $launcher already exists and is unmanaged; left untouched" >&2
      exit 1
    fi
  fi
  install -m 0755 "$SCRIPT_DIR/uml-viewer" "$launcher"
fi

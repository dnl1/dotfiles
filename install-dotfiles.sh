#!/usr/bin/env bash

set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_HOME="${HOME}"
BACKUP_STAMP="$(date +%Y%m%d_%H%M%S)_$$"
MODE="copy"
BACKUP_DIR=""
backup_dir_ready=false

ensure_backup_dir() {
  if [[ "$backup_dir_ready" == false ]]; then
    BACKUP_DIR="${TARGET_HOME}/.dotfiles_backup/${BACKUP_STAMP}"
    mkdir -p "$BACKUP_DIR"
    backup_dir_ready=true
  fi
}

should_install() {
  case "$1" in
    .bash_history|.lesshst|.mysql_history|.python_history|.sqlite_history|.viminfo|.zsh_history)
      return 1
      ;;
    .zcompdump|.zcompdump-*)
      return 1
      ;;
    .sudo_as_admin_successful|.motd_shown)
      return 1
      ;;
  esac

  return 0
}

usage() {
  cat <<'EOF'
Usage: install-dotfiles.sh [--copy|--symlink] [--home PATH]

Installs top-level dotfiles from this .dotfiles directory into a home directory.

Options:
  --copy       Copy files into home (default)
  --symlink    Create symlinks in home pointing to files in .dotfiles
  --home PATH  Install into a different home directory
  -h, --help   Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy)
      MODE="copy"
      ;;
    --symlink)
      MODE="symlink"
      ;;
    --home)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Error: --home requires a path" >&2
        exit 1
      fi
      TARGET_HOME="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option '$1'" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if [[ ! -d "$DOTFILES_DIR" ]]; then
  echo "Error: dotfiles directory not found: $DOTFILES_DIR" >&2
  exit 1
fi

mkdir -p "$TARGET_HOME"

installed_count=0
backed_up_count=0
skipped_count=0

shopt -s nullglob
for src in "$DOTFILES_DIR"/.[!.]*; do
  name="${src##*/}"

  # Only top-level regular hidden files
  if [[ ! -f "$src" ]]; then
    continue
  fi

  if ! should_install "$name"; then
    continue
  fi

  dest="$TARGET_HOME/$name"

  if [[ "$MODE" == "copy" && -f "$dest" && ! -L "$dest" ]] && cmp -s "$src" "$dest"; then
    echo "Skipping $name (unchanged)"
    skipped_count=$((skipped_count + 1))
    continue
  fi

  if [[ -e "$dest" || -L "$dest" ]]; then
    if [[ "$MODE" == "symlink" && -L "$dest" ]]; then
      current_target="$(readlink "$dest" || true)"
      if [[ "$current_target" == "$src" ]]; then
        echo "Skipping $name (already linked)"
        skipped_count=$((skipped_count + 1))
        continue
      fi
    fi

    ensure_backup_dir
    cp -a "$dest" "$BACKUP_DIR/"
    backed_up_count=$((backed_up_count + 1))
  fi

  if [[ "$MODE" == "symlink" ]]; then
    rm -rf "$dest"
    ln -s "$src" "$dest"
    echo "Linked $name"
  else
    if [[ -e "$dest" || -L "$dest" ]]; then
      rm -rf "$dest"
    fi
    cp -a "$src" "$dest"
    echo "Copied $name"
  fi

  installed_count=$((installed_count + 1))
done

echo
echo "Done. Installed $installed_count dotfile(s) in $MODE mode."
if [[ $skipped_count -gt 0 ]]; then
  echo "Skipped $skipped_count unchanged/already-linked file(s)."
fi
if [[ $backed_up_count -gt 0 ]]; then
  echo "Backed up $backed_up_count existing file(s) to: $BACKUP_DIR"
fi

#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d /tmp/install-dotfiles-test.XXXXXX)"
TEST_HOME="$TMP_DIR/home"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

mkdir -p "$TEST_HOME"

expected_install_count=0
for src in "$ROOT_DIR"/.[!.]*; do
  name="${src##*/}"
  [[ -f "$src" ]] || continue

  case "$name" in
    .bash_history|.lesshst|.mysql_history|.python_history|.sqlite_history|.viminfo|.zsh_history)
      continue
      ;;
    .zcompdump|.zcompdump-*)
      continue
      ;;
    .sudo_as_admin_successful|.motd_shown)
      continue
      ;;
  esac

  expected_install_count=$((expected_install_count + 1))
done

run_install() {
  "$ROOT_DIR/install-dotfiles.sh" --copy --home "$TEST_HOME"
}

first_run_output="$(run_install)"
[[ "$first_run_output" == *"Installed $expected_install_count dotfile(s) in copy mode."* ]]
[[ -f "$TEST_HOME/.zshrc" ]]
[[ ! -d "$TEST_HOME/.dotfiles_backup" ]]

second_run_output="$(run_install)"
[[ "$second_run_output" == *"Skipping .zshrc (unchanged)"* ]]
[[ "$second_run_output" == *"Skipped $expected_install_count unchanged/already-linked file(s)."* ]]
[[ "$second_run_output" == *"Installed 0 dotfile(s) in copy mode."* ]]
[[ ! -d "$TEST_HOME/.dotfiles_backup" ]]

rm -f "$TEST_HOME/.zshrc"
ln -s "$ROOT_DIR/.zshrc" "$TEST_HOME/.zshrc"

symlink_run_output="$(run_install)"
[[ "$symlink_run_output" == *"Copied .zshrc"* ]]
[[ ! -L "$TEST_HOME/.zshrc" ]]
cmp -s "$ROOT_DIR/.zshrc" "$TEST_HOME/.zshrc"

rm -f "$TEST_HOME/.zshrc"
mkdir -p "$TEST_HOME/.zshrc"

directory_run_output="$(run_install)"
[[ "$directory_run_output" == *"Copied .zshrc"* ]]
[[ -f "$TEST_HOME/.zshrc" ]]
[[ ! -d "$TEST_HOME/.zshrc" ]]
cmp -s "$ROOT_DIR/.zshrc" "$TEST_HOME/.zshrc"

printf 'install-dotfiles smoke test passed\n'

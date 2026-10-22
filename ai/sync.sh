#!/usr/bin/env bash
# Keeps this clone on the latest commit of origin's default branch (master in
# the private dnl1/.dotfiles, main in the public dnl1/dotfiles) and re-runs
# ai/bootstrap.sh when ai/ changed since the last successful apply. bootstrap.sh
# schedules it every 15 minutes (LaunchAgent on macOS, systemd user timer on
# Linux); running it by hand is safe.
#
# It never rewrites local work: another branch, a modified tracked file, or a
# history that diverged from origin stops it with a notification instead. A run
# that finds nothing new writes nothing and stays silent.
#
#   ai/sync.sh                  check, fast-forward, apply
#   ai/sync.sh --mark-applied   record HEAD as applied (bootstrap.sh calls this)
#
# Bash 3.2-compatible on purpose: launchd starts it with macOS's /bin/bash.

set -uo pipefail   # no -e: every failure is handled, logged and notified

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# origin/HEAD names the default branch; a clone without it falls back to master.
BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
BRANCH="${BRANCH#origin/}"
[ -n "$BRANCH" ] || BRANCH=master
OS="$(uname -s)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dotfiles-sync"
APPLIED="$STATE_DIR/applied"       # last commit whose ai/ bootstrap.sh applied
FAILED="$STATE_DIR/failed"         # present while the last bootstrap failed: re-run it
NOTIFIED="$STATE_DIR/notified"     # last problem notified, so a stuck state notifies once
FETCH_ERR="$STATE_DIR/fetch-error" # last fetch error logged, so being offline logs once
LOCK_DIR="$STATE_DIR/lock"
if [ "$OS" = Darwin ]; then
  LOG="$HOME/Library/Logs/dotfiles-sync.log"
else
  LOG="$STATE_DIR/sync.log"
fi

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
  [ -t 1 ] && printf '%s\n' "$*"
  return 0
}

# launchd and systemd start jobs with a minimal PATH. Build it explicitly — and
# leave out WSL's /mnt/c entries, which would put the Windows npm ahead of nvm's.
setup_env() {
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  local nvm_sh
  for nvm_sh in "$NVM_DIR/nvm.sh" /opt/homebrew/opt/nvm/nvm.sh; do
    if [ -s "$nvm_sh" ]; then
      set +u
      # shellcheck disable=SC1090
      . "$nvm_sh" --no-use
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
      set -u
      break
    fi
  done
  # shellcheck disable=SC1091
  [ -f "$HOME/.config/ai/env.sh" ] && . "$HOME/.config/ai/env.sh"
  return 0
}

# Best effort: a notification that cannot be shown never fails the run.
notify() {
  local title="$1" body="$2" ps encoded
  log "notify: $title — $body"
  if [ "$OS" = Darwin ]; then
    osascript - "$title" "$body" >/dev/null 2>&1 <<'OSA' || true
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
OSA
    return 0
  fi
  for ps in /mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe \
            /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe; do
    [ -x "$ps" ] || continue
    # The text travels through WSLENV, never through the script, so nothing in
    # a commit subject can be parsed as PowerShell.
    encoded="$(printf '%s' '
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName("text")
[void]$text.Item(0).AppendChild($xml.CreateTextNode($env:DOTSYNC_TITLE))
[void]$text.Item(1).AppendChild($xml.CreateTextNode($env:DOTSYNC_BODY))
$app = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
' | iconv -f UTF-8 -t UTF-16LE | base64 -w0)"
    DOTSYNC_TITLE="$title" DOTSYNC_BODY="$body" WSLENV="DOTSYNC_TITLE:DOTSYNC_BODY${WSLENV:+:$WSLENV}" \
      timeout 30 "$ps" -NoProfile -NonInteractive -EncodedCommand "$encoded" >/dev/null 2>&1 </dev/null || true
    return 0
  done
  return 0
}

# A state that persists across runs (diverged, failing bootstrap) notifies once
# per distinct key instead of every 15 minutes.
notify_once() {
  local key="$1"; shift
  [ "$(cat "$NOTIFIED" 2>/dev/null || true)" = "$key" ] && return 0
  printf '%s\n' "$key" > "$NOTIFIED"
  notify "$@"
}

# mkdir is atomic on both systems (macOS has no flock). A lock whose owner is
# gone — a run killed mid-way — is taken over.
acquire_lock() {
  local pid
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || return 1
  fi
  echo $$ > "$LOCK_DIR/pid"
  trap 'rm -rf "$LOCK_DIR"' EXIT
}

trim_log() {
  [ -f "$LOG" ] || return 0
  if [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
    tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
  return 0
}

short() { git rev-parse --short "$1"; }

main() {
  mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
  cd "$REPO_DIR" || exit 1

  if [ "${1:-}" = --mark-applied ]; then
    git rev-parse HEAD > "$APPLIED"
    rm -f "$NOTIFIED" "$FAILED"
    exit 0
  fi

  setup_env
  acquire_lock || exit 0
  trim_log

  local branch head remote err pulled=0 count subjects applied
  branch="$(git symbolic-ref --short -q HEAD || true)"
  if [ "$branch" != "$BRANCH" ]; then
    notify_once "branch:$branch" "dotfiles: not syncing" \
      "$REPO_DIR is on '${branch:-detached HEAD}', not $BRANCH"
    exit 0
  fi

  if ! err="$(GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=15" \
              git fetch --quiet origin "$BRANCH" 2>&1)"; then
    # Offline is normal on a laptop: log each distinct error once, no notification.
    if [ "$(cat "$FETCH_ERR" 2>/dev/null || true)" != "$err" ]; then
      printf '%s' "$err" > "$FETCH_ERR"
      log "fetch failed: $err"
    fi
    exit 0
  fi
  rm -f "$FETCH_ERR"

  head="$(git rev-parse HEAD)"
  remote="$(git rev-parse "origin/$BRANCH")"

  if [ "$head" != "$remote" ] && ! git merge-base --is-ancestor "$remote" "$head"; then
    # Behind (origin has commits this clone lacks). Being only AHEAD is the
    # normal gap between a commit and its push, and needs nothing.
    if ! git merge-base --is-ancestor "$head" "$remote"; then
      notify_once "diverged:$head:$remote" "dotfiles: needs attention" \
        "local $BRANCH and origin/$BRANCH diverged in $REPO_DIR — merge or rebase by hand"
      exit 0
    fi
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      notify_once "dirty:$head:$remote" "dotfiles: needs attention" \
        "tracked files changed in $REPO_DIR — commit or stash them and the next run catches up"
      exit 0
    fi
    if ! err="$(git merge --ff-only --quiet "$remote" 2>&1)"; then
      log "git merge --ff-only failed: $err"
      notify_once "merge:$head:$remote" "dotfiles: update failed" \
        "git merge --ff-only failed in $REPO_DIR — see $LOG"
      exit 0
    fi
    count="$(git rev-list --count "$head..$remote")"
    subjects="$(git log --format='%s' "$head..$remote" | head -3 | paste -sd ';' - | sed 's/;/; /g')"
    log "fast-forwarded $(short "$head")..$(short "$remote") ($count commit(s)): $subjects"
    pulled=1
  fi

  # Re-apply when ai/ moved since the last successful bootstrap. With no record
  # yet, the commit this clone was on before the pull counts as applied: the
  # manual bootstrap that installed this job applied it. A failed bootstrap
  # forces a re-run even when a later commit reverts ai/ to the applied
  # content: the failed run may have left a step half-done.
  applied="$(cat "$APPLIED" 2>/dev/null || true)"
  if [ -z "$applied" ] || ! git cat-file -e "$applied^{commit}" 2>/dev/null; then
    applied="$head"
  fi

  if [ ! -f "$FAILED" ] && git diff --quiet "$applied" HEAD -- ai/; then
    [ "$(cat "$APPLIED" 2>/dev/null || true)" = "$(git rev-parse HEAD)" ] || git rev-parse HEAD > "$APPLIED"
    if [ "$pulled" = 1 ]; then
      rm -f "$NOTIFIED"
      notify "dotfiles: pulled $count commit(s)" "$subjects"
    fi
    exit 0
  fi

  if [ -n "$(git status --porcelain --untracked-files=no -- ai/)" ]; then
    # Someone is editing ai/ here; applying a half-edited tree is their call.
    log "ai/ changed since $(short "$applied") but has local edits — bootstrap skipped"
    exit 0
  fi

  if [ -f "$FAILED" ]; then
    log "last bootstrap failed — running bootstrap.sh again"
  else
    log "ai/ changed since $(short "$applied") — running bootstrap.sh"
  fi
  if DOTFILES_SYNC=1 bash "$REPO_DIR/ai/bootstrap.sh" >> "$LOG" 2>&1 </dev/null; then
    # bootstrap.sh records the applied commit itself (--mark-applied), which
    # also clears $FAILED and $NOTIFIED.
    log "bootstrap.sh succeeded at $(short HEAD)"
    notify "dotfiles: applied $(short HEAD)" "${subjects:-ai/ re-applied}"
  else
    log "bootstrap.sh failed (exit $?) at $(short HEAD)"
    git rev-parse HEAD > "$FAILED"
    notify_once "bootstrap:$(git rev-parse HEAD)" "dotfiles: bootstrap failed" \
      "ai/bootstrap.sh failed at $(short HEAD) — see $LOG (retried every run)"
  fi
  exit 0
}

# Everything runs inside main, so bash has parsed the whole file before the
# merge can replace it on disk.
main "$@"

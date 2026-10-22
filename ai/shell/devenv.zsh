# Dev environment — sourced from ~/.zshrc. Installed by ~/.dotfiles/ai/bootstrap.sh
# from ai/shell/devenv.zsh: edit it there, not here.
#
#   nt  BRANCH [base]   worktree for a ticket, shared ai-memory workspace
#   nti BRANCH [base]   same, with the ticket's memory isolated in tkt-BRANCH
#   rv  N               detached review worktree for PR #N (re-run = refresh)
#   wtmerge             (inside an nti worktree) move its durable memory pages to the shared pool
#   wtdone [-f]         remove the current worktree, its index and its tmux window
#
# The worktree helpers expect a bare-repo container (<container>/.bare, one
# worktree per branch next to it, main/ owning the real .env files). They refuse
# to run anywhere else rather than create worktrees inside an ordinary checkout.

# ---------------------------------------------------------------- worktrees

_wt_root() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    print -u2 "not inside a git repository"; return 1; }
  local root=${common:h}
  if [[ ! -d $root/.bare ]]; then
    print -u2 "$root is not a bare-repo container (no .bare/) — these helpers only run there"
    return 1
  fi
  print -r -- $root
}

# Value of KEY in the nearest .ai-memory.toml at or above DIR.
_wt_marker_value() {
  local dir=$1 key=$2
  while [[ $dir != / ]]; do
    if [[ -f $dir/.ai-memory.toml ]]; then
      sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*\"\(.*\)\"[[:space:]]*\$/\1/p" $dir/.ai-memory.toml | head -1
      return
    fi
    dir=${dir:h}
  done
}

# Opens a tmux window in DIR named NAME. Outside tmux, prints the path instead:
# a bare `tmux new-window` would land, unseen, in some other session.
_wt_window() {
  local dir=$1 name=$2
  if [[ -n $TMUX ]]; then
    tmux new-window -c $dir -n $name
  else
    print "not in tmux — cd $dir"
  fi
}

# Makes a fresh worktree runnable: .env links, dependencies, code-graph index.
_wt_hydrate() {
  local dir=$1 root
  root=$(git -C $dir rev-parse --path-format=absolute --git-common-dir) || return
  root=${root:h}
  local main=$root/main

  # 1. Link every git-IGNORED .env* file from main/. Asking git means the
  #    tracked .env.example is never shadowed; edits in main/ reach every worktree.
  if [[ $dir != $main && -d $main ]]; then
    local f
    for f in ${(f)"$(git -C $main ls-files --others --ignored --exclude-standard -- ':(glob).env*')"}; do
      [[ -n $f ]] && ln -sfn $main/$f $dir/$f
    done
  fi

  # 2. Own node_modules per worktree (branches differ in deps, and builds write
  #    into it); pnpm's hard-linked store keeps it cheap.
  if [[ -f $dir/pnpm-lock.yaml ]]; then
    (cd $dir && pnpm install --frozen-lockfile) || print -u2 "pnpm install failed in $dir"
  fi

  # 3. Code graph, so it is ready before the first Claude session.
  if command -v codebase-memory-mcp >/dev/null; then
    CBM_LOG_LEVEL=error codebase-memory-mcp cli --quiet index_repository --repo-path $dir >/dev/null \
      || print -u2 "codebase-memory index failed for $dir"
  fi
}

# _wt_new BRANCH [base] — creates <container>/BRANCH and hydrates it; opens no
# window, so callers can write markers first. Prints the worktree path.
_wt_new() {
  local branch=$1 base=${2:-origin/main} root
  [[ -n $branch ]] || { print -u2 "usage: nt|nti BRANCH [base]"; return 2; }
  root=$(_wt_root) || return
  local dir=$root/${branch//\//-}
  [[ -e $dir ]] && { print -u2 "$dir already exists"; return 1; }

  git -C $root fetch --quiet origin $branch 2>/dev/null
  if git -C $root show-ref --verify --quiet refs/heads/$branch; then
    # A bare clone copies every remote branch as a local one, with no upstream
    # and frozen at clone time: tie it to origin and fast-forward it if behind.
    if git -C $root show-ref --verify --quiet refs/remotes/origin/$branch \
       && ! git -C $root rev-parse --quiet --verify "$branch@{upstream}" >/dev/null; then
      git -C $root branch --quiet --set-upstream-to=origin/$branch $branch
      if git -C $root merge-base --is-ancestor $branch origin/$branch; then
        git -C $root update-ref refs/heads/$branch refs/remotes/origin/$branch
      fi
    fi
    git -C $root worktree add --quiet $dir $branch || return
  elif git -C $root show-ref --verify --quiet refs/remotes/origin/$branch; then
    git -C $root worktree add --quiet --track -b $branch $dir origin/$branch || return
  else
    git -C $root fetch --quiet origin || return
    # --no-track: a new branch must not track its base (origin/main).
    git -C $root worktree add --quiet --no-track -b $branch $dir $base || return
  fi
  _wt_hydrate $dir >&2
  print -r -- $dir
}

nt() {
  local dir
  dir=$(_wt_new "$@") || return
  _wt_window $dir "dev/$1"
}

nti() {
  local dir project
  dir=$(_wt_new "$@") || return
  project=$(_wt_marker_value ${dir:h} project)
  printf 'workspace = "tkt-%s"\nproject = "%s"\n' "$1" "${project:-${dir:h:t}}" > $dir/.ai-memory.toml
  _wt_window $dir "dev/$1"
}

rv() {
  local n=$1 root sha
  [[ $n == <-> ]] || { print -u2 "usage: rv PR_NUMBER"; return 2; }
  root=$(_wt_root) || return
  local dir=$root/pr-$n
  git -C $root fetch --quiet origin pull/$n/head || return
  sha=$(git -C $root rev-parse FETCH_HEAD) || return

  if [[ -d $dir ]]; then
    [[ -z $(git -C $dir status --porcelain) ]] || { print -u2 "$dir has local changes — not refreshing"; return 1; }
    git -C $dir checkout --quiet --detach $sha || return
  else
    git -C $root worktree add --quiet --detach $dir $sha || return
  fi
  local project=$(_wt_marker_value $root project)
  printf 'workspace = "reviews"\nproject = "%s"\n' "${project:-${root:t}}" > $dir/.ai-memory.toml
  _wt_hydrate $dir
  _wt_window $dir "rev/PR-$n"
}

# Run inside an nti worktree, with its Claude session ended. The shared project
# already exists, so ai-memory MERGES: only durable wiki pages move; the ticket's
# sessions and observations are purged. --on-conflict block aborts on clashes.
wtmerge() {
  local dir root ws project to
  dir=$(git rev-parse --show-toplevel) || return
  root=$(_wt_root) || return
  ws=$(_wt_marker_value $dir workspace)
  [[ $ws == tkt-* && -f $dir/.ai-memory.toml ]] || { print -u2 "not an nti worktree (no tkt-* marker here)"; return 1; }
  project=$(_wt_marker_value $dir project)
  to=$(_wt_marker_value $root workspace)
  [[ -n $to ]] || { print -u2 "no workspace in $root/.ai-memory.toml"; return 1; }
  ai-memory move-project --from-workspace $ws --project $project --to-workspace $to --on-conflict block --confirm || return
  rm -f $dir/.ai-memory.toml
}

# Removes the current worktree (never its branch), prunes git's admin dirs,
# deletes its code-graph index and closes its tmux window. -f allows a dirty tree.
wtdone() {
  local force=0
  [[ $1 == -f ]] && force=1
  local dir root
  dir=$(git rev-parse --show-toplevel) || return
  root=$(_wt_root) || return
  [[ $dir == $root/main ]] && { print -u2 "refusing to remove main/"; return 1; }
  if (( ! force )) && [[ -n $(git -C $dir status --porcelain) ]]; then
    print -u2 "$dir has uncommitted or untracked changes — commit them, or wtdone -f"
    return 1
  fi

  local project
  # JSON, not the tree view: the tree abbreviates shared path prefixes ("@0+suffix").
  project=$(CBM_LOG_LEVEL=error codebase-memory-mcp cli --quiet list_projects --format json --limit 1000 2>/dev/null \
    | jq -r --arg d $dir '.projects[] | select(.root_path == $d) | .name' | head -1)

  cd $root || return
  if (( force )); then
    git -C $root worktree remove --force $dir || return
  else
    git -C $root worktree remove $dir || return
  fi
  git -C $root worktree prune
  [[ -n $project ]] && CBM_LOG_LEVEL=error codebase-memory-mcp cli --quiet delete_project --project $project >/dev/null
  print "removed $dir (branch kept)"
  [[ -n $TMUX ]] && tmux kill-window -t "$TMUX_PANE"
}

# ---------------------------------------------------------------- drop-ins
# Machine- or employer-specific helpers go in ~/.config/zsh/devenv.d/*.zsh,
# installed by whatever owns them (the private ai/work/ overlay, for one).
for _devenv_dropin in $HOME/.config/zsh/devenv.d/*.zsh(N); do
  source $_devenv_dropin
done
unset _devenv_dropin

# Database helpers — installed into ~/.config/zsh/devenv.d/ by ai/bootstrap.sh.
# Optional local settings contain paths only, never credentials.
if [[ -f $HOME/.config/dbcreds/config.zsh ]]; then
  source "$HOME/.config/dbcreds/config.zsh"
fi
#
#   withdb TARGET CMD…  run CMD with DATABASE_URL (+ DATABASE_URL_<TARGET>) from OpenBao, then GPG
#   dbcreds-ls / dbcreds-edit / dbcreds-lock

# ---------------------------------------------------------------- DB access
# OpenBao is primary; the local GPG store is the fallback. Never put URLs in .env.
# GPG store: {"prod": "mysql://…", "stage": "mysql://…"}.
#
# Typing the passphrase caches it for 24 h, counted from when you typed it, used or
# not. The cache lives in a gpg-agent of the store's own (<store dir>/gnupg), so it
# covers this store and no key in ~/.gnupg. While it lasts, anything running as
# you — Claude included — can decrypt the store without asking; dbcreds-lock
# forgets it at once.
#
# The paths come from a function, not a global: Claude Code's shell snapshot keeps
# functions but drops plain variables, and withdb has to work from there too.

_dbcreds_store() { print -r -- "${DBCREDS_STORE:-$HOME/.config/dbcreds/db.json.gpg}" }

# Configure this store's agent without changing the user's other GPG keys or pinentry choice.
dbcreds-setup() {
  local home=${$(_dbcreds_store):h}/gnupg
  mkdir -p "$home" && chmod 700 "$home" || return
  if [[ ! -f $home/gpg-agent.conf ]]; then
    print 'default-cache-ttl 86400\nmax-cache-ttl 86400' > "$home/gpg-agent.conf" || return
  fi
  local pinentry=${commands[pinentry-mac]:-}
  if [[ -n $pinentry ]] && ! grep -Eq '^[[:space:]]*pinentry-program[[:space:]]' "$home/gpg-agent.conf"; then
    print -r -- "pinentry-program $pinentry" >> "$home/gpg-agent.conf" || return
    gpgconf --homedir "$home" --reload gpg-agent >/dev/null 2>&1 || true
  fi
}

_dbcreds_notify() {
  [[ ${HERDR_ENV:-} == 1 ]] && command -v herdr >/dev/null 2>&1 || return 0
  herdr notification show 'Unlock GPG store' --body 'Unlock it in the native window or run dbcreds-unlock --terminal in another Herdr pane. Never send the password to the agent.' --sound request >/dev/null 2>&1 || true
}

# Try the cache without prompting first, so a cached key does not send spurious requests.
_dbcreds_gpg() {
  dbcreds-setup || return
  local home=${$(_dbcreds_store):h}/gnupg
  local output tty_name
  if [[ " $* " == *' --decrypt '* ]]; then
    if output=$(gpg --homedir "$home" --quiet --batch --pinentry-mode error "$@" 2>/dev/null); then
      print -r -- "$output"
      return 0
    fi
  fi
  _dbcreds_notify
  if tty_name=$(tty 2>/dev/null); then
    GPG_TTY=$tty_name gpg --homedir "$home" --quiet "$@"
  else
    gpg --homedir "$home" --quiet "$@"
  fi
}

# Read through bao's authenticated CLI; keep provider errors out of the terminal.
_dbcreds_openbao() (
  setopt pipefail
  command -v bao >/dev/null 2>&1 || return 1
  local target=$1
  case $target in
    prod) target=production ;;
    stage) target=staging ;;
  esac
  export BAO_ADDR=${BAO_ADDR:-${VAULT_ADDR:-https://openbao.local}}
  export BAO_CLIENT_TIMEOUT=5s BAO_MAX_RETRIES=0
  if [[ $OSTYPE == darwin* ]]; then
    # Keep the .local DNS workaround inside this OpenBao-only subshell.
    export GODEBUG="${GODEBUG:+$GODEBUG,}netdns=go"
  fi
  local ca=$HOME/.config/openbao/openbao-local-ca.crt
  if [[ -z ${BAO_CACERT:-${VAULT_CACERT:-}} && -f $ca ]]; then
    export BAO_CACERT=$ca
  fi
  local url
  if url=$(command bao kv get -format=json "${DBCREDS_OPENBAO_PREFIX:-kv/databases}/$target" 2>/dev/null |
    jq -er '.data | (.data // .) | .DATABASE_URL | select(type == "string" and length > 0)' 2>/dev/null); then
    print -r -- "$url"
    return 0
  fi
  # A live token with a missing/forbidden key is not a reason to request another password.
  command -v openbao-access >/dev/null 2>&1 || return 1
  openbao-access ensure-login >/dev/null || return 1
  command bao kv get -format=json "${DBCREDS_OPENBAO_PREFIX:-kv/databases}/$target" 2>/dev/null |
    jq -er '.data | (.data // .) | .DATABASE_URL | select(type == "string" and length > 0)' 2>/dev/null
)

# withdb TARGET CMD… — exports DATABASE_URL and DATABASE_URL_<TARGET> into a
# subshell that execs CMD, so the URL never reaches argv (ps), disk or history.
# dotenv does not override a value already in the environment, so scripts need no
# change; DATABASE_URL_PROD keeps resolveDiagnosticDb(--prod) scripts working.
withdb() {
  local target=$1
  (( $# >= 2 )) || { print -u2 "usage: withdb TARGET COMMAND…"; return 2; }
  shift
  local url
  if ! url=$(_dbcreds_openbao $target) || [[ -z $url ]]; then
    print -u2 "withdb: OpenBao unavailable or credential missing; trying local GPG store"
    local store=$(_dbcreds_store)
    [[ -f $store ]] || { print -u2 "withdb: no local store — run dbcreds-edit"; return 1; }
    local json
    json=$(_dbcreds_gpg --decrypt $store) || {
      print -u2 "withdb: could not unlock the GPG store; use its native prompt or run withdb in your terminal"
      return 1
    }
    url=$(print -r -- $json | jq -r --arg t $target '.[$t] // empty') || return
    unset json
    [[ -n $url ]] || { print -u2 "withdb: no target '$target' (dbcreds-ls lists them)"; return 1; }
  fi
  (
    export DATABASE_URL=$url
    export "DATABASE_URL_${(U)target}=$url"
    unset url
    exec "$@"
  )
}

dbcreds-ls() (
  setopt pipefail
  local store=$(_dbcreds_store)
  [[ -f $store ]] || { print -u2 "no store yet — run dbcreds-edit"; return 1; }
  _dbcreds_gpg --decrypt $store | jq -r 'keys[]'
)

# --terminal is for a human in an interactive Herdr pane, including remote access.
dbcreds-unlock() {
  local store=$(_dbcreds_store) json tty_name
  [[ -f $store ]] || { print -u2 "no store yet — run dbcreds-edit"; return 1; }
  if [[ ${1:-} == --terminal ]]; then
    [[ -t 0 && -t 2 ]] || { print -u2 'Run dbcreds-unlock --terminal in your own interactive terminal.'; return 1; }
    dbcreds-setup || return
    tty_name=$(tty) || return
    _dbcreds_notify
    json=$(GPG_TTY=$tty_name gpg --homedir "${store:h}/gnupg" --quiet --pinentry-mode loopback --decrypt "$store") || return
  else
    json=$(_dbcreds_gpg --decrypt "$store") || return
  fi
  unset json
  print 'GPG store unlocked.'
}

# Forgets the cached passphrase now instead of when the 24 h are up.
dbcreds-lock() {
  gpgconf --homedir ${$(_dbcreds_store):h}/gnupg --kill gpg-agent && print "passphrase forgotten"
}

# Decrypts to tmpfs (/dev/shm; $TMPDIR on macOS), opens $EDITOR, validates, re-encrypts (AES256), deletes the plaintext.
dbcreds-edit() {
  local tmp store=$(_dbcreds_store)
  mkdir -p ${store:h} && chmod 700 ${store:h} || return
  local tmpdir=/dev/shm
  [[ -d $tmpdir && -w $tmpdir ]] || tmpdir=${TMPDIR:-/tmp}   # macOS has no tmpfs
  tmp=$(mktemp $tmpdir/dbcreds.XXXXXX) || return
  chmod 600 $tmp
  {
    if [[ -f $store ]]; then
      _dbcreds_gpg --decrypt $store > $tmp || return
    else
      print '{\n  "prod": "",\n  "stage": ""\n}' > $tmp
    fi
    while true; do
      ${EDITOR:-vi} $tmp
      jq -e 'type == "object" and all(.[]; type == "string")' $tmp >/dev/null 2>&1 && break
      read -q "?Not a JSON object of strings. Edit again? [y/N] " || { print; print -u2 "aborted — store unchanged"; return 1; }
      print
    done
    _dbcreds_gpg --yes --symmetric --cipher-algo AES256 --output $store.new $tmp \
      && mv $store.new $store && chmod 600 $store && print "saved $store"
  } always {
    shred -u $tmp 2>/dev/null || rm -f $tmp
  }
}

#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo inside WSL." >&2
  exit 1
fi

cat >/etc/wsl.conf <<'EOF'
[boot]
systemd=true

[user]
default=danil

[network]
generateResolvConf = true
EOF

rm -f /etc/resolv.conf

echo "WSL-side config repaired. Now run 'wsl --shutdown' from Windows and reopen the distro."

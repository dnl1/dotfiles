#!/bin/bash
# Only relevant on WSL — on native Ubuntu, systemd-resolved manages resolv.conf
# and writing to it directly would be overwritten or could break DNS.
grep -qi microsoft /proc/version 2>/dev/null || exit 0

if ! grep -q "nameserver" /etc/resolv.conf 2>/dev/null; then
  echo "Fixing DNS..."
  sudo sh -c 'echo "nameserver 1.1.1.1" > /etc/resolv.conf'
  sudo sh -c 'echo "nameserver 8.8.8.8" >> /etc/resolv.conf'
fi

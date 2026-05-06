#!/bin/bash

if ! grep -q "nameserver" /etc/resolv.conf 2>/dev/null; then
  echo "Fixing DNS..."
  sudo sh -c 'echo "nameserver 1.1.1.1" > /etc/resolv.conf'
  sudo sh -c 'echo "nameserver 8.8.8.8" >> /etc/resolv.conf'
fi

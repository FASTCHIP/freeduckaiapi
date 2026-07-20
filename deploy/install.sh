#!/usr/bin/env bash
#
# Install freeduckaiapi as a systemd service.
# Run from the repo root (or anywhere):  sudo bash deploy/install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST=/opt/duckai-browser

echo "==> Installing freeduckaiapi to $DEST"
mkdir -p "$DEST"
cp "$REPO_DIR/server.js" "$DEST/server.js"
cp "$REPO_DIR/package.json" "$DEST/package.json"

echo "==> Installing npm dependencies (puppeteer)"
cd "$DEST"
npm install --omit=dev

echo "==> Installing systemd unit"
cp "$SCRIPT_DIR/duckai.service" /etc/systemd/system/duckai.service
systemctl daemon-reload
systemctl enable duckai.service
systemctl restart duckai.service

echo "==> Done. Status:"
systemctl --no-pager status duckai.service | head -n 5 || true
echo
echo "Logs:   sudo journalctl -u duckai.service -f"
echo "Health: curl -s http://localhost:3000/health"

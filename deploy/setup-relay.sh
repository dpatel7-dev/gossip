#!/bin/sh
# Turn this Linux machine into a gossip relay that starts on boot and restarts
# itself if it ever crashes. Run it AFTER installing gossip on the machine:
#
#   curl -fsSL https://raw.githubusercontent.com/dpatel7-dev/gossip/main/install.sh | sh
#   sh ~/.gossip/app/deploy/setup-relay.sh            # listens on port 8787
#   sh ~/.gossip/app/deploy/setup-relay.sh 9000       # ...or another port
#
# Behind Caddy/nginx (TLS)? Add "proxy" so the relay only listens locally and
# reads visitors' real addresses from the proxy:
#
#   sh ~/.gossip/app/deploy/setup-relay.sh 8787 proxy
#
# It asks for your sudo password once, to register the service.

set -eu

PORT="${1:-8787}"
MODE="${2:-direct}"
ROOT="${GOSSIP_INSTALL_DIR:-$HOME/.gossip}"
DATA="$HOME/.gossip-server"
USER_NAME=$(id -un)
UNIT=/etc/systemd/system/gossip-relay.service

fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

[ -f "$ROOT/app/bin/gossip.js" ] || fail "gossip isn't installed here yet. Run the installer first (see the top of this file)."
command -v systemctl >/dev/null 2>&1 || fail "This machine doesn't use systemd. Run 'gossip serve' under whatever keeps your programs running."
case "$PORT" in '' | *[!0-9]*) fail "The port must be a number, like 8787." ;; esac

# Use an absolute path to Node: services don't see your shell's PATH.
if [ -x "$ROOT/node/bin/node" ]; then
  NODE="$ROOT/node/bin/node"
else
  NODE=$(command -v node) || fail "Can't find Node.js. Re-run the gossip installer."
fi

EXTRA=""
if [ "$MODE" = proxy ]; then EXTRA=" --host 127.0.0.1 --trust-proxy"; fi

echo "  Registering the gossip-relay service (port $PORT, running as $USER_NAME)..."
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=gossip relay
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
ExecStart=$NODE $ROOT/app/bin/gossip.js serve --port $PORT --data $DATA$EXTRA
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable gossip-relay >/dev/null 2>&1
sudo systemctl restart gossip-relay
sleep 1

if systemctl is-active --quiet gossip-relay; then
  echo "  Done - the relay is running and will start again after a reboot."
  echo ""
  echo "  Check it:        curl http://localhost:$PORT/healthz"
  echo "  Watch its log:   journalctl -u gossip-relay -f"
  echo "  Stop it:         sudo systemctl disable --now gossip-relay"
  echo "  Its data lives in $DATA (back that folder up to keep accounts)."
else
  echo "  The service didn't start. See why with:  journalctl -u gossip-relay -n 30"
  exit 1
fi

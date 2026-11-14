#!/bin/sh
# Turn this Linux machine into gossip's call relay (a TURN server) that starts on
# boot and restarts itself if it ever crashes. Run it AFTER installing gossip:
#
#   curl -fsSL https://raw.githubusercontent.com/dpatel7-dev/gossip/main/install.sh | sh
#   sh ~/.gossip/app/deploy/setup-turn.sh
#
# Then open the ports (on Google Cloud, from your own computer or Cloud Shell):
#
#   gcloud compute firewall-rules create gossip-turn --allow tcp:3478,udp:3478,udp:49152-65535
#
# It asks for your sudo password once, to register the service.

set -eu

ROOT="${GOSSIP_INSTALL_DIR:-$HOME/.gossip}"
DATA="$HOME/.gossip-turn"
USER_NAME=$(id -un)
UNIT=/etc/systemd/system/gossip-turn.service

fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

[ -f "$ROOT/app/bin/gossip.js" ] || fail "gossip isn't installed here yet. Run the installer first (see the top of this file)."
command -v systemctl >/dev/null 2>&1 || fail "This machine doesn't use systemd. Run 'gossip turn' under whatever keeps your programs running."

if [ -x "$ROOT/node/bin/node" ]; then
  NODE="$ROOT/node/bin/node"
else
  NODE=$(command -v node) || fail "Can't find Node.js. Re-run the gossip installer."
fi

echo "  Registering the gossip-turn service (running as $USER_NAME)..."
sudo tee "$UNIT" >/dev/null <<EOF2
[Unit]
Description=gossip call relay (TURN)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
ExecStart=$NODE $ROOT/app/bin/gossip.js turn --data $DATA
Restart=always
RestartSec=3
NoNewPrivileges=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF2

sudo systemctl daemon-reload
sudo systemctl enable gossip-turn >/dev/null 2>&1
sudo systemctl restart gossip-turn
sleep 3

if systemctl is-active --quiet gossip-turn; then
  echo "  Done - the call relay is running and will start again after a reboot."
  echo ""
  journalctl -u gossip-turn -n 12 --no-pager -o cat | sed 's/^/  /'
  echo ""
  echo "  Copy the two \"turn_...\" lines above into your website's config.json."
  echo "  Watch it:  journalctl -u gossip-turn -f      Stop it:  sudo systemctl disable --now gossip-turn"
else
  echo "  The service didn't start. See why with:  journalctl -u gossip-turn -n 30"
  exit 1
fi

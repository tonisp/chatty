#!/usr/bin/env bash
# Käivitab DecLoc Chat veebilehe + oma Nostr relay + Cloudflare Quick Tunneli ühe käsuga!
# Sobib otse Androidi Termuxisse (ilma proot-distro-ta) ja Linuxisse.
#
# Kasutamine:
#   ./relay/start-termux.sh                 # DecLoc Chat + tasuta trycloudflare.com tunnel (0 kontot!)
#   ./relay/start-termux.sh --token <TOKEN> # DecLoc Chat + püsiv Cloudflare Named Tunnel (oma domeen)
#   ./relay/start-termux.sh --local         # Ainult kohalik server ilma tunnelita

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-7777}"
MODE="quick"
CF_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE="local"; shift ;;
    --token) MODE="named"; CF_TOKEN="${2:-}"; shift 2 ;;
    --port|-p) PORT="${2:-7777}"; shift 2 ;;
    *) echo "Tundmatu valik: $1"; exit 1 ;;
  esac
done

# Hoia Termuxi telefon ärkvel (kui käivitatakse Androidi Termuxis)
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
  echo "✓ termux-wake-lock aktiveeritud"
fi

HOST="127.0.0.1"
if [[ "$MODE" == "local" ]]; then
  HOST="0.0.0.0"
fi

node "$SCRIPT_DIR/server.mjs" --host "$HOST" --port "$PORT" &
SERVER_PID=$!

cleanup() {
  echo ""
  echo "Peatan serveri ja tunneli…"
  kill "$SERVER_PID" 2>/dev/null || true
  if command -v termux-wake-unlock >/dev/null 2>&1; then
    termux-wake-unlock || true
  fi
}
trap cleanup EXIT INT TERM

sleep 1

if [[ "$MODE" == "local" ]]; then
  echo "DecLoc Chat töötab kohalikult pordil $PORT."
  wait "$SERVER_PID"
  exit 0
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Viga: 'cloudflared' ei ole paigaldatud."
  echo "Termuxis paigalda käsuga: pkg install cloudflared"
  exit 1
fi

if [[ "$MODE" == "named" ]]; then
  if [[ -z "$CF_TOKEN" ]]; then
    echo "Viga: --token vajab Cloudflare tunneli tokenit."
    exit 1
  fi
  echo "Käivitan püsiva Cloudflare Named Tunneli…"
  cloudflared tunnel run --token "$CF_TOKEN"
else
  echo "Käivitan kontovaba Cloudflare Quick Tunneli (oota avalikku https://...trycloudflare.com linki)…"
  cloudflared tunnel --url "http://127.0.0.1:$PORT"
fi

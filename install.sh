#!/usr/bin/env bash
# bridge installer — headless runner for linux + macOS
#
#   curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash            (stable)
#   curl -fsSL https://raw.githubusercontent.com/state-vector/bridge/main/install.sh | bash -s -- dev  (rolling main build)
#
# Downloads the latest release binary for your platform, verifies its
# checksum, and installs it to $BRIDGE_INSTALL_DIR (default ~/.local/bin).
# Nothing else touches your system — no root, no shell rc edits.
#
# Channel: `dev` installs the rolling pre-release rebuilt on every push to
# main. Default (no argument) is the newest versioned release.

set -euo pipefail

REPO="state-vector/bridge"
BIN="bridge"
INSTALL_DIR="${BRIDGE_INSTALL_DIR:-$HOME/.local/bin}"

info()  { printf '\033[1;34mbridge\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mbridge\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31mbridge\033[0m %s\n' "$*" >&2; exit 1; }

# ---- platform ----
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) os="apple-darwin" ;;
  Linux)  os="unknown-linux-gnu" ;;
  *) fail "unsupported OS: $OS (linux and macOS only)" ;;
esac
case "$ARCH" in
  arm64|aarch64) arch="aarch64" ;;
  x86_64|amd64)  arch="x86_64" ;;
  *) fail "unsupported architecture: $ARCH" ;;
esac
TARGET="${arch}-${os}"
info "installing bridge for $TARGET"

# ---- tools ----
command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "need sha256sum or shasum for checksum verification"
fi
if command -v tar >/dev/null 2>&1; then tar="tar"; else fail "tar is required"; fi

# ---- resolve release by channel ----
CHANNEL="${1:-stable}"
case "$CHANNEL" in
  stable)
    API="https://api.github.com/repos/$REPO/releases/latest"
    info "resolving latest release…"
    METADATA="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" \
      || fail "could not reach GitHub releases (rate-limited? retry in a minute)"
    TAG="$(printf '%s' "$METADATA" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
    [ -n "$TAG" ] || fail "no release found — has a release been published yet?"
    ;;
  dev)
    TAG="dev" # rolling pre-release, rebuilt on every push to main
    ;;
  *) fail "unknown channel: '$CHANNEL' (stable | dev)" ;;
esac
ASSET="bridge-${TARGET}.tar.gz"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
info "channel: $CHANNEL ($TAG)"

# ---- download + verify ----
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
info "downloading ${ASSET}…"
curl -fsSL -o "$TMP/$ASSET" "$URL" || fail "download failed: $URL"
curl -fsSL -o "$TMP/$ASSET.sha256" "$URL.sha256" || warn "no checksum published — skipping verification (unusual)"
if [ -s "$TMP/$ASSET.sha256" ]; then
  EXPECTED="$(cut -d' ' -f1 "$TMP/$ASSET.sha256" | head -1)"
  ACTUAL="$(sha256 "$TMP/$ASSET")"
  [ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch — refusing to install (expected $EXPECTED, got $ACTUAL)"
  info "checksum verified"
fi

$tar -xzf "$TMP/$ASSET" -C "$TMP"
[ -f "$TMP/$BIN" ] || fail "archive did not contain $BIN"

# ---- install ----
mkdir -p "$INSTALL_DIR"
mv "$TMP/$BIN" "$INSTALL_DIR/$BIN"
chmod +x "$INSTALL_DIR/$BIN"
info "installed $INSTALL_DIR/$BIN"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) warn "$INSTALL_DIR is not on your PATH — add it:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

VERSION="$("$INSTALL_DIR/$BIN" --version 2>/dev/null || true)" || true
info "ready. next steps:"
cat <<EOF

  1. Check your setup (config, models, agent CLIs, git):
       $INSTALL_DIR/$BIN doctor

  2. Pair with a hub (prints a code; approve it in the web UI). The shared
     hub is https://hub.fleetbridge.run — sign in with GitHub there; self-
     hosters pair their own URL instead:
       $INSTALL_DIR/$BIN pair https://hub.fleetbridge.run

  3. Set a model per agent in ~/.bridge/config.json ("models") — the runner
     refuses to dispatch without one. `bridge doctor` tells you if it's right.

  4. Run forever (linux):
       $INSTALL_DIR/$BIN service install
       systemctl --user enable --now bridge

  The runner claims todo tasks from the board and dispatches each to a
  local agent CLI in an isolated git worktree, one PR per task.

  Env overrides: BRIDGE_URL BRIDGE_TOKEN BRIDGE_WORKDIR BRIDGE_AGENT
                 BRIDGE_MAX_SESSIONS BRIDGE_POLL_SECS BRIDGE_BACKENDS BRIDGE_MODEL
EOF

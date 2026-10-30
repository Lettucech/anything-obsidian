#!/bin/sh
# Anything Obsidian one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Lettucech/anything-obsidian/main/install.sh | sh
#
# Non-interactive (agent) mode — provide all three and nothing is prompted:
#   install.sh --vaults-root <path> --url <anythingllm-url> --api-key <key> [--port <n>] [--no-browser]
#
# Layout it creates:
#   ~/.anything-obsidian/app       the application (downloaded from GitHub)
#   ~/.anything-obsidian/runtime   a portable Node.js, only if the system has no node >= 22
#   ~/.local/bin/anything-obsidian CLI launcher (short form: any-obs)
#
# Data (config, secrets, registry) lives separately under the OS app-support
# directory and is never removed by this script. See uninstall.sh.
set -eu

REPO="${ANYTHING_OBSIDIAN_REPO:-Lettucech/anything-obsidian}"
BRANCH="${ANYTHING_OBSIDIAN_BRANCH:-main}"
APP_ROOT="${ANYTHING_OBSIDIAN_APP_HOME:-$HOME/.anything-obsidian}"
APP_DIR="$APP_ROOT/app"
RUNTIME_DIR="$APP_ROOT/runtime"
BIN_DIR="$HOME/.local/bin"
NODE_VERSION="${ANYTHING_OBSIDIAN_NODE_VERSION:-}"
SELF_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh"

say() { printf '%s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

usage() {
  cat << 'USAGE_EOF'
Anything Obsidian installer

Interactive (default):
  install.sh

Non-interactive (agent) mode — provide all three, nothing is prompted:
  install.sh --vaults-root <path> --url <anythingllm-url> --api-key <key> [--port <n>]

Options:
  --no-browser    do not open the browser when done
  --server         server install: configure for the IAM gateway and register
                   the gateway service; client role is configured separately

Environment overrides:
  ANYTHING_OBSIDIAN_APP_HOME     where the app lives (default ~/.anything-obsidian)
  ANYTHING_OBSIDIAN_HOME         where data/config lives (default OS app-support dir)
  ANYTHING_OBSIDIAN_NODE_VERSION portable node version (default: latest Node 22 patch)
  ANYTHING_OBSIDIAN_REPO         GitHub repo slug (default Lettucech/anything-obsidian)
  ANYTHING_OBSIDIAN_BRANCH       branch/tag to install (default main)
USAGE_EOF
}

# ---------- when piped, re-exec from a real file so prompts work ----------
# Runs before flag parsing so "$@" is still intact. The env guard prevents
# the re-executed instance from re-execing again.
if [ ! -t 0 ] && [ -z "${AO_INSTALLER_EXECED:-}" ]; then
  if [ -r "$0" ] && [ -s "$0" ] && [ "$0" != "/dev/stdin" ]; then SCRIPT_FILE="$0";
  else
    SCRIPT_FILE="$APP_ROOT/install.$$.sh"
    mkdir -p "$APP_ROOT"
    curl -fsSL "$SELF_URL" -o "$SCRIPT_FILE" || die "Could not download the installer. Check your network and try again."
  fi
  if ( : </dev/tty ) 2>/dev/null; then STDIN_SRC="/dev/tty"; else STDIN_SRC="/dev/null"; fi
  AO_INSTALLER_EXECED=1
  export AO_INSTALLER_EXECED
  exec sh "$SCRIPT_FILE" "$@" <"$STDIN_SRC"
fi

# ---------- flags ----------
VAULTS_ROOT=""; URL=""; API_KEY=""; PORT=""; NO_BROWSER=0; SERVER=0; WANT_HELP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --vaults-root) VAULTS_ROOT="${2:?}"; shift 2 ;;
    --url) URL="${2:?}"; shift 2 ;;
    --api-key) API_KEY="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --no-browser) NO_BROWSER=1; shift ;;
    --server) SERVER=1; NO_BROWSER=1; shift ;;
    --help|-h) WANT_HELP=1; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [ "$WANT_HELP" -eq 1 ]; then usage; exit 0; fi

NON_INTERACTIVE=0
if [ -n "$URL" ] && [ -n "$API_KEY" ] && { [ -n "$VAULTS_ROOT" ] || [ "$SERVER" -eq 1 ]; }; then NON_INTERACTIVE=1; fi

# ---------- platform ----------
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Darwin-arm64) NODE_TARGET="darwin-arm64" ;;
  Darwin-x86_64) NODE_TARGET="darwin-x64" ;;
  Linux-x86_64) NODE_TARGET="linux-x64" ;;
  Linux-aarch64|Linux-arm64) NODE_TARGET="linux-arm64" ;;
  *) die "Unsupported platform: $OS $ARCH — Anything Obsidian needs macOS or Linux (on Windows, use WSL)." ;;
esac

say "Anything Obsidian installer"
say "  platform: $OS $ARCH"
say ""

# ---------- node ----------
find_node() {
  if command -v node >/dev/null 2>&1; then
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$major" -ge 22 ]; then command -v node; return 0; fi
  fi
  for candidate in "$RUNTIME_DIR"/node-v*/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
  if [ -n "$NODE_VERSION" ]; then
    case "$NODE_VERSION" in *[!0-9.]*|.*) die "Invalid portable Node version" ;; esac
    NODE_DIST="https://nodejs.org/dist/v$NODE_VERSION"
  else
    NODE_DIST="https://nodejs.org/dist/latest-v22.x"
  fi
  MANIFEST="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt")" || die "Could not fetch Node checksums"
  TARBALL="$(printf '%s\n' "$MANIFEST" | awk -v suffix="-$NODE_TARGET.tar.gz" '$2 ~ suffix "$" {print $2; exit}')"
  [ -n "$TARBALL" ] || die "No Node runtime for $NODE_TARGET"
  say "  downloading a portable supported Node.js ($NODE_TARGET)…"
  mkdir -p "$RUNTIME_DIR"
  RUNTIME_STAGE="$(mktemp -d "$RUNTIME_DIR/download.XXXXXX")"
  curl -fsSL "$NODE_DIST/$TARBALL" -o "$RUNTIME_STAGE/$TARBALL" || die "Node download failed"
  EXPECTED="$(printf '%s\n' "$MANIFEST" | awk -v archive="$TARBALL" '$2 == archive {print $1; exit}')"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$RUNTIME_STAGE/$TARBALL" | awk '{print $1}')"
  else
    ACTUAL="$(shasum -a 256 "$RUNTIME_STAGE/$TARBALL" | awk '{print $1}')"
  fi
  [ "$ACTUAL" = "$EXPECTED" ] || die "Node archive checksum mismatch"
  tar -xzf "$RUNTIME_STAGE/$TARBALL" -C "$RUNTIME_DIR" || die "Could not extract Node runtime"
  rm -rf "$RUNTIME_STAGE"
  NODE_BIN="$RUNTIME_DIR/${TARBALL%.tar.gz}/bin/node"
  [ -x "$NODE_BIN" ] || die "Downloaded Node.js is not runnable at $NODE_BIN"
  say "  ✓ portable node ready"
else
  say "  ✓ node: $("$NODE_BIN" --version)"
fi

# ---------- git ----------
if ! command -v git >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    die "git was not found. Run: xcode-select --install   then re-run this installer."
  else
    die "git was not found. Install git with your package manager (e.g. apt install git) and re-run."
  fi
fi
say "  ✓ git: $(git --version | sed 's/^git version /git /')"

# ---------- app ----------
say "  downloading the app from github.com/$REPO ($BRANCH)…"
STAGING="$APP_ROOT/download.$$"
mkdir -p "$STAGING"
curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$STAGING" \
  || die "Could not download the repository. Check github.com/$REPO is reachable."
SOURCE_DIR="$(find "$STAGING" -maxdepth 1 -mindepth 1 -type d | head -1)"
if [ -z "$SOURCE_DIR" ]; then die "Downloaded archive was empty."; fi
NPM_CLI=""
for candidate in "$(dirname "$NODE_BIN")/npm" "$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js"; do
  if [ -f "$candidate" ]; then NPM_CLI="$candidate"; break; fi
done
[ -n "$NPM_CLI" ] || die "npm was not found beside Node. Install a complete Node distribution."
say "  installing dependencies in staging…"
(cd "$SOURCE_DIR" && "$NODE_BIN" "$NPM_CLI" ci --omit=dev --no-audit --no-fund) \
  || die "Dependencies failed. Existing installation was kept."
"$NODE_BIN" "$SOURCE_DIR/bin/anything-obsidian.mjs" --help >/dev/null \
  || die "Staged app validation failed. Existing installation was kept."
if [ -d "$APP_DIR" ]; then
  die "An app already exists at $APP_DIR. Use anything-obsidian update; it supports rollback."
fi
mv "$SOURCE_DIR" "$APP_DIR"
rm -rf "$STAGING"
say "  ✓ app installed: $APP_DIR"

# Pin the same resolved data directory in the launcher and service definitions.
case "$OS" in
  Darwin) DATA_ROOT="${ANYTHING_OBSIDIAN_HOME:-$HOME/Library/Application Support/anything-obsidian}" ;;
  *) DATA_ROOT="${ANYTHING_OBSIDIAN_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/anything-obsidian}" ;;
esac
export ANYTHING_OBSIDIAN_HOME="$DATA_ROOT"

# ---------- CLI launcher ----------
LAUNCHER="$BIN_DIR/anything-obsidian"
mkdir -p "$BIN_DIR"
shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
APP_LITERAL="$(shell_quote "$APP_DIR")"
RUNTIME_LITERAL="$(shell_quote "$RUNTIME_DIR")"
DATA_LITERAL="$(shell_quote "$DATA_ROOT")"
ROOT_LITERAL="$(shell_quote "$APP_ROOT")"
cat > "$LAUNCHER" << LAUNCHER_EOF
#!/bin/sh
# Anything Obsidian CLI launcher (managed by install.sh / uninstall.sh)
AO_APP=$APP_LITERAL
AO_RUNTIME=$RUNTIME_LITERAL
# Recover the brief directory-switch window if an update was interrupted.
if [ ! -d "\$AO_APP" ] && [ -d "\$AO_APP.previous" ]; then mv "\$AO_APP.previous" "\$AO_APP"; fi
if [ -z "\${ANYTHING_OBSIDIAN_HOME:-}" ]; then ANYTHING_OBSIDIAN_HOME=$DATA_LITERAL; fi
export ANYTHING_OBSIDIAN_HOME
export ANYTHING_OBSIDIAN_APP_HOME=$ROOT_LITERAL
if command -v node >/dev/null 2>&1; then
  AO_NODE="\$(command -v node)"
  AO_MAJOR="\$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "\$AO_MAJOR" -ge 22 ]; then exec "\$AO_NODE" "\$AO_APP/bin/anything-obsidian.mjs" "\$@"; fi
fi
for candidate in "\$AO_RUNTIME"/node-v*/bin/node; do
  if [ -x "\$candidate" ]; then exec "\$candidate" "\$AO_APP/bin/anything-obsidian.mjs" "\$@"; fi
done
echo "anything-obsidian: no supported Node found; re-run the installer." >&2
exit 1
LAUNCHER_EOF

chmod +x "$LAUNCHER"

# Short form — same launcher body, one command to type.
ALIAS_BIN="$BIN_DIR/any-obs"
sed "s/anything-obsidian: no supported Node found/any-obs: no supported Node found/" "$LAUNCHER" > "$ALIAS_BIN"
chmod +x "$ALIAS_BIN"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    PROFILE="$HOME/.zshrc"
    if [ -n "${SHELL:-}" ]; then
      case "$SHELL" in
        *bash) PROFILE="$HOME/.bashrc" ;;
      esac
    fi
    {
      printf '\n# >>> anything-obsidian >>>\n'
      printf 'export PATH="$HOME/.local/bin:$PATH"\n'
      printf '# <<< anything-obsidian <<<\n'
    } >> "$PROFILE"
    say "  ✓ added $BIN_DIR to PATH in $PROFILE (new terminals pick this up)"
    ;;
esac
say "  ✓ CLI ready: $LAUNCHER (short form: any-obs)"

# ---------- setup and verify ----------
# Build argv without word splitting: paths and credentials may contain spaces.
set -- setup
if [ "$SERVER" -eq 1 ]; then set -- "$@" --server; fi
if [ -n "$VAULTS_ROOT" ]; then set -- "$@" --vaults-root "$VAULTS_ROOT"; fi
if [ -n "$URL" ]; then set -- "$@" --url "$URL"; fi
if [ -n "$API_KEY" ]; then set -- "$@" --api-key "$API_KEY"; fi
if [ -n "$PORT" ]; then set -- "$@" --port "$PORT"; fi
"$LAUNCHER" "$@" || die "Setup did not complete. Follow the error above, then run: anything-obsidian start"
"$LAUNCHER" status --json || die "Services are not ready. Run: anything-obsidian logs"

DASH_PORT="${PORT:-21502}"
if [ "$SERVER" -eq 1 ]; then DASH_PORT=21505; fi
if [ "$NO_BROWSER" -ne 1 ]; then
  if command -v open >/dev/null 2>&1; then open "http://localhost:$DASH_PORT" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$DASH_PORT" >/dev/null 2>&1 || true
  fi
fi
say ""
say "Installed and verified. Services run in the background."
say "  anything-obsidian start      ensure all services are running"
say "  anything-obsidian stop       stop now; keep autostart preference"
say "  anything-obsidian restart    restart and verify"
say "  anything-obsidian status     readiness and startup guarantee"
say "  anything-obsidian logs -f    follow logs"
say "To stop now and after future logins: autostart off, then stop."

#!/usr/bin/env bash
#
# ELIZA-AI installer — Linux & macOS.
#
# Installs / verifies:
#   1. Bun (v1.0+, required)
#   2. Ollama (optional but recommended — local LLM backend)
#   3. Project dependencies (bun install)
#   4. WhatsApp bridge dependencies (optional, needs Node 18+)
#   5. Default Ollama model (optional pull)
#   6. Smoke test (bun test)
#
# Usage:
#   ./install.sh [options]
#   curl -fsSL https://raw.githubusercontent.com/Sparky4567/eliza/main/install.sh | bash -s -- [options]
#
# Options:
#   --model NAME        Ollama model to pull (default: gemma2). Empty string skips the pull.
#   --no-ollama         Skip Ollama install + model pull (offline ELIZA-rules mode).
#   --with-whatsapp     Also install whatsapp_bridge dependencies (requires Node 18+).
#   --skip-tests        Skip the `bun test` smoke test.
#   -y, --yes           Non-interactive: accept defaults, never prompt.
#   -h, --help          Show this help and exit.
#
# Environment overrides:
#   ELIZA_MODEL         Same as --model.      OLLAMA_HOST  Ollama endpoint (default http://localhost:11434).
#   SKIP_OLLAMA=1       Same as --no-ollama.  WITH_WHATSAPP=1  Same as --with-whatsapp.
#   SKIP_TESTS=1        Same as --skip-tests.
#
set -euo pipefail

MODEL="${ELIZA_MODEL:-gemma2}"
INSTALL_OLLAMA=true
WITH_WHATSAPP=false
RUN_TESTS=true
ASSUME_YES=false
OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"

if [[ "${SKIP_OLLAMA:-}" == "1" ]]; then INSTALL_OLLAMA=false; fi
if [[ "${WITH_WHATSAPP:-}" == "1" ]]; then WITH_WHATSAPP=true; fi
if [[ "${SKIP_TESTS:-}" == "1" ]]; then RUN_TESTS=false; fi

usage() {
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed 's/^# \?//; /^set -euo pipefail$/d'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    --model=*) MODEL="${1#--model=}"; shift ;;
    --no-ollama) INSTALL_OLLAMA=false; shift ;;
    --with-whatsapp) WITH_WHATSAPP=true; shift ;;
    --skip-tests) RUN_TESTS=false; shift ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

# --- helpers ---------------------------------------------------------------
info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
  # confirm "prompt" — true if --yes or user answers y/yes.
  if [[ "$ASSUME_YES" == true ]]; then return 0; fi
  local reply
  read -r -p "$1 [Y/n] " reply || return 0
  [[ -z "$reply" || "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}

OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  *) die "Unsupported OS: $OS (Linux and macOS only)." ;;
esac

# Always run from the project root (dir containing package.json + src/index.ts).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$SCRIPT_DIR"
[[ -f package.json && -f src/index.ts ]] || die "Run from the eliza project root (package.json + src/index.ts not found in $SCRIPT_DIR)."

# Make Bun installed by this script visible in this shell.
export PATH="$HOME/.bun/bin:$PATH"

ver_ge() {
  # ver_ge HAVE WANT — true if dotted version HAVE >= WANT.
  local have="$1" want="$2"
  [[ "$(printf '%s\n%s\n' "$want" "$have" | sort -V | head -n1)" == "$want" ]]
}

# --- 1. Bun ----------------------------------------------------------------
info "Checking Bun (required, >= 1.0)…"
if command -v bun >/dev/null 2>&1; then
  BUN_VER="$(bun --version)"
  ver_ge "$BUN_VER" "1.0" || die "Bun $BUN_VER is too old — please upgrade to Bun >= 1.0 (https://bun.sh)."
  ok "Bun $BUN_VER"
else
  warn "Bun not found."
  confirm "Install Bun now via https://bun.sh (writes to ~/.bun)?" \
    || die "Bun is required. Install it from https://bun.sh/docs/installation then re-run ./install.sh."
  info "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash
  hash -r
  command -v bun >/dev/null 2>&1 || die "Bun install finished but 'bun' is not on PATH. Add ~/.bun/bin to PATH and re-run."
  ok "Bun $(bun --version) installed"
fi

# --- 2. Ollama (optional) ---------------------------------------------------
if [[ "$INSTALL_OLLAMA" == true ]]; then
  info "Checking Ollama (optional LLM backend)…"
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama present ($(ollama --version 2>/dev/null | head -n1))"
  else
    if confirm "Install Ollama now? (skippable — bot falls back to ELIZA rules offline)"; then
      info "Installing Ollama…"
      if [[ "$OS" == "Linux" ]]; then
        curl -fsSL https://ollama.com/install.sh | sh \
          || warn "Automatic Ollama install failed — install manually from https://ollama.com/download"
      else
        if command -v brew >/dev/null 2>&1; then
          brew install --cask ollama || brew install ollama \
            || warn "brew install failed — download Ollama from https://ollama.com/download"
        else
          warn "No Homebrew found — download Ollama from https://ollama.com/download and re-run ./install.sh"
        fi
      fi
      command -v ollama >/dev/null 2>&1 && ok "Ollama installed" || warn "Continuing without Ollama (offline ELIZA mode)."
    else
      warn "Skipping Ollama — bot will run in offline ELIZA-rules mode."
    fi
  fi
else
  info "Skipping Ollama (--no-ollama). Bot will run in offline ELIZA-rules mode."
fi

# --- 3. Project dependencies -------------------------------------------------
info "Installing project dependencies (bun install)…"
bun install
ok "Project dependencies installed"

# --- 4. WhatsApp bridge (optional) -------------------------------------------
if [[ "$WITH_WHATSAPP" == true ]]; then
  info "Installing WhatsApp bridge dependencies…"
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js not found — the Baileys bridge needs Node 18+. Install Node (https://nodejs.org) and re-run with --with-whatsapp."
  fi
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$NODE_MAJOR" -ge 18 ]] || die "Node $NODE_MAJOR too old — Baileys needs Node >= 18."
  bun install --cwd whatsapp_bridge
  ok "WhatsApp bridge dependencies installed"
else
  info "Skipping WhatsApp bridge deps (re-run with --with-whatsapp, or: bun run whatsapp:install)."
fi

# --- 5. Ollama model ----------------------------------------------------------
ollama_up() {
  # True if the Ollama API answers (server already running).
  curl -fsS --max-time 3 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1
}

if [[ "$INSTALL_OLLAMA" == true && -n "$MODEL" ]] && command -v ollama >/dev/null 2>&1; then
  info "Ensuring Ollama is serving + model '$MODEL'…"
  if ! ollama_up; then
    info "Starting 'ollama serve' in the background…"
    if [[ "$OS" == "Darwin" ]] && [[ -d "/Applications/Ollama.app" ]]; then
      open -a Ollama 2>/dev/null || true
    else
      nohup ollama serve >ollama.log 2>&1 &
      disown 2>/dev/null || true
    fi
    for _ in $(seq 1 15); do ollama_up && break; sleep 1; done
  fi
  if ollama_up; then
    if ollama list 2>/dev/null | grep -q "^$MODEL[[:space:]]"; then
      ok "Model '$MODEL' already present"
    else
      info "Pulling model '$MODEL' (one-time download, may take a while)…"
      ollama pull "$MODEL" || warn "Could not pull '$MODEL' — pick another via 'ollama pull <name>' or /model later."
    fi
  else
    warn "Ollama server is not reachable at $OLLAMA_HOST — start it with 'ollama serve', then 'ollama pull $MODEL'."
  fi
elif [[ -z "$MODEL" ]]; then
  info "Skipping model pull (empty --model). The bot auto-detects any local model on startup."
fi

# --- 6. Smoke test -------------------------------------------------------------
if [[ "$RUN_TESTS" == true ]]; then
  info "Running smoke test (bun test)…"
  bun test || die "Tests failed — see output above."
  ok "All tests pass"
else
  info "Skipping tests (--skip-tests)."
fi

# --- done ----------------------------------------------------------------------
echo
ok "ELIZA-AI is ready! Next steps:"
echo "    bun start                                   # CLI chat"
echo "    bun run web                                 # browser UI at http://localhost:3000"
echo "    TELEGRAM_TOKEN=<token> bun start            # + Telegram bridge"
echo "    bun run src/index.ts --web --whatsapp       # + WhatsApp bridge (needs --with-whatsapp + QR scan)"
echo
echo "  Keep Ollama running for LLM replies ('ollama serve'); without it the bot"
echo "  falls back to offline ELIZA rules. Switch models live with /model."

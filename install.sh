#!/bin/bash
# HIVE installer — run once after cloning the repo.
# Usage: ./install.sh [--name "Your Name"]
#
# What it does:
#   1. Checks prerequisites (bun, claude)
#   2. Installs dependencies
#   3. Builds hive and hive-mcp binaries
#   4. Runs `hive init` (scaffolds ~/.hive, installs agents, skills, scripts, launchd jobs)
#   5. Prints next steps

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

# --- Colors (if terminal supports them) ---
if [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  GREEN='\033[32m'
  YELLOW='\033[33m'
  RED='\033[31m'
  RESET='\033[0m'
else
  BOLD='' DIM='' GREEN='' YELLOW='' RED='' RESET=''
fi

info()  { echo -e "${BOLD}${GREEN}==>${RESET} $*"; }
warn()  { echo -e "${BOLD}${YELLOW}warning:${RESET} $*"; }
fail()  { echo -e "${BOLD}${RED}error:${RESET} $*" >&2; exit 1; }

# --- Parse args ---
NAME_ARG=""
for arg in "$@"; do
  case "$arg" in
    --name=*) NAME_ARG="${arg#--name=}" ;;
    --name)   shift; NAME_ARG="${1:-}" ;;
  esac
done

# --- Prerequisites ---
info "Checking prerequisites..."

if ! command -v bun &>/dev/null; then
  fail "bun is required but not installed. Install it: https://bun.sh"
fi
echo "  bun $(bun --version)"

if ! command -v claude &>/dev/null; then
  warn "claude CLI not found. HIVE works best with Claude Code installed."
  warn "Install it: https://docs.anthropic.com/en/docs/claude-code"
else
  echo "  claude CLI found"
fi

# --- Install dependencies ---
info "Installing dependencies..."
bun install

# --- Build binaries ---
info "Building binaries..."
bun build src/cli.ts --compile --outfile hive-bin
bun build src/mcp-server.ts --compile --outfile hive-mcp
chmod +x hive-bin hive-mcp

# --- Run hive init ---
info "Running hive init..."
INIT_ARGS=()
if [ -n "$NAME_ARG" ]; then
  INIT_ARGS+=("--name=$NAME_ARG")
fi
bun run src/cli.ts init "${INIT_ARGS[@]}"

# --- Verify PATH ---
echo
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  warn "\$HOME/.local/bin is not in your PATH."
  echo "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
  echo
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo
fi

# --- Summary ---
echo
info "HIVE installed."
echo
echo -e "  ${DIM}Repo:${RESET}      $REPO_DIR"
echo -e "  ${DIM}Home:${RESET}      ~/.hive"
echo -e "  ${DIM}Binary:${RESET}    ~/.local/bin/hive"
echo -e "  ${DIM}MCP:${RESET}       ~/.local/bin/hive-mcp"
echo -e "  ${DIM}Agents:${RESET}    ~/.claude/agents/maya-*.md"
echo -e "  ${DIM}Skills:${RESET}    ~/.claude/skills/hive-status/"
echo
echo -e "${BOLD}Next steps:${RESET}"
echo "  1. Edit ~/.hive/SELF.md    — tell the AI who you are"
echo "  2. Edit ~/.hive/IDENTITY.md — shape who the AI is"
echo "  3. Edit ~/.hive/config.md  — configure model providers"
echo "  4. Register a project:       hive project add <name> <path>"
echo "  5. Start a session:          hive"
echo
echo -e "${DIM}Launchd jobs (heartbeat, nightly, morning, sync) are installed and running.${RESET}"
echo -e "${DIM}To manage them: launchctl list | grep hive${RESET}"

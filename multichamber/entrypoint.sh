#!/bin/sh
# MultiChamber container entrypoint: one user, one home folder, one OpenChamber server.
set -eu

: "${HOME:=/home/dev}"
export HOME

if [ -z "${MULTICHAMBER_LLM_BASE_URL:-}" ] || [ -z "${MULTICHAMBER_LLM_KEY:-}" ]; then
  echo "[multichamber] MULTICHAMBER_LLM_BASE_URL and MULTICHAMBER_LLM_KEY must be set" >&2
  exit 1
fi

# Every folder the UI can browse, open or change stays inside the user's home.
MULTICHAMBER_FS_ROOT="${MULTICHAMBER_FS_ROOT:-$HOME}"
export MULTICHAMBER_FS_ROOT

# The chats root must exist before the UI scopes OpenCode to it, or every
# directory-scoped OpenCode call for "chats" fails with 500.
mkdir -p "$HOME/projects" "$HOME/.config/openchamber/chats" "$HOME/.local/share" "$HOME/.cache"
cd "$HOME/projects"

exec bun /opt/multichamber/packages/web/bin/cli.js serve --foreground --port "${MULTICHAMBER_PORT:-3000}"

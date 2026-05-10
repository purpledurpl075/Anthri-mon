#!/usr/bin/env bash
# Start the Vite dev server for the Anthrimon frontend.
# Dev only — production uses a static build served by Nginx.
# Usage: ./dev-frontend.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="${REPO_DIR}/frontend/dashboard"

if [[ ! -d "${FRONTEND_DIR}/node_modules" ]]; then
    echo "node_modules not found — running npm install..."
    npm --prefix "${FRONTEND_DIR}" install
fi

exec npm --prefix "${FRONTEND_DIR}" run dev -- --host

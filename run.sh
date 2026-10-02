#!/usr/bin/env bash
# Create the venv on first run, then start the server at http://localhost:8765
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/uvicorn backend.app.main:app --host 127.0.0.1 --port "${PORT:-8765}"

#!/usr/bin/env bash
# Assemble the static, browser-only site into dist/ (shares spider.js + style.css with the server UI).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp web/index.html web/app.js web/crawler.js web/store.js web/web.css dist/
cp frontend/spider.js frontend/style.css dist/
cat > dist/_headers <<'H'
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
H
echo "built dist/: $(ls dist | tr '\n' ' ')"

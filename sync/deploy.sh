#!/usr/bin/env bash
# One-time setup of the sync server (Cloudflare Worker + KV), then turns sync on in the page.
# Needs a Cloudflare login first: npx wrangler login
set -euo pipefail
cd "$(dirname "$0")"
npx --yes wrangler whoami >/dev/null

if [ ! -f wrangler.toml ]; then
  out=$(npx --yes wrangler kv namespace create CHART_SYNC 2>&1) || { echo "$out"; exit 1; }
  id=$(echo "$out" | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$id" ] || { echo "could not read KV id:"; echo "$out"; exit 1; }
  cat > wrangler.toml <<EOF
name = "chart-sync"
main = "worker.js"
compatibility_date = "2026-10-01"

[[kv_namespaces]]
binding = "KV"
id = "$id"
EOF
fi

out=$(npx --yes wrangler deploy 2>&1) || { echo "$out"; exit 1; }
url=$(echo "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$url" ] || { echo "could not read worker URL:"; echo "$out"; exit 1; }
echo "worker: $url"

cd ..
sed -i "s#^const SYNC_URL = '[^']*';#const SYNC_URL = '$url';#" index.html
grep -n "^const SYNC_URL" index.html

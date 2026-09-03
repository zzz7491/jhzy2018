#!/usr/bin/env bash
set -e
cd "E:/D盘备份/miniprogram/workers"
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
exec "$NODE" node_modules/wrangler/bin/wrangler.mjs dev --port 8796 --local

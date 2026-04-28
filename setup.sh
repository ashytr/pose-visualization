#!/usr/bin/env bash
# 下载前端依赖（Three.js），保存到 public/ 供离线/Qt 环境使用
set -e
THREE_VERSION="0.156.1"
DEST="public/three.min.js"
URL="https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.min.js"

echo "Downloading Three.js ${THREE_VERSION} -> ${DEST}"
curl -fsSL "${URL}" -o "${DEST}"
echo "Done. $(wc -c < "${DEST}") bytes written."

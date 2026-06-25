#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "→ building docker image..."
IMAGE_ID=$(docker build -q "$DIR")

echo "→ compiling plugin..."
docker run --rm \
  -v "$DIR:/plugin" \
  "$IMAGE_ID" \
  sh -c "cd /plugin && npm install && npm run build"

echo "→ removing image..."
docker rmi "$IMAGE_ID" > /dev/null

echo "done → main.js"

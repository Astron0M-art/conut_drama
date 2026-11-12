#!/usr/bin/env bash
# 在服务器 Git 目录运行；保留私有配置，仅允许快进更新。
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
if [ -n "$(git status --porcelain)" ]; then
  echo "服务器有未提交改动，请先处理后再更新。" >&2
  exit 1
fi
[ "$(git branch --show-current)" = main ] || { echo "请先切换到 main 分支。" >&2; exit 1; }
git pull --ff-only origin main
bash "$APP_DIR/deploy/install.sh"

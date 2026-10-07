#!/bin/bash
# 把你自己的动画做成形象包：./tools/make-avatar.sh <素材目录> --name "我的狗"
# 参数见 ./tools/make-avatar.sh --help
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v uv >/dev/null 2>&1 || { echo "需要 uv：brew install uv"; exit 1; }
exec uv run --quiet --with pillow --with numpy --with opencv-python-headless "$HERE/make-avatar.py" "$@"

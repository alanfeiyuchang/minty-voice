#!/bin/bash
# 把你自己的动画做成形象包：./tools/make-avatar.sh <素材文件夹> --name "我的狗"
# 参数见 ./tools/make-avatar.sh --help（Windows 用 tools\make-avatar.cmd）
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
UV="$(command -v uv || true)"; [ -n "$UV" ] || UV="$HOME/.local/bin/uv"
[ -x "$UV" ] || { echo "需要 uv：运行 ./setup.sh，或者 https://docs.astral.sh/uv/ 装一个"; exit 1; }
exec "$UV" run --quiet --with "pillow>=11.3" --with numpy --with opencv-python-headless "$HERE/make-avatar.py" "$@"

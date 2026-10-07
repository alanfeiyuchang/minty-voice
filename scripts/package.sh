#!/bin/bash
# 打一个可以分发的 zip：dist/minty-voice-<版本>.zip，内容是最近一次提交里的文件（git archive），
# 和 clone 仓库得到的一样。别人解压后运行 ./setup.sh。
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "这里还不是 git 仓库"; exit 1; }
[ -z "$(git status --porcelain)" ] || echo "注意：有没提交的改动，zip 里不会有它们"
VERSION="$(/usr/bin/python3 -c 'import json; print(json.load(open(".claude-plugin/plugin.json"))["version"])')"
NAME="minty-voice-$VERSION"
mkdir -p dist
git archive --format=zip --prefix="$NAME/" -o "dist/$NAME.zip" HEAD
echo "好了：$SRC/dist/$NAME.zip（$(du -h "dist/$NAME.zip" | cut -f1)）"

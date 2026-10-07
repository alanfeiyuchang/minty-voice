#!/bin/bash
# 语音助手一键安装（macOS）：起名字 → 选形象 → 选快捷键和声音 → 装依赖 → 接进 Claude Code
#
#   ./setup.sh                 一问一答地装（再跑一次就是改设置：名字、形象…）
#   ./setup.sh --yes           全用默认值，不问
#   ./setup.sh --name 小橘 --command xiaoju --avatar cat --key right-option --model turbo --yes
#   ./setup.sh --uninstall     从 Claude Code 里卸掉（设置和自己做的形象留在 ~/.claude/minty）
#
# 设置写在 ~/.claude/minty/config.json，之后在面板的“⚙ 设置”里改也是改它。
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$ROOT/plugin/.claude-plugin/plugin.json" ]; then
  PLUGIN_DIR="$ROOT/plugin"   # 旧的打包格式：插件在 plugin/
else
  PLUGIN_DIR="$ROOT"          # 仓库根目录既是 marketplace 也是插件
fi
DATA_DIR="$HOME/.claude/minty"
CONFIG="$DATA_DIR/config.json"
MODEL_DIR="$HOME/.whisper"
SETTINGS="$HOME/.claude/settings.json"
MARKETPLACE=minty
PLUGIN_ID=minty

bold() { printf '\033[1m%s\033[0m' "$1"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

# ---------- 参数 ----------
YES=0; UNINSTALL=0
NAME=""; COMMAND=""; AVATAR=""; KEY=""; MODEL=""; VOICE=""; LANG_CHOICE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --name) NAME="$2"; shift ;;
    --command) COMMAND="$2"; shift ;;
    --avatar) AVATAR="$2"; shift ;;
    --key) KEY="$2"; shift ;;
    --model) MODEL="$2"; shift ;;
    --voice) VOICE="$2"; shift ;;
    --language) LANG_CHOICE="$2"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "不认识的参数：$1（./setup.sh --help 看用法）" ;;
  esac
  shift
done

[ "$(uname -s)" = Darwin ] || die "目前只支持 macOS（录音用 sox、朗读用 afplay/say、快捷键用 macOS 的事件监听）"

# 问一句，回车用默认值；--yes 时直接用默认值
ask() { # ask <提示> <默认值> → $REPLY
  if [ "$YES" = 1 ]; then REPLY="$2"; return; fi
  printf '%s %s ' "$1" "$(printf '\033[2m[%s]\033[0m' "$2")"
  read -r REPLY </dev/tty || REPLY=""
  [ -n "$REPLY" ] || REPLY="$2"
}
# 从编号列表里选一个：choose <提示> <默认编号> 选项1 选项2 … → $REPLY = 选中的编号（从 1 开始）
choose() {
  local prompt="$1" def="$2" i=1; shift 2
  if [ "$YES" = 1 ]; then REPLY="$def"; return; fi
  echo "$prompt"
  for o in "$@"; do printf '  %d) %s\n' "$i" "$o"; i=$((i + 1)); done
  while true; do
    printf '选哪个？ \033[2m[%s]\033[0m ' "$def"
    read -r REPLY </dev/tty || REPLY=""
    [ -n "$REPLY" ] || REPLY="$def"
    case "$REPLY" in ''|*[!0-9]*) ;; *) [ "$REPLY" -ge 1 ] && [ "$REPLY" -le $# ] && return ;; esac
    echo "  输入 1 到 $# 之间的数字"
  done
}

# python3 用来读写 JSON；没有命令行工具时 /usr/bin/python3 会弹安装框
need_clt() {
  if ! xcode-select -p >/dev/null 2>&1; then
    warn "需要 Xcode 命令行工具（python3、swiftc 都在里面）。弹出的窗口里点“安装”，装完再运行一次 ./setup.sh"
    xcode-select --install >/dev/null 2>&1 || true
    exit 1
  fi
}

# ---------- 卸载 ----------
if [ "$UNINSTALL" = 1 ]; then
  step "从 Claude Code 里卸载"
  if command -v claude >/dev/null 2>&1; then
    claude plugin uninstall "$PLUGIN_ID@$MARKETPLACE" >/dev/null 2>&1 && ok "卸掉了插件" || true
    claude plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 && ok "移除了 marketplace" || true
  fi
  if [ -f "$SETTINGS" ] && grep -q "$PLUGIN_DIR" "$SETTINGS"; then
    need_clt
    /usr/bin/python3 - "$SETTINGS" "$PLUGIN_DIR" <<'PY'
import json, sys
path, mod = sys.argv[1:3]
data = json.load(open(path))
env = data.get("env", {})
dirs = [d for d in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if d and d != mod]
if dirs: env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
else: env.pop("CLAUDE_CODE_PLUGIN_DIRS", None)
json.dump(data, open(path, "w"), indent=2, ensure_ascii=False); open(path, "a").write("\n")
PY
    ok "从 settings.json 的 CLAUDE_CODE_PLUGIN_DIRS 里去掉了"
  fi
  echo "设置和自己做的形象还在 $DATA_DIR，不要了就删掉这个文件夹。重启 Claude Code 生效。"
  exit 0
fi

need_clt

# 读已有设置（再跑一次 setup 时用它当默认值）
cfg_get() { /usr/bin/python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))
except Exception: print("")' "$CONFIG" "$1"; }

cat <<EOF

$(bold "给 Claude Code 装一个会听会说的语音助手")
点它的形象、或者在任何 App 里按住一个键说话（中英混说都行），它在本地听写、整理成清晰的指令发给
Claude Code；Claude 做完，它用语音念一句总结。下面先给它起个名字、挑个样子。

EOF

# ---------- 1. 名字和命令 ----------
step "1/5 起个名字"
[ -n "$NAME" ] || { ask "它叫什么？（中文英文都行）" "$(cfg_get name | sed 's/^$/MINTY/')"; NAME="$REPLY"; }
NAME="$(printf '%s' "$NAME" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
[ -n "$NAME" ] || NAME=MINTY
[ ${#NAME} -le 24 ] || die "名字太长了（最多 24 个字）"
# 默认命令：名字里的英文小写；名字是中文就沿用以前的或 minty
GUESS="$(printf '%s' "$NAME" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C tr -c 'a-z0-9-' '-' | sed 's/--*/-/g;s/^-*//;s/-*$//' | cut -c1-24)"
case "$GUESS" in [a-z]*) ;; *) GUESS="$(cfg_get command)"; [ -n "$GUESS" ] || GUESS=minty ;; esac
while [ -z "$COMMAND" ] || ! printf '%s' "$COMMAND" | grep -Eq '^[a-z][a-z0-9-]{0,23}$'; do
  [ -z "$COMMAND" ] || warn "命令只能用小写英文、数字和 -，而且以字母开头"
  ask "斜杠命令叫什么？（输入 /名字 来召唤它）" "$GUESS"; COMMAND="$REPLY"
  [ "$YES" = 1 ] && ! printf '%s' "$COMMAND" | grep -Eq '^[a-z][a-z0-9-]{0,23}$' && die "--command 不合法：$COMMAND"
done
ok "名字 $NAME，命令 /$COMMAND"

# ---------- 2. 形象 ----------
step "2/5 选个形象"
IDS=(); LABELS=()
for base in "$PLUGIN_DIR/avatars" "$DATA_DIR/avatars"; do
  [ -d "$base" ] || continue
  for d in "$base"/*/; do
    [ -f "$d/idle.avif" ] || [ -f "$d/idle.webp" ] || [ -f "$d/idle.gif" ] || [ -f "$d/idle.png" ] || [ -f "$d/idle.svg" ] || continue
    id="$(basename "$d")"
    label="$(/usr/bin/python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("name") or sys.argv[2])
except Exception: print(sys.argv[2])' "$d/pack.json" "$id")"
    IDS+=("$id"); LABELS+=("$label（$id）")
  done
done
IDS+=("orb"); LABELS+=("光球（会转的发光小球，不用图片）")
IDS+=("__make__"); LABELS+=("用我自己的动画做一个（给一个放视频/GIF 的文件夹）")
if [ -z "$AVATAR" ]; then
  cur="$(cfg_get avatar)"; [ -n "$cur" ] || cur=cat
  def=1; for i in "${!IDS[@]}"; do [ "${IDS[$i]}" = "$cur" ] && def=$((i + 1)); done
  choose "面板里画什么？" "$def" "${LABELS[@]}"
  AVATAR="${IDS[$((REPLY - 1))]}"
fi
if [ "$AVATAR" = "__make__" ]; then
  cat <<EOF
  准备一个文件夹，每个状态放一段动画（视频、GIF 都行），只有 idle 是必须的：
    idle 待命   listen 在听   think 在想   wait 等你确认   speak 在说话
  例如：~/Desktop/my-dog/idle.mp4、~/Desktop/my-dog/listen.gif …
  纯色背景（绿幕、蓝幕、白底）会自动抠掉；本来就透明的直接用。
EOF
  while true; do
    ask "素材文件夹在哪？" ""
    SRC="${REPLY/#\~/$HOME}"
    [ -d "$SRC" ] && break
    warn "找不到文件夹：$REPLY"
  done
  ask "这个形象叫什么？" "$(basename "$SRC")"; PACK_NAME="$REPLY"
  for pkg in ffmpeg libavif uv; do
    bin=$pkg; [ $pkg = libavif ] && bin=avifenc
    command -v $bin >/dev/null 2>&1 || { command -v brew >/dev/null 2>&1 || die "需要 Homebrew：https://brew.sh"; brew install $pkg; }
  done
  OUT="$("$ROOT/tools/make-avatar.sh" "$SRC" --name "$PACK_NAME" | tee /dev/stderr | sed -n 's/^好了：//p')"
  [ -n "$OUT" ] || die "形象没做出来，看上面的报错"
  AVATAR="$(basename "$OUT")"
fi
ok "形象 $AVATAR"

# ---------- 3. 快捷键 ----------
step "3/5 按住说话的键"
KEYS=(right-option right-command right-control fn off)
if [ -z "$KEY" ]; then
  cur="$(cfg_get pttKey)"; def=1; for i in "${!KEYS[@]}"; do [ "${KEYS[$i]}" = "$cur" ] && def=$((i + 1)); done
  choose "在任何 App 里按住它就开始录音，松开发出（只监听不拦截，键照常能用）：" "$def" \
    "右 Option（推荐，几乎不和别的快捷键冲突）" "右 Command" "右 Control" "Fn / 🌐（要先在系统设置→键盘里把“按下 🌐 键时”改成“无操作”）" "不要快捷键，只点形象"
  KEY="${KEYS[$((REPLY - 1))]}"
fi
case " ${KEYS[*]} " in *" $KEY "*) ;; *) die "--key 只能是 ${KEYS[*]}" ;; esac
ok "快捷键 $KEY"

# ---------- 4. 声音和听写 ----------
step "4/5 声音和听写"
VOICES=(zh-CN-XiaoxiaoNeural zh-CN-YunxiNeural zh-CN-XiaoyiNeural zh-CN-YunyangNeural say)
if [ -z "$VOICE" ]; then
  cur="$(cfg_get edgeVoice)"; [ "$(cfg_get ttsEngine)" = say ] && cur=say
  def=1; for i in "${!VOICES[@]}"; do [ "${VOICES[$i]}" = "$cur" ] && def=$((i + 1)); done
  choose "它用什么声音说话？（前四个是微软的神经网络声音，需联网，念的话会发到微软语音服务）" "$def" \
    "晓晓 · 女声温和" "云希 · 男声阳光" "晓伊 · 女声活泼" "云扬 · 男声播音腔" "macOS 自带的 say（离线，比较机械）"
  VOICE="${VOICES[$((REPLY - 1))]}"
fi
LANGS=(zh auto en)
if [ -z "$LANG_CHOICE" ]; then
  choose "你平时怎么说？" 1 "中文为主，夹英文技术词（最稳）" "中英都有，让它自己判断" "英文"
  LANG_CHOICE="${LANGS[$((REPLY - 1))]}"
fi
MODELS=(turbo small base)
if [ -z "$MODEL" ]; then
  choose "听写模型（在你电脑上跑，不上传录音）：" 1 \
    "large-v3-turbo · 1.6 GB · 最准，中英混说推荐" "small · 470 MB · 快一些，混说时英文词容易听错" "base · 140 MB · 最快最小，准确度一般"
  MODEL="${MODELS[$((REPLY - 1))]}"
fi
case "$MODEL" in
  turbo) MODEL_FILE=ggml-large-v3-turbo.bin ;;
  small) MODEL_FILE=ggml-small.bin ;;
  base) MODEL_FILE=ggml-base.bin ;;
  *) die "--model 只能是 turbo / small / base" ;;
esac
ok "声音 $VOICE，语言 $LANG_CHOICE，模型 $MODEL_FILE"

# ---------- 5. 安装 ----------
step "5/5 安装"
command -v brew >/dev/null 2>&1 || die "需要 Homebrew：先按 https://brew.sh 装好，再运行一次 ./setup.sh"
for pkg in sox whisper-cpp; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then ok "$pkg 已安装"; else brew install "$pkg"; fi
done
if [ "$VOICE" != say ]; then
  if command -v edge-tts >/dev/null 2>&1 || [ -x "$HOME/.local/bin/edge-tts" ]; then ok "edge-tts 已安装"
  else
    command -v uv >/dev/null 2>&1 || brew install uv
    uv tool install edge-tts
  fi
fi

mkdir -p "$MODEL_DIR"
if [ -s "$MODEL_DIR/$MODEL_FILE" ]; then ok "模型已在 $MODEL_DIR/$MODEL_FILE"
else
  echo "  下载 $MODEL_FILE …"
  curl -L --fail --progress-bar -o "$MODEL_DIR/$MODEL_FILE.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE" \
    && mv "$MODEL_DIR/$MODEL_FILE.part" "$MODEL_DIR/$MODEL_FILE"
fi

if [ "$KEY" != off ]; then
  if swiftc -O "$PLUGIN_DIR/ptt/minty-ptt.swift" -o "$PLUGIN_DIR/ptt/minty-ptt" 2>/dev/null; then ok "快捷键监听程序编好了"
  else warn "快捷键监听程序没编出来；之后它第一次启动时会再试"; fi
fi

# 写设置：只改这次问到的项，别的（面板里改过的）留着
mkdir -p "$DATA_DIR/avatars"
/usr/bin/python3 - "$CONFIG" "$NAME" "$COMMAND" "$AVATAR" "$KEY" "$VOICE" "$LANG_CHOICE" "$MODEL_DIR/$MODEL_FILE" <<'PY'
import json, os, sys
path, name, command, avatar, key, voice, lang, model = sys.argv[1:]
cfg = {}
if os.path.exists(path):
    try: cfg = json.load(open(path))
    except Exception: pass
cfg.update(name=name, command=command, avatar=avatar, pttKey=key, language=lang, whisperModel=model.replace(os.path.expanduser("~"), "~", 1))
if voice == "say": cfg["ttsEngine"] = "say"
else: cfg.update(ttsEngine="edge", edgeVoice=voice)
json.dump(cfg, open(path, "w"), indent=2, ensure_ascii=False); open(path, "a").write("\n")
PY
ok "设置写进了 $CONFIG"

# 同一台机器上已经从别的文件夹加载了这个插件（比如开发目录）：再装一份会加载两遍
if [ -f "$SETTINGS" ]; then
  OTHER="$(/usr/bin/python3 - "$SETTINGS" "$PLUGIN_DIR" <<'PY'
import json, os, sys
try: dirs = json.load(open(sys.argv[1])).get("env", {}).get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":")
except Exception: dirs = []
for d in dirs:
    m = os.path.join(d, ".claude-plugin", "plugin.json")
    if d and os.path.realpath(d) != os.path.realpath(sys.argv[2]) and os.path.exists(m):
        try:
            if json.load(open(m)).get("name") == "minty": print(d)
        except Exception: pass
PY
)"
  [ -z "$OTHER" ] || warn "settings.json 的 CLAUDE_CODE_PLUGIN_DIRS 里已经有一份：$OTHER。两份都会加载，留一份就好（删掉那一项，或者在那个文件夹里运行 ./setup.sh）"
fi

# 接进 Claude Code：有 claude 命令就装成插件（读的就是这个文件夹，改了 /reload-plugins 就生效）；
# 只用桌面版、没有 claude 命令时，写进 settings.json 的 CLAUDE_CODE_PLUGIN_DIRS
already_dirs=0
[ -f "$SETTINGS" ] && grep -q "CLAUDE_CODE_PLUGIN_DIRS" "$SETTINGS" && grep -qF "$PLUGIN_DIR" "$SETTINGS" && already_dirs=1
if [ "$already_dirs" = 1 ]; then
  ok "Claude Code 已经从 $PLUGIN_DIR 加载它（settings.json 的 CLAUDE_CODE_PLUGIN_DIRS）"
elif command -v claude >/dev/null 2>&1 && [ -f "$ROOT/.claude-plugin/marketplace.json" ]; then
  claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE" || claude plugin marketplace add "$ROOT" >/dev/null
  if claude plugin list 2>/dev/null | grep -q "$PLUGIN_ID@$MARKETPLACE"; then ok "插件已安装（$PLUGIN_ID@$MARKETPLACE）"
  else claude plugin install "$PLUGIN_ID@$MARKETPLACE" --scope user -y >/dev/null && ok "装成了 Claude Code 插件（$PLUGIN_ID@$MARKETPLACE）"; fi
else
  mkdir -p "$HOME/.claude"
  [ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak-voice"
  /usr/bin/python3 - "$SETTINGS" "$PLUGIN_DIR" <<'PY'
import json, os, sys
path, mod = sys.argv[1:3]
data = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) else {}
env = data.setdefault("env", {})
dirs = [d for d in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if d]
if mod not in dirs: dirs.append(mod)
env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
json.dump(data, open(path, "w"), indent=2, ensure_ascii=False); open(path, "a").write("\n")
PY
  ok "写进了 $SETTINGS（CLAUDE_CODE_PLUGIN_DIRS），终端和桌面版都会加载"
fi

# 打个招呼
if [ "$YES" != 1 ]; then
  HELLO="你好，我是 $NAME，装好了。按住快捷键或者点我，就可以跟我说话。"
  EDGE="$(command -v edge-tts || echo "$HOME/.local/bin/edge-tts")"
  TMP="${TMPDIR:-/tmp}/voice-setup-$$.mp3"
  if [ "$VOICE" != say ] && [ -x "$EDGE" ] && "$EDGE" --voice="$VOICE" --text="$HELLO" --write-media="$TMP" >/dev/null 2>&1; then
    afplay "$TMP"; rm -f "$TMP"
  else
    say "$HELLO" 2>/dev/null || true
  fi
fi

cat <<EOF

$(bold "✅ 装好了。")
  1. 重启 Claude Code（终端里重新运行 claude；桌面版重开 Code 标签页）。
     对话旁边会出现 $NAME 的面板。窗口太窄放不下时，输入 /$COMMAND panel 打开。
  2. 输入 /$COMMAND check 确认依赖都是 ✓。
  3. 第一次录音 macOS 会要麦克风权限，点“允许”。
$( [ "$KEY" != off ] && echo "  4. 按住快捷键没反应：系统设置 → 隐私与安全性 → 输入监控，打开 Claude（或你用的终端），再重启它。" )

  想换名字、形象、声音：再运行一次 ./setup.sh，或者在面板里点“⚙ 设置”。
  做自己的形象：./tools/make-avatar.sh <素材文件夹> --name "名字"（说明见 README）。
EOF

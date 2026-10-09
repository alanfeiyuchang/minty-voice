#!/usr/bin/env python3
"""把你自己的动画做成 MINTY 的形象包（一套状态动画），换掉默认的猫。

用法（视频素材要有 ffmpeg；Python 依赖用 uv 临时装）：
  uv run --with pillow --with numpy --with opencv-python-headless tools/make-avatar.py <素材目录> --name "我的狗"
  或者：./tools/make-avatar.sh <素材目录> --name "我的狗"

素材目录里每个状态放一段动画，只有 idle 是必须的，缺的状态用 idle 代替：
  idle    待命        listen  在听你说话      think  在想 / Claude 在干活
  wait    等你确认    speak   在说话
待命还可以有几段“变化”，名字以 idle- 开头（idle-yawn.mp4、idle-groom/ …）：平时放 idle，
隔一会儿随机插播一段变化，播完一遍接回 idle。变化片段要以 idle 的姿势开头、也以它结尾（做完一件小事回到原样），
所以它们只正着放一遍，不做正放 + 倒放。
每个状态可以是：
  - 一段视频或 GIF：idle.mp4 / idle.mov / idle.webm / idle.gif …
  - 或者一个装满逐帧图片的文件夹：idle/0001.png、idle/0002.png …（按文件名排序）

背景（--background）：
  auto         默认。图片本身带透明就直接用；否则当作纯色背景（绿幕、蓝幕、白底都行）抠掉，
               背景色取画面四条边的中位数
  transparent  素材已经是透明的（带 alpha 的 PNG、ProRes 4444、带透明的 WebM）
  keep         不抠图，整张画面原样缩进方框里（做成卡片、头像框的样子）

出来的是一个文件夹：<输出目录>/<id>/pack.json + 每个状态一段 320px 的动画 AVIF（idle.avif …）。默认输出到 ~/.claude/minty/avatars/，
MINTY 启动时会扫这里，设置里的“形象”就能选到它。

为什么是动画 AVIF：桌面版只能用 Svg 元素画图，一个 SVG 最多 128 KB；AVIF 有帧间压缩，
24 帧 320px 只要几十 KB，放在 SVG 的 <image> 里照样会动。太大时会自动降质量。
"""
import argparse, base64, io, json, re, shutil, subprocess, sys, tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

STATES = ['idle', 'listen', 'think', 'wait', 'speak']
VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.gif', '.mkv', '.avi', '.webp', '.apng']
IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp']
PX = 320  # 面板里画成 180px，按 2 倍屏留够分辨率
Q = 62
CAT_HEIGHT = 0.84  # 形象占画面高度的比例（所有状态一样）
FEET = 0.97  # 脚（形象的底边）踩在画面高度的这个位置
MAX_B64 = 125_000  # 一个 SVG 最多 131072 个字符，留点给外壳
FPS = 8


def key_out(img: Image.Image) -> Image.Image:
    """按背景色距离抠图（背景色取四条边的中位数），收边 1px 再轻微羽化，最后做颜色去污：
    半透明边缘像素的颜色换成离它最近的“实心猫”像素的颜色——边上一点背景色都不留，
    不会再有一圈蓝绿色的边。"""
    a = np.asarray(img.convert('RGB')).astype(np.float32) / 255
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    bg = np.median(border, axis=0)
    dist = np.linalg.norm(a - bg, axis=-1)
    alpha = np.clip((dist - 0.16) / 0.20, 0, 1)
    alpha = cv2.erode(alpha, np.ones((3, 3), np.uint8))
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0.6)
    solid = (alpha > 0.98).astype(np.uint8)
    _, labels = cv2.distanceTransformWithLabels(1 - solid, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.where(solid == 1)
    nearest = np.zeros((labels.max() + 1, 3), np.float32)
    nearest[labels[ys, xs]] = a[ys, xs]
    rgb = np.where(solid[..., None] == 1, a, nearest[labels])
    return Image.fromarray((np.dstack([rgb, alpha]) * 255).astype(np.uint8), 'RGBA')


def layout(states: dict[str, list[Image.Image]]) -> dict:
    """所有状态用同一套摆法，切状态时猫不忽大忽小、不左右跳：
    - 大小：每个状态按猫的高度缩放到一样高（各段源视频里猫离镜头远近不同，不能共用一个缩放）
    - 水平：身体中线对准画面中线。身体中线取身体中段（从头顶往下 25%–65% 那几行，尾巴只在最下面）
      所有帧的中位数；不用整只猫的外框——尾巴甩到一边会把外框拉偏
    - 尾巴甩出画面时不把猫往里推（以前就是这样把身体推偏的），而是所有状态一起再缩小一点
    - 脚踩在 FEET 那条线上"""
    info = {}
    for name, frames in states.items():
        masks = [np.asarray(f)[..., 3] > 40 for f in frames]
        ys, xs = np.where(np.any(masks, 0))
        x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        h = y1 - y0
        band = slice(y0 + int(0.25 * h), y0 + int(0.65 * h))
        cx = float(np.median([np.where(m[band])[1].mean() for m in masks if m[band].any()]))
        info[name] = {'cx': cx, 'h': h, 'bottom': y1, 'half': max(cx - x0, x1 - cx)}
    # 统一的缩小系数：让每个状态最远的那一边（多半是尾巴）都留在画面 2% 的边距以内
    k = min(1.0, *(0.48 / (CAT_HEIGHT * v['half'] / v['h']) for v in info.values()))
    return {'info': info, 'k': k}


def normalized(frames: list[Image.Image], px: int, lay: dict, name: str) -> list[Image.Image]:
    """按 layout 的摆法缩放、摆放这个状态的每一帧（整段用同一个变换，帧和帧之间不动）。"""
    v = lay['info'][name]
    s = lay['k'] * CAT_HEIGHT * px / v['h']
    out = []
    for f in frames:
        big = f.resize((round(f.width * s), round(f.height * s)), Image.LANCZOS)
        canvas = Image.new('RGBA', (px, px))
        canvas.paste(big, (round(px / 2 - v['cx'] * s), round(FEET * px - v['bottom'] * s)), big)
        out.append(canvas)
    return out


def pingpong(frames: list[Image.Image]) -> list[Image.Image]:
    """正放一遍、紧接着倒放一遍：倒放的第一帧就是正放的最后一帧，倒放的最后一帧就是正放的第一帧，
    两处衔接都是相邻帧，不需要找相似帧或交叉淡化。首尾两帧不重复，免得在折返处停顿一拍。"""
    return frames + frames[-2:0:-1]


def avif(frames: list[Image.Image], q: int, fps: int = FPS) -> bytes:
    """动画 AVIF，用 Pillow 自带的 AVIF 编码（Pillow 11.3 起有，macOS / Linux / Windows 都不用另装东西）。"""
    buf = io.BytesIO()
    frames[0].save(buf, format='AVIF', save_all=True, append_images=frames[1:], duration=round(1000 / fps),
                   loop=0, quality=q, speed=4)
    return buf.getvalue()


def fit_whole(frames: list[Image.Image], px: int) -> list[Image.Image]:
    """--background keep：整张画面等比缩进方框，居中。"""
    out = []
    for f in frames:
        s = px / max(f.width, f.height)
        big = f.convert('RGBA').resize((round(f.width * s), round(f.height * s)), Image.LANCZOS)
        canvas = Image.new('RGBA', (px, px))
        canvas.paste(big, ((px - big.width) // 2, (px - big.height) // 2), big)
        out.append(canvas)
    return out


def read_state(src: Path, state: str, fps: int, src_fps: float, max_frames: int, work: Path) -> list[Image.Image] | None:
    """一个状态的帧：视频/GIF 用 ffmpeg 按 fps 抽帧；图片文件夹按 src_fps 隔帧取。"""
    folder = src / state
    if folder.is_dir():
        files = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXT)
        if not files:
            return None
        step = max(1, round(src_fps / fps))
        return [Image.open(f).convert('RGBA') for f in files[::step]][:max_frames]
    for ext in VIDEO_EXT:
        video = src / f'{state}{ext}'
        if video.exists():
            if not shutil.which('ffmpeg'):
                sys.exit('要处理视频 / GIF 得先装 ffmpeg（macOS：brew install ffmpeg；Linux：sudo apt install ffmpeg；Windows：winget install Gyan.FFmpeg）')
            out = work / state
            out.mkdir()
            subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-vf', f'fps={fps}', '-pix_fmt', 'rgba',
                            '-frames:v', str(max_frames), str(out / '%04d.png')], check=True)
            return [Image.open(f).convert('RGBA') for f in sorted(out.glob('*.png'))]
    return None


def has_alpha(frames: list[Image.Image]) -> bool:
    a = np.asarray(frames[0])[..., 3]
    return (a < 250).mean() > 0.02


def solid_background(frames: list[Image.Image]) -> bool:
    """画面四条边是不是差不多一个颜色（绿幕、蓝幕、白底）：边上像素和中位色的平均距离够小才抠。"""
    a = np.asarray(frames[0].convert('RGB')).astype(np.float32) / 255
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    return float(np.linalg.norm(border - np.median(border, axis=0), axis=-1).mean()) < 0.08


def encode_fitting(seq: list[Image.Image], render, fps: int) -> tuple[bytes, str]:
    """编成 AVIF 并保证 base64 后不超过 MAX_B64：先降质量；降到底还太大就隔帧去掉一半，再缩小尺寸。"""
    frames, px = seq, PX
    while True:
        sized = render(frames, px)
        for q in range(Q, 19, -6):
            data = avif(sized, q, fps)
            if len(base64.b64encode(data)) <= MAX_B64:
                return data, f'{len(frames)} 帧 {px}px q{q}'
        if len(frames) > 16:
            frames = frames[::2]
            fps = max(4, fps // 2)
        elif px > 160:
            px = int(px * 0.8)
        else:
            return data, f'{len(frames)} 帧 {px}px q{q}（还是太大，面板里会画光球；换段短一点、画面简单一点的素材）'


def slug(s: str) -> str:
    s = re.sub(r'[^A-Za-z0-9_-]+', '-', s).strip('-').lower()
    return s or 'avatar'


def main():
    ap = argparse.ArgumentParser(description='把你自己的动画做成 MINTY 的形象包', formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument('src', type=Path, help='素材目录：idle.mp4 / idle/ 逐帧 …')
    ap.add_argument('--name', help='形象的名字，显示在设置里（默认用目录名）')
    ap.add_argument('--id', help='文件夹名，只能英文数字和 -（默认从名字或目录名生成）')
    ap.add_argument('--out', type=Path, default=Path.home() / '.claude' / 'minty' / 'avatars', help='输出目录（默认 ~/.claude/minty/avatars）')
    ap.add_argument('--background', choices=['auto', 'transparent', 'keep'], default='auto')
    ap.add_argument('--loop', choices=['pingpong', 'forward'], default='pingpong',
                    help='pingpong：正放一遍再倒放一遍，首尾不用接得上（默认）；forward：素材本身就是首尾相接的循环')
    ap.add_argument('--fps', type=int, default=FPS, help='动画帧率（默认 8）')
    ap.add_argument('--src-fps', type=float, default=24, help='逐帧图片文件夹的原始帧率（默认 24，用来隔帧取）')
    ap.add_argument('--seconds', type=float, default=3, help='每个状态最多取几秒（默认 3；越长文件越大、画质越低）')
    a = ap.parse_args()

    from PIL import features
    if not features.check('avif'):
        sys.exit('这个 Pillow 不支持 AVIF：要 Pillow 11.3 或更新（用 tools/make-avatar.sh / .cmd 运行会自动装对的版本）')
    name = a.name or a.src.resolve().name
    pack_id = a.id or slug(a.name if a.name and slug(a.name) != 'avatar' else a.src.resolve().name)
    max_frames = max(2, round(a.seconds * a.fps))

    states: dict[str, list[Image.Image]] = {}
    # 待命的变化：idle-<随便什么>.mp4 或 idle-<随便什么>/ 文件夹
    variants = sorted({p.stem for p in a.src.iterdir() if p.name.startswith('idle-') and (p.is_dir() or p.suffix.lower() in VIDEO_EXT)})
    with tempfile.TemporaryDirectory() as work:
        for st in STATES + variants:
            frames = read_state(a.src, st, a.fps, a.src_fps, max_frames, Path(work))
            if frames:
                states[st] = frames
    if 'idle' not in states:
        sys.exit(f'{a.src} 里没找到 idle：放一个 idle.mp4（或 .gif/.mov…），或者 idle/ 文件夹装逐帧图片')

    mode = a.background
    if mode == 'auto':
        if has_alpha(states['idle']):
            mode = 'transparent'
        elif solid_background(states['idle']):
            mode = 'key'
        else:
            mode = 'keep'
            print('背景不是纯色，抠不干净：整张画面原样放进方框。想要只剩主角，就换绿幕/蓝幕/白底的素材，或者先自己抠成透明的')
    print(f'{name}（{pack_id}）：{", ".join(states)}；背景 {mode}')
    if mode == 'key':
        states = {st: [key_out(f) for f in fr] for st, fr in states.items()}
    lay = layout(states) if mode != 'keep' else None

    dst = a.out / pack_id
    dst.mkdir(parents=True, exist_ok=True)
    for old in dst.glob('*.avif'):
        old.unlink()
    durations = {}
    for st, frames in states.items():
        seq = pingpong(frames) if a.loop == 'pingpong' and not st.startswith('idle-') else frames
        render = (lambda fr, px: fit_whole(fr, px)) if lay is None else (lambda fr, px, st=st: normalized(fr, px, lay, st))
        data, how = encode_fitting(seq, render, a.fps)
        durations[st] = round(len(seq) / a.fps, 3)
        (dst / f'{st}.avif').write_bytes(data)
        print(f'  {st}.avif: {how} {len(data) // 1024} KB')
    # durations：每段放一遍多少秒（插件按它在一遍放完时切换待命的变化）
    (dst / 'pack.json').write_text(json.dumps({'name': name, 'version': 1, 'durations': durations}, ensure_ascii=False, indent=2) + '\n')
    print(f'好了：{dst}\n在助手面板的“⚙ 设置”里把“形象”换成「{name}」，或者重新运行 setup.sh 选它。')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""把 H3 生成的逐帧 PNG 做成桌宠动画：抠蓝幕 → 每个状态里的猫每个状态的猫缩放到一样高、身体中线对准画面中线、脚踩同一条线 → 正放 + 倒放 → 动画 AVIF，
写成 hooks/pet-sprites.ts（每个状态一段 base64），register.tsx 把它放进 SVG 显示。

为什么是动画 AVIF：桌面版只能用 Svg 元素画图，一个 SVG 最多 128 KB。逐帧 WebP 在 320px 下要 260 KB，
AVIF 有帧间压缩，24 帧 320px 只要 70 KB 左右，而且 Chromium 里放在 SVG 的 <image> 里照样会动。

用法：uv run --with pillow --with numpy --with opencv-python-headless pet/make_sprites.py pet/frames pet/sprites
  pet/frames/<状态>/*.png  ← 从 xps 的 ComfyUI/output/minty_pet 拷过来的 640×640 帧
依赖 avifenc（brew install libavif）。
"""
import base64, json, subprocess, sys, tempfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

FPS = 8  # 源视频 24 fps，每 3 帧取 1 帧；循环是正放一遍再倒放一遍（pingpong）
# 两套：小的给输入框上方那一格，大的给 MINTY 面板；每个状态的 SVG 不能超过 128 KB
SETS = {'small': {'px': 128, 'q': 62}, 'large': {'px': 320, 'q': 62}}
CAT_HEIGHT = 0.84  # 猫占画面高度的比例（所有状态一样）
FEET = 0.97  # 脚踩在画面高度的这个位置
MAX_B64 = 125_000


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


def avif(frames: list[Image.Image], q: int) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        names = []
        for i, f in enumerate(frames):
            p = Path(d) / f'f{i:02d}.png'
            f.save(p)
            names.append(str(p))
        out = Path(d) / 'out.avif'
        subprocess.run(['avifenc', '-q', str(q), '-s', '4', '--fps', str(FPS), '-j', 'all', *names, str(out)],
                       check=True, capture_output=True)
        return out.read_bytes()


def main(src: Path, dst: Path):
    dst.mkdir(parents=True, exist_ok=True)
    out = {k: {} for k in SETS}
    states = {}
    for d in sorted(p for p in src.iterdir() if p.is_dir()):
        files = sorted(d.glob('*.png'))
        if files:
            states[d.name] = [key_out(Image.open(f)) for f in files[:: 24 // FPS]]
    lay = layout(states)
    print('size factor', round(lay['k'], 3), {n: round(v['cx']) for n, v in lay['info'].items()})
    for name, keyed_src in states.items():
        keyed = pingpong(keyed_src)
        print(name, f'ping-pong {len(keyed_src)} -> {len(keyed)} frames, {len(keyed) / FPS:.1f}s')
        for set_name, cfg in SETS.items():
            frames = normalized(keyed, cfg['px'], lay, name)
            if set_name == 'large':
                frames[0].save(dst / f'{name}.png')
            q = cfg['q']
            while True:
                b64 = base64.b64encode(avif(frames, q)).decode()
                if len(b64) <= MAX_B64 or q <= 20:
                    break
                q -= 5  # 太大就降质量重来
            out[set_name][name] = b64
            print(name, set_name, f'{cfg["px"]}px q{q}', len(b64) // 1024, 'KB')
    ts = Path(__file__).resolve().parent.parent / 'hooks' / 'pet-sprites.ts'
    ts.write_text(
        '// 自动生成：pet/make_sprites.py。你家猫的桌宠动画（每个状态一段透明动画 AVIF，base64）\n'
        f'export const PET_PX = {SETS["small"]["px"]}\n'
        f'export const PET_LARGE_PX = {SETS["large"]["px"]}\n'
        f'export const PET_AVIF: Record<string, string> = {json.dumps(out["small"])}\n'
        f'export const PET_AVIF_LARGE: Record<string, string> = {json.dumps(out["large"])}\n'
    )
    print('wrote', ts)


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))

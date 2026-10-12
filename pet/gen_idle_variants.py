#!/usr/bin/env python3
"""待命动画的“变化”片段：首帧和尾帧都是同一张图（普通待命动画的第一帧），在本地 ComfyUI 的
MiniMax H3 first-last-frame 模型（minimax_h3_fl2va）上生成。

这样每段变化里都是同一只猫（长相、胖瘦、毛色跟待命动画一样），而且从待命动画的第一帧出发、
回到第一帧结束：插件在待命动画放回第一帧时换上它，放完再换回来，两头都接得上。

用法（在跑 ComfyUI 的机器上）：python3 gen_idle_variants.py [片段名…] [--seed N] [--full]
  先把锚点图上传成 ComfyUI input 里的 minty_anchor.png（pet/frames/idle 的第一帧，带蓝幕原样传）
输出：ComfyUI/output/minty_pet/<片段名>_fl_*.png（逐帧）和同名 .mp4（预览）
"""
import json, sys, time, urllib.request

HOST = 'http://127.0.0.1:8188'
SIZE = 640
LENGTH = 73  # 24 fps 下约 3 秒；模型要求 17k+5

STAGE = (
    'A plain chroma-key video: the entire background stays one solid flat pure blue color, uniform and empty, '
    'no floor, no shadow, no objects, no text. Locked-off static camera, no zoom, no camera movement, '
    'soft even studio lighting. '
)
CAT = (
    'The same brown tabby cat as in the first frame, sitting facing the viewer, full body visible, never cropped. '
    'It keeps exactly the same body shape, size, fur color and position as in the first frame. '
)
END = 'Then it settles back and the video ends on exactly the same pose and framing as the first frame.'
VARIANTS = {
    'idle-groom': 'It lifts one front paw, licks it twice and wipes it over its face once, then puts the paw back down. ',
    'idle-yawn': 'It opens its mouth in one big slow yawn with eyes squeezed shut, then closes its mouth and blinks. ',
    'idle-look': 'It turns its head to look at something to the left, ears swivel, then looks to the right, then turns back to the viewer. ',
    'idle-nod': 'It gets sleepy: its eyes slowly close and its head nods down a little, then it blinks awake and lifts its head again. ',
    'idle-tail': 'Its tail sways and swishes, it glances down at its tail curiously, then looks back at the viewer. ',
}


def graph(name: str, seed: int, full: bool) -> dict:
    prompt = STAGE + CAT + VARIANTS[name] + END
    tag = f'{name}_fl'
    return {
        '1': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'minimax_h3_video_vae_fp16.safetensors'}},
        '3': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'weight_dtype': 'default'}},
        '4': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'type': 'minimax', 'device': 'default'}},
        '5': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['3', 0], 'lora_name': 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 'strength_model': 1.0}},
        '11': {'class_type': 'LoadImage', 'inputs': {'image': 'minty_anchor.png'}},
        '20': {'class_type': 'MiniMaxH3ImageToVideo', 'inputs': {
            'clip': ['4', 0], 'vae': ['1', 0], 'prompt': prompt, 'width': SIZE, 'height': SIZE, 'length': LENGTH,
            'first_frame': ['11', 0], 'last_frame': ['11', 0],
        }},
        '30': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': seed}},
        '31': {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': 'res_multistep'}},
        # full：不用 turbo LoRA，跑满 20 步（慢几倍，更听 prompt 的话）
        '32': {'class_type': 'BasicScheduler', 'inputs': {'model': ['3', 0], 'scheduler': 'simple', 'steps': 20 if full else 8, 'denoise': 1.0}},
        '33': {'class_type': 'BasicGuider', 'inputs': {'model': ['3', 0] if full else ['5', 0], 'conditioning': ['20', 0]}},
        '34': {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['30', 0], 'guider': ['33', 0], 'sampler': ['31', 0], 'sigmas': ['32', 0], 'latent_image': ['20', 1]}},
        '40': {'class_type': 'VAEDecode', 'inputs': {'samples': ['34', 0], 'vae': ['1', 0]}},
        '41': {'class_type': 'SaveImage', 'inputs': {'images': ['40', 0], 'filename_prefix': f'minty_pet/{tag}'}},
        '42': {'class_type': 'CreateVideo', 'inputs': {'images': ['40', 0], 'fps': 24}},
        '43': {'class_type': 'SaveVideo', 'inputs': {'video': ['42', 0], 'filename_prefix': f'minty_pet/{tag}', 'format': 'auto', 'codec': 'auto'}},
    }


def call(path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(HOST + path, data=json.dumps(body).encode() if body else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def run(name: str, seed: int, full: bool) -> bool:
    pid = call('/prompt', {'prompt': graph(name, seed, full)})['prompt_id']
    t0 = time.time()
    while True:
        h = call(f'/history/{pid}')
        if pid in h:
            st = h[pid].get('status', {})
            print(name, st.get('status_str'), f'{time.time() - t0:.0f}s', flush=True)
            if st.get('status_str') != 'success':
                print(json.dumps(st.get('messages', []))[-1500:], flush=True)
                return False
            return True
        time.sleep(5)


def main():
    args = sys.argv[1:]
    full = '--full' in args
    seed = int(args[args.index('--seed') + 1]) if '--seed' in args else 20261012
    names = [a for a in args if a in VARIANTS] or list(VARIANTS)
    ok = all([run(n, seed, full) for n in names])
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()

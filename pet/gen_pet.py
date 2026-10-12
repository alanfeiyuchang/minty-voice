#!/usr/bin/env python3
"""在本地 ComfyUI（:8188，MiniMax H3 reference-to-video）上生成桌宠动画。

用法（在跑 ComfyUI 的那台机器上跑）：python3 gen_pet.py <状态名> [seed] [--full]
参考图是上传到 ComfyUI input 的三张裁到只剩猫的照片 minty_ref{1,2,3}.jpg（pet/refs）。
图是官方模板 video_minimax_h3_r2v 的 API 版，开了 4 步 turbo LoRA。
输出：ComfyUI/output/minty_pet/<状态>_*.png（逐帧）和 minty_pet/<状态>.mp4（预览）。
"""
import json, sys, time, urllib.request

HOST = 'http://127.0.0.1:8188'
SIZE = 640
SECONDS = 3

# 背景要求放最前面；参考图只借猫的长相，不借它们的背景（不然会把厨房地板搬过来）
STAGE = (
    'A plain chroma-key video: the entire background is one solid flat pure blue color (#0000FF), uniform, '
    'empty, with no floor, no room, no furniture, no shadow, no particles, no objects, no text. '
    'Locked-off static camera, no zoom, no camera movement, soft even studio lighting. '
)
CAT = (
    'In the center sits one cat: the same brown tabby cat as in <Picture 1>, <Picture 2> and <Picture 3> '
    '(use the pictures only for the cat\'s appearance, never for the background): dark tabby stripes, '
    'M-shaped marking on the forehead, yellow-green eyes, pink-brown nose, white chin and muzzle. '
    'Full body visible, the whole cat small in the frame with generous blue margin on every side, never cropped. '
    'Cute desktop-pet animation, seamless loop: the cat ends in the same pose it starts in. '
)
STATES = {
    'idle': 'The cat sits in a relaxed loaf pose facing the viewer, eyes half closed, slowly blinks twice, '
    'breathes gently, tail tip sways lazily. Calm and sleepy.',
    'listen': 'The cat sits upright facing the viewer, ears perk up and swivel forward, eyes wide and round, '
    'head tilts slightly as if listening intently to someone talking. Attentive.',
    'think': 'The cat sits facing the viewer, tilts its head to one side, eyes look up and to the side as if '
    'thinking, tail tip flicks slowly, one ear twitches. Curious and pondering.',
    'wait': 'The cat sits facing the viewer, looks straight at the camera with big expectant eyes, '
    'tilts its head left then back, waiting for an answer.',
    'speak': 'The cat sits facing the viewer and meows repeatedly as if talking, mouth opening and closing '
    'clearly, head bobbing slightly with each meow. Friendly and chatty.',
    # 待命的变化（idle-*）改用 gen_idle_variants.py：首尾帧都锁成 idle 的第一帧，换片段时接得上
    'live': 'The cat sits upright and alert facing the viewer, ears twitch, eyes bright, tail curled around '
    'its paws, small happy head movements. Engaged and lively.',
}


def length_for(seconds: float) -> int:
    n = max(5, round(seconds * 24))
    return n + (5 - n % 17) % 17


def graph(state: str, seed: int, full: bool = False, tag: str = '') -> dict:
    prompt = STAGE + CAT + STATES[state]
    return {
        '1': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'minimax_h3_video_vae_fp16.safetensors'}},
        '2': {'class_type': 'VAELoader', 'inputs': {'vae_name': 'minimax_h3_audio_vae_fp32.safetensors'}},
        '3': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'weight_dtype': 'default'}},
        '4': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'type': 'minimax', 'device': 'default'}},
        '5': {'class_type': 'LoraLoaderModelOnly', 'inputs': {'model': ['3', 0], 'lora_name': 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', 'strength_model': 1.0}},
        '11': {'class_type': 'LoadImage', 'inputs': {'image': 'minty_ref1.jpg'}},
        '12': {'class_type': 'LoadImage', 'inputs': {'image': 'minty_ref2.jpg'}},
        '13': {'class_type': 'LoadImage', 'inputs': {'image': 'minty_ref3.jpg'}},
        '20': {'class_type': 'MiniMaxH3ReferenceToVideo', 'inputs': {
            'clip': ['4', 0], 'vae': ['1', 0], 'audio_vae': ['2', 0], 'prompt': prompt,
            'width': SIZE, 'height': SIZE, 'length': length_for(SECONDS), 'ref_image_size': 'match',
            'ref_images.ref_image_0': ['11', 0], 'ref_images.ref_image_1': ['12', 0], 'ref_images.ref_image_2': ['13', 0],
        }},
        '30': {'class_type': 'RandomNoise', 'inputs': {'noise_seed': seed}},
        '31': {'class_type': 'KSamplerSelect', 'inputs': {'sampler_name': 'res_multistep'}},
        # full：不用 turbo LoRA，跑满 20 步（慢几倍，更听 prompt 的话）
        '32': {'class_type': 'BasicScheduler', 'inputs': {'model': ['3', 0], 'scheduler': 'simple', 'steps': 20 if full else 4, 'denoise': 1.0}},
        '33': {'class_type': 'BasicGuider', 'inputs': {'model': ['3', 0] if full else ['5', 0], 'conditioning': ['20', 0]}},
        '34': {'class_type': 'SamplerCustomAdvanced', 'inputs': {'noise': ['30', 0], 'guider': ['33', 0], 'sampler': ['31', 0], 'sigmas': ['32', 0], 'latent_image': ['20', 1]}},
        '40': {'class_type': 'VAEDecode', 'inputs': {'samples': ['34', 0], 'vae': ['1', 0]}},
        '41': {'class_type': 'SaveImage', 'inputs': {'images': ['40', 0], 'filename_prefix': f'minty_pet/{state}{tag}'}},
        '42': {'class_type': 'CreateVideo', 'inputs': {'images': ['40', 0], 'fps': 24}},
        '43': {'class_type': 'SaveVideo', 'inputs': {'video': ['42', 0], 'filename_prefix': f'minty_pet/{state}{tag}', 'format': 'auto', 'codec': 'auto'}},
    }


def call(path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(HOST + path, data=json.dumps(body).encode() if body else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    full = '--full' in sys.argv
    state = args[0]
    seed = int(args[1]) if len(args) > 1 else 20261006
    tag = '_full' if full else ''
    pid = call('/prompt', {'prompt': graph(state, seed, full, tag)})['prompt_id']
    print('queued', state, pid, flush=True)
    t0 = time.time()
    while True:
        h = call(f'/history/{pid}')
        if pid in h:
            st = h[pid].get('status', {})
            print(state, st.get('status_str'), f'{time.time() - t0:.0f}s', flush=True)
            if st.get('status_str') != 'success':
                print(json.dumps(st.get('messages', []))[-2000:])
                sys.exit(1)
            for out in h[pid]['outputs'].values():
                for k in ('images', 'videos', 'animated'):
                    for f in out.get(k, []) if isinstance(out.get(k), list) else []:
                        if isinstance(f, dict) and f.get('filename', '').endswith(('.mp4', '.webm')):
                            print('video', f.get('subfolder'), f['filename'])
            return
        time.sleep(5)


if __name__ == '__main__':
    main()

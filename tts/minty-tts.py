#!/usr/bin/env python3
"""用 edge-tts 合成一句话，参数和 edge-tts 命令行一样：

  python minty-tts.py --voice=zh-CN-XiaoxiaoNeural --rate=+8% --text=你好 --write-media=out.mp3

为什么不直接用 edge-tts 命令：2026-10 起微软的旧地址（speech.platform.bing.com）对合成请求一律返回 403，
edge-tts 7.2.8 还没发新版。Edge 浏览器现在走 api.msedgeservices.com，用同一个 token 也能合成
（上游的修复：https://github.com/rany2/edge-tts/pull/491）。这里先走新地址，失败了再试 edge-tts 自带的地址，
上游发了新版也不冲突。两个都失败时退出码 1，stderr 最后一行是原因，插件拿它提示。

要用装了 edge_tts 的 Python 运行（插件用 edge-tts 自己那个虚拟环境里的 python）。
"""
import argparse
import asyncio
import os
import sys

NEW_WSS = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key={token}'


def parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', required=True)
    ap.add_argument('--rate', default='+0%')
    ap.add_argument('--text', required=True)
    ap.add_argument('--write-media', dest='out', required=True)
    return ap.parse_args()


async def synth(args: argparse.Namespace, url: str | None) -> None:
    import edge_tts
    import edge_tts.communicate
    import edge_tts.constants
    if url:
        # communicate.py 用 from .constants import WSS_URL 拿的是自己的一份，两处都换
        edge_tts.constants.WSS_URL = url
        if hasattr(edge_tts.communicate, 'WSS_URL'):
            edge_tts.communicate.WSS_URL = url
    await edge_tts.Communicate(args.text, args.voice, rate=args.rate).save(args.out)
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        raise RuntimeError('合成出来是空文件')


def main() -> int:
    args = parse()
    try:
        import edge_tts.constants
    except ImportError:
        print('这个 Python 里没有 edge_tts', file=sys.stderr)
        return 2
    token = getattr(edge_tts.constants, 'TRUSTED_CLIENT_TOKEN', '')
    errors = []
    for url in ([NEW_WSS.format(token=token)] if token else []) + [None]:
        try:
            asyncio.run(synth(args, url))
            return 0
        except Exception as e:  # noqa: BLE001 — 网络、403、空文件：都换下一个地址试
            errors.append(f'{type(e).__name__}: {str(e)[:160]}')
            try:
                os.remove(args.out)
            except OSError:
                pass
    print('\n'.join(errors), file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())

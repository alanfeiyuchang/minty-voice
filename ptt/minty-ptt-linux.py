#!/usr/bin/env python3
"""按住说话的快捷键监听（Linux）：直接读内核的键盘事件（/dev/input/event*），X11 和 Wayland 都能用。

  python3 minty-ptt-linux.py [right-option|right-command|right-control] [标记]

输出（每行一个词），和 macOS 的 minty-ptt 一样：
  ready / down / up / cancel（按住时又按了别的键）/ no-permission（读不了键盘）/ unsupported（这个键不支持）

读 /dev/input 要在 input 组里：sudo usermod -aG input $USER，然后注销重新登录。
只读不拦截，按键照常传给前台程序。父进程（插件）没了就退出。只用标准库。
"""
import os
import select
import struct
import sys
import time

# 键名沿用 macOS 的叫法：option = Alt，command = Super/Win
KEYS = {'right-option': 100, 'right-command': 126, 'right-control': 97}  # KEY_RIGHTALT / KEY_RIGHTMETA / KEY_RIGHTCTRL
EV_KEY = 1
EVENT = struct.Struct('llHHi')  # struct input_event：timeval（两个 long）、type、code、value


def say(word: str) -> None:
    sys.stdout.write(word + '\n')
    sys.stdout.flush()


def keyboards() -> list[str]:
    """/proc/bus/input/devices 里 Handlers 带 kbd 的设备，就是键盘（包括外接的）。"""
    paths = []
    try:
        text = open('/proc/bus/input/devices').read()
    except OSError:
        return []
    for block in text.split('\n\n'):
        for line in block.splitlines():
            if line.startswith('H: Handlers=') and ' kbd' in ' ' + line[12:]:
                paths += ['/dev/input/' + h for h in line[12:].split() if h.startswith('event')]
    return paths


def open_all(known: dict[int, str]) -> bool:
    """打开还没打开的键盘；返回是否碰到了没权限的。"""
    denied = False
    opened = set(known.values())
    for path in keyboards():
        if path in opened:
            continue
        try:
            known[os.open(path, os.O_RDONLY | os.O_NONBLOCK)] = path
        except PermissionError:
            denied = True
        except OSError:
            pass
    return denied


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else 'right-option'
    if name not in KEYS:
        say('unsupported')
        return 2
    target = KEYS[name]
    fds: dict[int, str] = {}
    denied = open_all(fds)
    if not fds:
        say('no-permission' if denied else 'unsupported')
        return 3
    parent = os.getppid()
    say('ready')
    held = spoiled = False
    last_scan = time.monotonic()
    while True:
        ready, _, _ = select.select(list(fds), [], [], 2.0)
        if os.getppid() != parent:
            return 0
        if time.monotonic() - last_scan > 5:  # 新插上的键盘
            open_all(fds)
            last_scan = time.monotonic()
        for fd in ready:
            try:
                data = os.read(fd, EVENT.size * 64)
            except OSError:  # 键盘拔掉了
                os.close(fd)
                fds.pop(fd, None)
                continue
            for i in range(0, len(data) - EVENT.size + 1, EVENT.size):
                _, _, kind, code, value = EVENT.unpack_from(data, i)
                if kind != EV_KEY or value == 2:  # 2 = 按住时的自动重复
                    continue
                if code == target:
                    if value == 1 and not held:
                        held, spoiled = True, False
                        say('down')
                    elif value == 0 and held:
                        held = False
                        if not spoiled:
                            say('up')
                elif held and value == 1 and not spoiled:
                    spoiled = True
                    say('cancel')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)

// MINTY 的按住说话：全局监听一个修饰键（默认右 Option），按下/松开各打印一行给 MINTY。
//
//   minty-ptt [right-option|right-command|right-control|fn]
//
// 输出（每行一个词）：
//   ready          监听开始了
//   no-permission  没有「输入监控」权限：已经弹了系统授权，授权后要重启 Claude
//   down / up      键按下 / 松开
//   cancel         按住时又按了别的键（比如右 Option + 字母打特殊字符）：这次不算说话
//
// 只监听不拦截（listenOnly）：按键照常传给前台 App。父进程（MINTY）一退出，它也跟着退出。
// 编译：swiftc -O ptt/minty-ptt.swift -o ptt/minty-ptt（MINTY 第一次用到时会自己编）

import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func say(_ s: String) {
  print(s)
  fflush(stdout)
}

// 每个键：键码 + 它在 flags 里那一位（左右分开的设备位，见 IOKit 的 NX_DEVICE*KEYMASK）
let keys: [String: (code: Int64, bit: UInt64)] = [
  "right-option": (61, 0x40),
  "right-command": (54, 0x10),
  "right-control": (62, 0x2000),
  "fn": (63, 0x80_0000),  // kCGEventFlagMaskSecondaryFn
]
let name = CommandLine.arguments.dropFirst().first ?? "right-option"
guard let key = keys[name] else {
  FileHandle.standardError.write("unknown key \(name); one of \(keys.keys.sorted())\n".data(using: .utf8)!)
  exit(2)
}

if !CGPreflightListenEventAccess() {
  _ = CGRequestListenEventAccess()
  say("no-permission")
  exit(3)
}

// C 回调不能捕获上下文：状态放在静态成员里
enum PTT {
  nonisolated(unsafe) static var code: Int64 = 0
  nonisolated(unsafe) static var bit: UInt64 = 0
  nonisolated(unsafe) static var held = false
  nonisolated(unsafe) static var spoiled = false
}
PTT.code = key.code
PTT.bit = key.bit

let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    return Unmanaged.passUnretained(event)
  }
  if type == .keyDown {
    if PTT.held && !PTT.spoiled {
      PTT.spoiled = true
      say("cancel")
    }
    return Unmanaged.passUnretained(event)
  }
  let code = event.getIntegerValueField(.keyboardEventKeycode)
  if code == PTT.code {
    let down = event.flags.rawValue & PTT.bit != 0
    if down && !PTT.held {
      PTT.held = true
      PTT.spoiled = false
      say("down")
    } else if !down && PTT.held {
      PTT.held = false
      if !PTT.spoiled { say("up") }
    }
  } else if PTT.held && !PTT.spoiled {
    // 按住时又按了别的修饰键：当成组合键，不算说话
    PTT.spoiled = true
    say("cancel")
  }
  return Unmanaged.passUnretained(event)
}

guard
  let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
    eventsOfInterest: CGEventMask(mask), callback: callback, userInfo: nil)
else {
  say("no-permission")
  exit(3)
}
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

// 每 2 秒：父进程没了（被过继给 launchd）就退出；被系统关掉的 tap 重新打开
let parent = getppid()
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
  if getppid() != parent { exit(0) }
  if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
}

say("ready")
CFRunLoopRun()

// MINTY：Claude Code 的语音助手（macOS）。名字、命令、形象都能换（setup.sh 或设置面板）
//
//   点形象 / 按住快捷键说话 → sox 录音 → whisper.cpp 本地转写（中英混合）
//        → 模型整理成专业指令 → 发给 Claude（横栏界面先预览）
//   Claude 回复完 → 模型总结成一两句口语 → 念出来
//
// 依赖：brew install sox whisper-cpp ，外加一个 ggml 模型文件（setup.sh 会装好）
// 设置存在 ~/.claude/minty/config.json（setup.sh 和设置面板都写它）；自己的形象包放 ~/.claude/minty/avatars/

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register, RenderElement } from 'claude-code'

import type { OrbMood, Phase } from '../types'

type Engine = EngineInterface
type Spawned = HookStream<ProcessSpawnChunk, ProcessSpawnResult>

const phase = atom({ plugin: 'minty', key: 'phase' } as const, 'idle' as Phase)
const raw = atom({ plugin: 'minty', key: 'raw' } as const, '')
const refined = atom({ plugin: 'minty', key: 'refined' } as const, '')
const note = atom({ plugin: 'minty', key: 'note' } as const, '')
const speakAll = atom({ plugin: 'minty', key: 'speakAll' } as const, false)
const speakingNow = atom({ plugin: 'minty', key: 'speakingNow' } as const, false)
const working = atom({ plugin: 'minty', key: 'working' } as const, false)
// MINTY 正在念、或最后念过的那句话（光球旁边显示）
const said = atom({ plugin: 'minty', key: 'said' } as const, '')
// MINTY 面板（大猫）现在是否画在屏幕上
const panelOpen = atom({ plugin: 'minty', key: 'panelOpen' } as const, false)
// 待命时正在插播的那段变化（'' = 普通的 idle）
const idleVariant = atom({ plugin: 'minty', key: 'idleVariant' } as const, '')
// 设置面板改过的项（存在 $.store 里，跨会话保留）；变了就重画面板
const prefs = atom({ plugin: 'minty', key: 'prefs' } as const, {} as Record<string, string | boolean>)

const MAX_SECONDS = 180

// 给 whisper 的“上文提示”：whisper 会模仿上文的写法。用一段真实口吻的中英混说
// （英文小写、和中文之间有空格）把它带进 code-switching 模式，比列术语表准得多：
// 实测 refactor、TypeScript、dependency array 不再被听成 RefVector、Tagscript、DependencyArray
const WHISPER_PROMPT =
  '好的，我们来看一下这个 bug。先 refactor 一下 component，再跑 npm run build 看 TypeScript 和 test 有没有报错，log 发给我。然后 git commit，push 到 main branch，开个 PR。'
// whisper 的上文最多约 224 个 token，术语只挑一部分塞进去
const MAX_PROMPT_TERMS = 15

// 整理模型判断“这句话里没有要求”时只回这个，MINTY 就不发
const NOTHING_SAID = '<空>'
// whisper 在没人说话的片段上爱“脑补”的几句话
const HALLUCINATION = /^(谢谢(大家|观看|收看|收听)?|字幕.*|请不吝点赞.*|.*订阅.*频道.*|明镜.*|thank you|thanks for watching)[。！.!\s]*$/i

const REFINE_SYSTEM = `你是语音输入整理器。输入是用户对编程助手 Claude Code 说的一段话，经语音识别得到，中英混杂，常见的识别错误有：
- 英文技术词被写成中文谐音：“瑞爱克特”= React，“杰森”= JSON，“吉特”= git
- 英文词被听成发音相近的别的英文：Tagscript = TypeScript，RefVector = refactor，lock = log（看日志的语境），core and build = Core ML，JIT commit = git commit
- 中文同音错字：“落了一个 state”= 漏了，“在线”/“再现”看语境
- 一个词被拆开或加了标点：“whisper, CPP”= whisper.cpp
- 口头禅、重复、说到一半改口

把它整理成一条可以直接发给 Claude Code 的清晰、专业的指令：
- 只保留并澄清用户的原意，不要添加用户没说的需求，不要自己回答或执行
- 语言跟随用户：主要说中文就用简体中文，主要说英文就用英文；技术名词、命令、文件名、代码标识符一律用英文原文，并用它们的规范写法（npm、SwiftUI、GitHub、useEffect）
- 中文和英文、数字之间加一个空格
- 识别结果和【常用词】里的某个词读音相近、语境也对得上时，就改成那个词
- 去掉口头禅、重复，以及改口之前被否定的内容
- 有多个要求时用编号列出；只有一个要求就写成一两句话
- 只输出整理后的指令本身，不要任何前言、引号或解释
- 原文里没有任何实际要求（只有标点、语气词、杂音，或者听不出在说什么）时，只输出 ${NOTHING_SAID}，别的什么都不写`

const summarySystem = () => `你是 ${opt.name}，正在用语音向老板汇报编程助手刚刚完成的回复。你写的话会直接交给语音合成念出来，所以要写成“说出来顺耳”的口语，而不是书面摘要：
- 1 到 3 句话，中文不超过 80 个字，英文不超过 50 个词
- 先说结论或做了什么，再说需要老板决定或去做的事（如果有）
- 句子短一点，用逗号断开自然的停顿；不要括号、冒号、斜杠、引号、列表编号和 markdown
- 技术词保持英文原样（React、bug、commit），语音能念好；但不要念代码、文件路径、URL、命令行和版本号这类念出来像乱码的东西，提到文件就只说文件名的主体
- 数字用口语说法：“三个测试”“百分之九十”，不要“3/5”“90%”
- 语气像同事当面说话，可以用“好了”“搞定了”“有一点要你决定”这样的口头开场
- 语言跟随用户的提问；只输出要念的话本身`

// 助手的“快脑”：每句话先到这里。它判断这句是要 Claude Code 去干活，还是只是在跟助手聊天；
// 聊天就自己用口语答，不往 Claude Code 里发。和主 Session 是两路对话，有自己的短记忆，不占主 Session 的上下文
const brainSystem = () => `你是 ${opt.name}，坐在用户旁边的语音伙伴。旁边还有一个在用户电脑上干活的编程助手 Claude Code（下面叫“它”）。
用户刚对你说了一句话（语音识别的，可能有错字）。你要判断这句话该怎么处理，然后用 JSON 回答，只输出 JSON：

1. 要它去做事 → {"route":"task","say":"<一句很短的应答>","task":"<要交给它的完整要求>"}
   - 改代码、看文件、跑命令、查资料、上网搜、调试、提交……任何要在电脑上或项目里动手、或者要查实时信息（新闻、价格、文档）的事
   - 回答它刚才提的问题、确认它的方案（“好，就这么做”“继续”“先别提交”）——看下面“它最近说的话”
   - 用户说“让它……”“帮我……一下”，或者是在接着你们刚才的话说“好”“行，去做吧”
   - task 写成用户要它做的完整一句话：用户只说了“好”“去吧”时，把你们刚才聊的那件事补全写进来
   - say 像真人随口应一声，两三个字到一小句：“好。”“行，交给它。”“嗯，这就去。”不要复述要做什么，不要说“我会……”“我先去……”
2. 只是在跟你说话 → {"route":"chat","say":"<你的回答>"}
   - 打招呼、闲聊、道谢、问你的看法、问常识、问它现在在干嘛 / 做得怎么样（看下面“它最近说的话”回答）
   - 像朋友当面聊天那样自然地答：口语、简短（中文一般不超过 60 个字），直接说内容，不要先讲你打算怎么做，不要“作为 AI”这类话
   - 你只知道常识、下面给的时间和对话内容，查不了实时信息；被问到新闻、股价这类，就老实说你这边查不到，可以问一句“要不要让它上网查一下？”
3. 问天气 → {"route":"weather","place":"<地名，没说就空字符串>"}

拿不准时：会改动东西的当 task；只是问问、聊聊的当 chat。
技术词保持英文原样；不要念路径、命令和符号；语言跟随用户。`

// 总结里没有中文时换成英文母语的声音念
const EDGE_VOICE_FOR_ENGLISH = 'en-US-AvaMultilingualNeural'

// 设置项（register 时从 userConfig 填入）
const opt = {
  whisperModel: '~/.whisper/ggml-large-v3-turbo.bin',
  language: 'zh',
  refineModel: 'haiku',
  voice: 'Tingting',
  ttsEngine: 'edge',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  speechRate: '+8%',
  vocabulary: '',
  autoSend: false,
  autoFill: false,
  speakReplies: true,
  uiStyle: 'orb',
  avatar: 'cat',
  pttKey: 'right-option',
  name: 'MINTY',
  command: 'minty',
  route: 'auto',
  city: '',
}

// 模块级变量：热重载会清空——录音和朗读的子进程也随模块一起结束
let recording: { stream: Spawned; done: Promise<unknown>; file: string } | null = null
let speaking: Spawned | null = null
// 每次开始或打断朗读都加一：还在合成下一句的循环看到它变了就不再往下念
let speechGen = 0
let speakNextAnswer = false

// ---------- 系统 ----------
//
// 和操作系统打交道的地方都在这一节：判断是 macOS / Linux / Windows，找程序，拼路径，删文件、建目录。
// 录音、播放、朗读、快捷键监听在各自那一节里按系统分开。（插件不能把 $ 传给别的文件里的函数，所以都放在这个文件里）

type OS = 'mac' | 'linux' | 'windows'

type Platform = {
  os: OS
  home: string
  /** 放录音、合成语音的临时目录 */
  tmp: string
  sep: '/' | '\\'
  /** ~/.claude/minty：设置、形象、setup 装的程序 */
  dataDir: string
  /** 找程序的目录，按顺序 */
  binDirs: string[]
}

let cached: Promise<Platform> | null = null
/** 同步能读到的系统（第一次 platform() 之前是 mac） */
let currentOs: OS = 'mac'

function platform($: Engine): Promise<Platform> {
  cached ??= detect($)
  return cached
}

async function detect($: Engine): Promise<Platform> {
  let os: OS
  if ((await $.env.get('OS')) === 'Windows_NT') os = 'windows'
  else {
    try {
      const r = await $.process.run(['uname', '-s'], { timeoutMs: 5000 })
      os = r.stdout.trim() === 'Linux' ? 'linux' : 'mac'
    } catch {
      os = 'mac'
    }
  }
  currentOs = os
  const sep = os === 'windows' ? '\\' : '/'
  const home = ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '').replace(/[\\/]+$/, '')
  const j = (...p: string[]) => p.join(sep)
  const mintyDir = j(home, '.claude', 'minty')
  const pathDirs = ((await $.env.get('PATH')) ?? (await $.env.get('Path')) ?? '').split(os === 'windows' ? ';' : ':').filter(Boolean)
  let tmp = '/tmp'
  let extra: string[]
  if (os === 'mac') {
    extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', j(home, '.local', 'bin')]
  } else if (os === 'linux') {
    extra = [j(home, '.local', 'bin'), '/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/snap/bin']
  } else {
    tmp = ((await $.env.get('TEMP')) || (await $.env.get('TMP')) || j(home, 'AppData', 'Local', 'Temp')).replace(/[\\/]+$/, '')
    const local = (await $.env.get('LOCALAPPDATA')) || j(home, 'AppData', 'Local')
    const root = (await $.env.get('SystemRoot')) || 'C:\\Windows'
    // winget 的“便携版”包（SoX、FFmpeg）解压在 WinGet\Packages\<包名>_…\ 里，只把目录加进用户 PATH；
    // 刚装完、或者 Claude 是在装之前打开的，PATH 里还没有：直接去那里找
    const pkgRoot = j(local, 'Microsoft', 'WinGet', 'Packages')
    const portable: string[] = []
    try {
      for (const pkg of await $.fs.list(pkgRoot)) {
        if (pkg.kind !== 'dir' || !/^(ChrisBagwell\.SoX|Gyan\.FFmpeg)/i.test(pkg.name)) continue
        for (const sub of await $.fs.list(j(pkgRoot, pkg.name))) {
          if (sub.kind === 'dir') portable.push(j(pkgRoot, pkg.name, sub.name), j(pkgRoot, pkg.name, sub.name, 'bin'))
        }
      }
    } catch {}
    extra = [
      j(home, '.local', 'bin'),
      j(local, 'Microsoft', 'WinGet', 'Links'),
      ...portable,
      'C:\\Program Files (x86)\\sox-14-4-2',
      'C:\\Program Files\\sox-14-4-2',
      'C:\\ProgramData\\chocolatey\\bin',
      j(home, 'scoop', 'shims'),
      j(root, 'System32'),
      j(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    ]
  }
  // setup 装的程序（whisper.cpp 预编译包、链接）最优先；然后是各系统常见的位置；最后是 PATH
  const binDirs = [...new Set([j(mintyDir, 'bin'), j(mintyDir, 'whisper'), ...extra, ...pathDirs])]
  return { os, home, tmp, sep, dataDir: mintyDir, binDirs }
}

function join(p: Platform, ...parts: string[]): string {
  return parts.join(p.sep)
}

/** 按名字找程序；Windows 上补 .exe */
async function findBin($: Engine, names: readonly string[]): Promise<string | null> {
  const p = await platform($)
  const exts = p.os === 'windows' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of p.binDirs) {
    for (const name of names) {
      for (const ext of exts) {
        const path = `${dir}${p.sep}${name}${ext}`
        if (await $.fs.exists(path)) return path
      }
    }
  }
  return null
}

/** ~ 开头的路径换成主目录 */
async function expandHome($: Engine, path: string): Promise<string> {
  const p = await platform($)
  const full = path.startsWith('~/') || path.startsWith('~\\') ? p.home + p.sep + path.slice(2) : path
  return p.os === 'windows' ? full.replace(/\//g, '\\') : full
}

/** Windows 上用 PowerShell 做文件操作：路径经环境变量传，不用担心空格和引号 */
async function powershell($: Engine, script: string, env: Record<string, string> = {}, input?: string) {
  const ps = (await findBin($, ['powershell'])) ?? 'powershell.exe'
  return $.process.run([ps, '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000, env, ...(input === undefined ? {} : { stdin: input }) })
}

async function removeFile($: Engine, file: string) {
  const p = await platform($)
  try {
    if (p.os === 'windows') await powershell($, 'Remove-Item -LiteralPath $env:MINTY_PATH -Force -ErrorAction SilentlyContinue', { MINTY_PATH: file })
    else await $.process.run(['/bin/rm', '-f', file], { timeoutMs: 5000 })
  } catch {}
}

async function makeDir($: Engine, dir: string) {
  const p = await platform($)
  try {
    if (p.os === 'windows') await powershell($, 'New-Item -ItemType Directory -Force -Path $env:MINTY_PATH | Out-Null', { MINTY_PATH: dir })
    else await $.process.run(['/bin/mkdir', '-p', dir], { timeoutMs: 5000 })
  } catch {}
}

/**
 * 按命令行找到并结束一个进程（录音的 sox、上次留下的快捷键监听程序）。
 * macOS / Linux 用 pkill：gentle 时发 SIGINT，sox 会正常收尾、写好 wav 文件头。
 * Windows 没有 SIGINT 可发，返回 false，调用方直接结束自己拿着的那个子进程。
 */
async function killMatching($: Engine, pattern: string, gentle: boolean): Promise<boolean> {
  const p = await platform($)
  if (p.os === 'windows') return false
  try {
    await $.process.run(gentle ? ['/usr/bin/pkill', '-INT', '-f', pattern] : ['/usr/bin/pkill', '-f', pattern], { timeoutMs: 5000 })
  } catch {}
  return true
}

/** 缺什么时该怎么装：给提示用 */
function installHint(os: OS, what: 'sox' | 'whisper' | 'player' | 'speech'): string {
  const setup = os === 'windows' ? '在插件目录运行 setup.cmd' : '在插件目录运行 ./setup.sh'
  if (os === 'mac') return { sox: 'brew install sox', whisper: 'brew install whisper-cpp', player: 'brew install sox', speech: '系统自带 say' }[what]
  if (os === 'linux')
    return {
      sox: 'sudo apt install sox libsox-fmt-all（或者 ' + setup + '）',
      whisper: setup,
      player: 'sudo apt install ffmpeg',
      speech: 'sudo apt install espeak-ng',
    }[what]
  return { sox: setup + '（会用 winget 装 SoX）', whisper: setup, player: setup + '（会用 winget 装 FFmpeg）', speech: 'Windows 自带' }[what]
}

// ---------- 小工具 ----------

async function setPhase($: Engine, p: Phase, msg = '') {
  await update($, phase, () => p)
  await update($, note, () => msg)
}

async function modelPath($: Engine): Promise<string> {
  return expandHome($, opt.whisperModel.trim())
}

// edge-tts：`uv tool install edge-tts` / `pipx install edge-tts` 装在 ~/.local/bin；
// 都没有但有 uv 时用 `uvx edge-tts` 临时跑
// 合成用插件自带的 tts/minty-tts.py（参数和 edge-tts 命令一样）：2026-10 起 edge-tts 的旧地址一律 403，
// 脚本先走 Edge 浏览器现在用的新地址，不行再试旧地址。它要用装了 edge_tts 的 Python 跑：
// 优先 edge-tts 自己那个虚拟环境（uv tool / pipx 装的，edge-tts 命令是指过去的链接），其次 uv run 临时装一个；
// 都没有就退回 edge-tts 命令本身
async function findEdgeTts($: Engine): Promise<string[] | null> {
  const pf = await platform($)
  const script = join(pf, $.plugin.root, 'tts', 'minty-tts.py')
  const edge = await findBin($, ['edge-tts'])
  const py = edge ? await edgePython($, edge) : null
  if (py) return [py, script]
  const uv = await findBin($, ['uv'])
  if (uv) return [uv, 'run', '--quiet', '--with', 'edge-tts', 'python', script]
  if (edge) return [edge]
  const uvx = await findBin($, ['uvx'])
  return uvx ? [uvx, 'edge-tts'] : null
}

// edge-tts 那个虚拟环境里的 python：顺着 edge-tts 命令的链接找到它所在的 bin 目录
async function edgePython($: Engine, edge: string): Promise<string | null> {
  const pf = await platform($)
  let real = edge
  try {
    real = (await $.fs.stat(edge, { resolve: true })).realPath ?? edge
  } catch {}
  const dir = real.slice(0, Math.max(real.lastIndexOf('/'), real.lastIndexOf('\\')))
  const candidates =
    pf.os === 'windows'
      ? [
          join(pf, dir, 'python.exe'),
          join(pf, (await $.env.get('APPDATA')) ?? join(pf, pf.home, 'AppData', 'Roaming'), 'uv', 'data', 'tools', 'edge-tts', 'Scripts', 'python.exe'),
          join(pf, pf.home, 'pipx', 'venvs', 'edge-tts', 'Scripts', 'python.exe'),
        ]
      : [`${dir}/python`, `${dir}/python3`]
  for (const c of candidates) if (await $.fs.exists(c)) return c
  return null
}

// 最近一次 edge 合成失败的原因；一个会话里只提示一次“退回系统声音了”
let lastEdgeError = ''
let edgeWarned = false

// ---------- 录音 ----------

async function startRecording($: Engine) {
  if (recording) return
  speechQueue.length = 0
  stopSpeaking()
  await update($, said, () => '')
  const sox = await findBin($, ['sox'])
  const pf = await platform($)
  if (!sox) {
    await setPhase($, 'idle', '没找到 sox：' + installHint(pf.os, 'sox'))
    return
  }
  // -d = 默认麦克风；16kHz 单声道 16bit 正是 whisper 要的格式。
  // Windows 上没法让 sox 正常收尾（没有 SIGINT），直接结束的话 wav 文件头是坏的：
  // 先录成不带文件头的 raw，停下后再转成 wav（stopRecording 里）
  const rawPcm = pf.os === 'windows'
  const file = join(pf, pf.tmp, `minty-${await $.clock.now()}.${rawPcm ? 'raw' : 'wav'}`)
  const stream = $.process.spawn({
    argv: [sox, '-q', '-d', '-c', '1', '-r', '16000', '-b', '16', ...(rawPcm ? ['-e', 'signed-integer', '-t', 'raw'] : []), file, 'trim', '0', String(MAX_SECONDS)],
  })
  let stderr = ''
  const done = (async () => {
    try {
      for await (const chunk of stream) if (chunk.stream === 'stderr') stderr += chunk.text
    } catch (err) {
      stderr += String(err)
    }
  })()
  recording = { stream, done, file }
  await update($, raw, () => '')
  await update($, refined, () => '')
  await setPhase($, 'recording')

  // sox 自己退出了（录满上限，或者根本没打开麦克风）
  void done.then(() => onRecorderExit($, file, () => stderr))
}

async function onRecorderExit($: Engine, file: string, stderr: () => string) {
  if (recording?.file !== file) return // 是我们主动停的，stopRecording 会接手
  if (await $.fs.exists(file)) {
    await stopRecording($)
    return
  }
  recording = null
  await setPhase($, 'idle', '录音失败：' + firstLine(stderr()) + '（检查终端/Claude 的麦克风权限）')
}

async function stopRecording($: Engine, discard = false) {
  const rec = recording
  if (!rec) return
  recording = null
  // macOS / Linux：SIGINT 让 sox 正常收尾、写好 wav 文件头；Windows：直接结束（录的是 raw）
  const signalled = await killMatching($, rec.file, true)
  const ended = signalled && (await Promise.race([rec.done.then(() => true), $.clock.sleep(3000).then(() => false)]))
  if (!ended) {
    await rec.stream.return(undefined as never).catch(() => undefined)
    await Promise.race([rec.done, $.clock.sleep(2000)])
  }

  if (discard) {
    await removeFile($, rec.file)
    await setPhase($, 'idle')
    return
  }
  let file = rec.file
  if (file.endsWith('.raw')) {
    const wav = file.slice(0, -4) + '.wav'
    const sox = await findBin($, ['sox'])
    try {
      if (sox) await $.process.run([sox, '-q', '-t', 'raw', '-r', '16000', '-b', '16', '-c', '1', '-e', 'signed-integer', file, wav], { timeoutMs: 30_000 })
    } catch {}
    void removeFile($, file)
    file = wav
  }
  await transcribeAndRefine($, file)
}

// ---------- 转写 + 整理 ----------

async function transcribeAndRefine($: Engine, file: string) {
  await setPhase($, 'transcribing')
  try {
    const heard = await transcribe($, file)
    if ('error' in heard) {
      await setPhase($, 'idle', heard.error)
      return
    }
    if (opt.uiStyle === 'orb') {
      await converse($, heard)
      return
    }
    await update($, raw, () => heard.text)

    await setPhase($, 'refining')
    const prompt = await refine($, heard.text, heard.recent, heard.terms)
    if (!prompt) {
      await setPhase($, 'idle', '没听清，再说一次？')
      return
    }
    await update($, refined, () => prompt)

    if (opt.autoSend) await send($)
    else if (!(opt.autoFill && (await editInPrompt($)))) await setPhase($, 'review') // 输入框不可用就退回预览
  } catch (err) {
    await setPhase($, 'idle', '出错了：' + firstLine(String(err)))
  } finally {
    await removeFile($, file)
  }
}

type Heard = { text: string; recent: Recent; terms: string[] } | { error: string }

// 录音文件 → whisper 转写出的原话（不删文件，调用方负责）
async function transcribe($: Engine, file: string): Promise<Heard> {
  const size = (await $.fs.exists(file)) ? (await $.fs.stat(file)).size : 0
  // 16kHz × 16bit 单声道 ≈ 32KB/秒；不到半秒当作没说话
  if (size < 16_000) return { error: '没听到声音，再试一次？' }
  const whisper = await findBin($, ['whisper-cli', 'whisper-cpp'])
  if (!whisper) return { error: '没找到 whisper.cpp：' + installHint((await platform($)).os, 'whisper') }
  const model = await modelPath($)
  if (!(await $.fs.exists(model))) return { error: `没找到模型文件 ${model}（见 README 下载）` }
  const recent = await recentMessages($)
  const terms = vocabularyTerms(recent)
  const whisperPrompt =
    WHISPER_PROMPT + (terms.length ? `这次会提到 ${terms.slice(0, MAX_PROMPT_TERMS).join('、')}。` : '')
  const r = await $.process.run(
    [whisper, '-m', model, '-f', file, '-l', opt.language, '-nt', '-np', '--prompt', whisperPrompt],
    { timeoutMs: 180_000 },
  )
  const text = cleanTranscript(r.stdout)
  if (r.exitCode !== 0) return { error: '转写失败：' + firstLine(r.stderr) }
  // 只有标点（比如一个“。”）或者 whisper 的脑补：当作没说话，不往下整理、不发
  if (!/[\p{L}\p{N}]/u.test(text) || HALLUCINATION.test(text)) return { error: '没听清，再说一次？' }
  return { text, recent, terms }
}

type Recent = { role: string; text: string }[]

async function recentMessages($: Engine): Promise<Recent> {
  try {
    return (await $.session.messages()).slice(-6).map(m => ({ role: m.role, text: m.text }))
  } catch {
    return []
  }
}

// 常用词：用户在设置里填的，加上最近对话里像代码标识符的英文词（useEffect、whisper.cpp、GitHub、API、build_tool）
// 按出现次数排序。whisper 拿它当上文，整理那一步拿它对照纠错
const IDENT = /[A-Za-z][A-Za-z0-9]*(?:[._+#-][A-Za-z0-9]+)+|[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*|\b[A-Z]{2,}[a-z]?\b|(?<!(?:^|[.!?。！？:：\n])\s*)\b[A-Z][a-z]{2,}\b/g
const NOT_TERMS = new Set(['The', 'This', 'That', 'And', 'But', 'For', 'You', 'Your', 'When', 'What', 'Then', 'Also', 'Note', 'Done', 'OK', 'I'])

function vocabularyTerms(recent: Recent): string[] {
  const mine = opt.vocabulary
    .split(/[,，、;；\n]/)
    .map(s => s.trim())
    .filter(Boolean)
  const count = new Map<string, number>()
  for (const m of recent) {
    for (const w of m.text.slice(-4000).match(IDENT) ?? []) {
      // 路径和网址的碎片念不出来，也不会被说出来
      if (w.length > 30 || /^(https?|www|tmp|Users|private)\b/i.test(w) || NOT_TERMS.has(w)) continue
      count.set(w, (count.get(w) ?? 0) + 1)
    }
  }
  const seen = new Set(mine.map(s => s.toLowerCase()))
  const fromChat = [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .filter(w => !seen.has(w.toLowerCase()) && (seen.add(w.toLowerCase()), true))
  return [...mine, ...fromChat].slice(0, 40)
}

async function refine($: Engine, text: string, recent: Recent, terms: string[]): Promise<string> {
  // 带上最近两条对话，帮模型认对“那个文件”“刚才的报错”这类指代和术语
  const context = recent
    .slice(-2)
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.text.slice(-800)}`)
    .join('\n')
  const r = await $.model.complete({
    model: opt.refineModel,
    system: REFINE_SYSTEM,
    prompt:
      (context ? `【最近的对话，仅用于纠正术语和理解指代，不要照搬】\n${context}\n\n` : '') +
      (terms.length ? `【常用词】\n${terms.join('、')}\n\n` : '') +
      `【语音识别原文】\n${text}`,
    maxTokens: 1024,
    timeoutMs: 30_000,
  })
  // 整理失败就退回原话，不至于卡住；模型说“没有要求”就回空串，调用方不发
  const out = r.isAnswered ? r.text.trim() : ''
  if (out.includes(NOTHING_SAID)) return ''
  return out || text
}

async function send($: Engine) {
  const text = (await read($, refined)).trim()
  if (!text) return
  speakNextAnswer = true
  await setPhase($, 'idle', '已发送 ✓')
  void $.prompt.submit({ text, asUser: true })
}

async function editInPrompt($: Engine): Promise<boolean> {
  const text = await read($, refined)
  const { isFilled } = await $.prompt.fill({ text })
  if (isFilled) {
    speakNextAnswer = true
    await setPhase($, 'idle', '已放进输入框，改好按回车发送')
  } else {
    await update($, note, () => '输入框现在不可用，稍后再试')
  }
  return isFilled
}

// ---------- 朗读总结 ----------

async function summarize($: Engine, answer: string): Promise<string | null> {
  const r = await $.model.complete({
    model: opt.refineModel,
    system: summarySystem(),
    prompt: `【回复原文】\n${answer.slice(0, 20_000)}`,
    maxTokens: 400,
    timeoutMs: 30_000,
  })
  return r.isAnswered && r.text.trim() ? r.text.trim() : null
}

async function speakSummary($: Engine, answer: string) {
  if (opt.uiStyle === 'orb') {
    const line = await summarize($, answer)
    if (line) await enqueueSpeech($, line)
    return
  }
  stopSpeaking()
  const line = await summarize($, answer)
  if (!line) return
  // 用户已经在说下一句或在看预览，就别插嘴
  if ((await read($, phase)) !== 'idle') return
  await update($, refined, () => line)
  await setPhase($, 'speaking')
  await speak($, line)
  if ((await read($, phase)) === 'speaking') await setPhase($, 'idle')
}

async function speak($: Engine, text: string) {
  const gen = ++speechGen
  let chunks = speechChunks(speakable(text))
  if (!chunks.length) return
  if (opt.ttsEngine === 'edge') {
    const edge = await findEdgeTts($)
    if (edge) {
      const left = await speakEdge($, edge, chunks, gen)
      if (left === 0 || gen !== speechGen) return
      chunks = chunks.slice(-left) // 断网或合成失败：剩下的交给 say
      if (!edgeWarned && lastEdgeError) {
        edgeWarned = true
        const msg = `自然声音（edge-tts）这次没合成出来，先用系统声音念。原因：${lastEdgeError}（/${opt.command} check 看详情）`
        await update($, note, () => msg)
        void $.ui.toast(msg)
      }
    }
  }
  const rest = chunks.join('')
  const ok = await say($, rest, opt.voice)
  if (!ok && gen === speechGen) await say($, rest, null) // 声音没装就用系统默认
}

// 神经网络声音（edge-tts，微软在线 TTS）：一句一句合成，念这一句的同时合成下一句，
// 第一句出来就开口。返回没念到的句数，0 表示念完或被打断
async function speakEdge($: Engine, edge: string[], chunks: string[], gen: number): Promise<number> {
  const voice = /[\u3400-\u9fff]/.test(chunks.join('')) ? opt.edgeVoice : EDGE_VOICE_FOR_ENGLISH
  const pf = await platform($)
  const base = join(pf, pf.tmp, `minty-tts-${await $.clock.now()}`)
  const synth = (i: number): Promise<string | null> => {
    const file = `${base}-${i}.mp3`
    return $.process
      .run([...edge, `--voice=${voice}`, `--rate=${opt.speechRate}`, `--text=${chunks[i]}`, `--write-media=${file}`], {
        timeoutMs: 15_000,
      })
      .then(
        r => {
          if (r.exitCode === 0) return file
          lastEdgeError = (r.stderr.trim().split('\n').pop() ?? '').slice(0, 120)
          return null
        },
        err => {
          lastEdgeError = String(err).slice(0, 120)
          return null
        },
      )
  }
  const player = await playerFor($)
  if (!player) return chunks.length // 没有能放 mp3 的程序：整段交给系统朗读
  let pending: Promise<string | null> | null = synth(0)
  try {
    for (let i = 0; i < chunks.length; i++) {
      const file: string | null = await pending!
      pending = null
      if (!file) return gen === speechGen ? chunks.length - i : 0
      if (gen !== speechGen) {
        await removeFile($, file)
        return 0
      }
      if (i + 1 < chunks.length) pending = synth(i + 1)
      await play($, player(file))
      void removeFile($, file)
      if (gen !== speechGen) return 0
    }
    return 0
  } finally {
    // 被打断时，已经在合成的下一句也删掉
    const p = pending as Promise<string | null> | null
    if (p) void p.then(f => (f ? removeFile($, f) : undefined))
  }
}

// 句与句之间留的停顿（秒）
const SENTENCE_PAUSE = '0.15'

// 播放一段 mp3 的命令，顺手把 edge-tts 每段首尾约 0.2 + 0.5 秒的静音剪掉，只留一个自然的短停顿，
// 每句之间的空隙从约 1.4 秒降到 0.25 秒左右。
// macOS：优先 sox 的 play（起播约 0.1 秒，afplay 要 0.8 秒），没有就 afplay。
// Linux / Windows：ffplay（装 FFmpeg 就有），其次 mpv，Linux 再试 sox 的 play；都没有就返回 null
async function playerFor($: Engine): Promise<((file: string) => string[]) | null> {
  const os = (await platform($)).os
  const trim = ['silence', '1', '0.02', '0.3%', 'reverse', 'silence', '1', '0.02', '0.3%', 'reverse', 'pad', '0', SENTENCE_PAUSE]
  const playBin = os === 'windows' ? null : await findBin($, ['play'])
  if (os === 'mac') return playBin ? file => [playBin, '-q', file, ...trim] : file => ['/usr/bin/afplay', file]
  const ffplay = await findBin($, ['ffplay'])
  if (ffplay) {
    const cut = 'silenceremove=start_periods=1:start_threshold=-45dB'
    const af = `${cut},areverse,${cut},areverse,apad=pad_dur=${SENTENCE_PAUSE}`
    return file => [ffplay, '-nodisp', '-autoexit', '-loglevel', 'quiet', '-af', af, file]
  }
  const mpv = await findBin($, ['mpv'])
  if (mpv) return file => [mpv, '--no-video', '--really-quiet', file]
  return playBin ? file => [playBin, '-q', file, ...trim] : null
}

// 给语音合成的文字：去掉 markdown 符号和网址，这些念出来都是噪音
function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/[`*_#>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// 按句子切开，太短的句子并到下一句（每段一次网络请求，太碎反而停顿多）
function speechChunks(text: string): string[] {
  const parts = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*/g) ?? []
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    cur += p
    if (cur.trim().length >= 12) {
      out.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) {
    if (out.length && cur.trim().length < 6) out[out.length - 1] += cur.trim()
    else out.push(cur.trim())
  }
  return out
}

// 系统自带的朗读：macOS 的 say，Linux 的 espeak-ng / spd-say，Windows 的 System.Speech
async function say($: Engine, text: string, voice: string | null): Promise<boolean> {
  const os = (await platform($)).os
  if (os === 'mac') return play($, voice ? ['/usr/bin/say', '-v', voice] : ['/usr/bin/say'], text)
  if (os === 'windows') {
    const ps = (await findBin($, ['powershell'])) ?? 'powershell.exe'
    const script =
      '[Console]::InputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; ' +
      '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak([Console]::In.ReadToEnd())'
    return play($, [ps, '-NoProfile', '-NonInteractive', '-Command', script], text)
  }
  const espeak = await findBin($, ['espeak-ng', 'espeak'])
  if (espeak) return play($, [espeak, '-v', /[\u3400-\u9fff]/.test(text) ? 'cmn' : 'en', '--stdin'], text)
  const spd = await findBin($, ['spd-say'])
  return spd ? play($, [spd, '-w', text]) : false
}

// 跑一个出声的进程，记在 speaking 里好让“别念了”能掐掉它
async function play($: Engine, argv: string[], input?: string): Promise<boolean> {
  const stream = $.process.spawn({ argv, input })
  speaking = stream
  let stderr = ''
  try {
    for await (const c of stream) if (c.stream === 'stderr') stderr += c.text
    const end = await stream.result
    return end.code === 0 && !/not found|invalid/i.test(stderr)
  } catch {
    // 被“别念了”打断也走这里；调用方会看 phase 决定是否重试
    return true
  } finally {
    if (speaking === stream) speaking = null
  }
}

function stopSpeaking() {
  speechGen++
  const s = speaking
  speaking = null
  if (s) void s.return(undefined as never).catch(() => undefined)
}


// ---------- 快脑 + 朗读队列（光球模式） ----------

// 快脑自己的记忆：最近几轮“老板说了什么、我应了什么”
const brainMemory: { heard: string; said: string }[] = []
const speechQueue: string[] = []
let speechDraining = false

type Decision = { route: 'task'; say: string; task: string } | { route: 'chat'; say: string } | { route: 'weather'; place: string }

async function decide($: Engine, heard: string, recent: Recent): Promise<Decision> {
  const busy = await read($, working)
  const lastAssistant = recent.filter(m => m.role === 'assistant').slice(-1)[0]?.text.slice(-400) ?? ''
  const lastTask = recent.filter(m => m.role === 'user').slice(-1)[0]?.text.slice(0, 200) ?? ''
  const memory = brainMemory.map(m => `用户：${m.heard}\n你：${m.said}`).join('\n')
  const now = new Date(await $.clock.now())
  const r = await $.model.complete({
    model: opt.refineModel,
    system: brainSystem(),
    prompt:
      `【现在】${now.toLocaleString('zh-CN', { hour12: false })}\n\n` +
      (memory ? `【你们刚才的对话】\n${memory}\n\n` : '') +
      `【它现在】${busy ? `正在忙：${lastTask || '上一件事'}` : '空闲'}\n` +
      (lastAssistant ? `【它最近说的话（结尾）】\n${lastAssistant}\n` : '') +
      `\n【用户刚说的】\n${heard}`,
    maxTokens: 400,
    timeoutMs: 15_000,
  })
  const text = r.isAnswered ? r.text.trim() : ''
  try {
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>
    const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string).trim() : '')
    if (j.route === 'chat' && str('say')) return { route: 'chat', say: str('say') }
    if (j.route === 'weather') return { route: 'weather', place: str('place') }
    if (j.route === 'task') return { route: 'task', say: str('say'), task: str('task') || heard }
  } catch {}
  // 判断失败：照老样子交给 Claude Code，至少话不会丢
  return { route: 'task', say: '', task: heard }
}

function remember(heard: string, said: string) {
  brainMemory.push({ heard, said })
  if (brainMemory.length > 8) brainMemory.shift()
}

// 天气：wttr.in 按地名查；没说地名就用设置里的城市，再没有就按网络位置（wttr.in 会看到你的 IP）
async function weather($: Engine, heard: string, place: string): Promise<string> {
  const where = place || opt.city
  let data = ''
  try {
    const res = await $.http.fetch(`https://wttr.in/${encodeURIComponent(where)}?format=j1&lang=zh`)
    if (res.ok) {
      const j = JSON.parse(res.text) as {
        current_condition?: { temp_C?: string; FeelsLikeC?: string; lang_zh?: { value?: string }[]; weatherDesc?: { value?: string }[] }[]
        weather?: { date?: string; maxtempC?: string; mintempC?: string; hourly?: { chanceofrain?: string; lang_zh?: { value?: string }[] }[] }[]
        nearest_area?: { areaName?: { value?: string }[] }[]
      }
      const c = j.current_condition?.[0]
      const area = where || j.nearest_area?.[0]?.areaName?.[0]?.value || ''
      const days = (j.weather ?? []).slice(0, 2).map(d => {
        const rain = Math.max(0, ...(d.hourly ?? []).map(h => Number(h.chanceofrain) || 0))
        return `${d.date}：${d.mintempC}~${d.maxtempC}°C，降雨概率最高 ${rain}%`
      })
      data = `${area} 现在 ${c?.lang_zh?.[0]?.value ?? c?.weatherDesc?.[0]?.value ?? ''}，${c?.temp_C}°C，体感 ${c?.FeelsLikeC}°C。${days.join('；')}`
    }
  } catch {}
  if (!data) return '天气这会儿没查到，可能是网络的问题，等会儿再问我一次？'
  const r = await $.model.complete({
    model: opt.refineModel,
    system: `你是 ${opt.name}，用户的语音伙伴。用一两句口语回答用户关于天气的问题，像朋友随口告诉他，自然、简短（中文不超过 50 个字），可以顺带一句实用的提醒（带伞、加衣服）。只输出要说的话。`,
    prompt: `【天气数据】${data}\n【用户问】${heard}`,
    maxTokens: 150,
    timeoutMs: 15_000,
  })
  return r.isAnswered && r.text.trim() ? r.text.trim() : data
}

// 放开光球之后：快脑先判断这句是聊天还是要 Claude Code 干活。
// 聊天（和问天气）它自己答完就算了，不往 Claude Code 里发；干活就整理成指令发过去，同时随口应一声
async function converse($: Engine, heard: { text: string; recent: Recent; terms: string[] }) {
  await update($, raw, () => heard.text)
  await setPhase($, 'refining')
  const d: Decision = opt.route === 'always' ? { route: 'task', say: '', task: heard.text } : await decide($, heard.text, heard.recent)
  if (d.route !== 'task') {
    const answer = d.route === 'chat' ? d.say : await weather($, heard.text, d.place)
    remember(heard.text, answer)
    await setPhase($, 'idle')
    await enqueueSpeech($, answer)
    return
  }
  if (d.say) {
    remember(heard.text, d.say)
    void enqueueSpeech($, d.say)
  }
  const prompt = await refine($, d.task, heard.recent, heard.terms)
  if (!prompt) {
    await setPhase($, 'idle', '没听清，再说一次？')
    return
  }
  await update($, refined, () => prompt)
  speakNextAnswer = true
  await setPhase($, 'idle')
  // Claude 正忙时插件发的消息会排队，空下来再处理
  void $.prompt.submit({ text: prompt, asUser: true })
}

// 按顺序念：先念快脑的回应，再念主 Session 做完后的总结；你一按光球就全部停下
async function enqueueSpeech($: Engine, line: string) {
  await update($, said, () => line)
  if (!opt.speakReplies) return
  speechQueue.push(line)
  if (speechDraining) return
  speechDraining = true
  try {
    while (speechQueue.length) {
      if (recording) {
        speechQueue.length = 0
        break
      }
      const next = speechQueue.shift()!
      await update($, said, () => next)
      await update($, speakingNow, () => true)
      await speak($, next)
    }
  } finally {
    speechDraining = false
    await update($, speakingNow, () => false)
  }
}

// “停”按钮：不念了，没念的也扔掉
function hushOrb() {
  speechQueue.length = 0
  stopSpeaking()
}

// 光球的按住说话：按下开录；按住超过 HOLD_MS 再放开 = 说完了；
// 只是点一下 = 一直录，再点一下才算说完（桌面上拿不到按下/放开时也能用）
const HOLD_MS = 350
let pressedAt = 0
let pressStart: Promise<void> | null = null
let stopOnRelease = false

async function orbDown($: Engine) {
  if (recording) {
    stopOnRelease = true
    return
  }
  stopOnRelease = false
  pressedAt = await $.clock.now()
  speechQueue.length = 0
  pressStart = startRecording($)
  await pressStart
}

async function orbUp($: Engine) {
  if (pressStart) await pressStart
  pressStart = null
  if (stopOnRelease) {
    stopOnRelease = false
    await stopRecording($)
    return
  }
  if (!recording) {
    // 按下那一下和放开挤在同一帧里被合并了：当作点了一下，开始录
    pressedAt = await $.clock.now()
    await startRecording($)
    return
  }
  if ((await $.clock.now()) - pressedAt >= HOLD_MS) await stopRecording($)
}

// 桌面版按钮：点一下开始录，再点一下说完；正在念时点一下先闭嘴
async function orbTap($: Engine) {
  void claimPtt($)
  if (recording) return stopRecording($)
  const p = await read($, phase)
  if (p === 'transcribing' || p === 'refining') return
  return startRecording($)
}

// 光球现在该是什么样子、旁边写什么
async function orbLook($: Engine, hint: string): Promise<{ mood: OrbMood; label: string }> {
  const p = await read($, phase)
  const msg = await read($, note)
  if (p === 'recording') return { mood: 'listen', label: hint.startsWith('按住') ? '在听…放开就发' : '在听…再点一下发送' }
  if (p === 'transcribing' || p === 'refining') return { mood: 'think', label: '听懂中' }
  if (await read($, speakingNow)) return { mood: 'speak', label: opt.name }
  if (await read($, working)) return { mood: 'think', label: 'Code 在想' }
  return { mood: 'idle', label: msg && /失败|没找到|出错|没听/.test(msg) ? msg.slice(0, 24) : hint }
}

// ---------- 按住快捷键说话 ----------
//
// 插件收不到按键的按下/松开，所以由 ptt/minty-ptt（一个几十行的 Swift 小程序，第一次用时现编）
// 在系统层面监听一个修饰键，每次按下/松开往 stdout 打一行。只监听不拦截，按键照常传给前台 App。
// 按住超过 PTT_MIN_MS 再松开 = 说完了发出去；更短的当误碰，录的扔掉；按住时又按了别的键（组合键）也扔掉。
//
// 每个开着的会话都有自己的监听程序：只有“最近用过”的那个会话（PTT_OWNER 里记着它的 id）会接这个键，
// 不然开着几个会话时一按，几个会话同时录音。在哪个会话里发过消息、点过 MINTY，键就归哪个会话。

const PTT_MIN_MS = 300
async function pttOwnerFile($: Engine): Promise<string> {
  const pf = await platform($)
  return join(pf, pf.tmp, 'minty-ptt-owner')
}
const PTT_KEYS = ['right-option', 'right-command', 'right-control', 'fn', 'off'] as const

let pttStream: Spawned | null = null
let pttDownAt = 0
let pttHeld = false

async function claimPtt($: Engine) {
  if (opt.pttKey === 'off') return
  try {
    await $.fs.write(await pttOwnerFile($), await $.session.id())
  } catch {}
}

async function ownsPtt($: Engine): Promise<boolean> {
  try {
    return (await $.fs.read(await pttOwnerFile($))).trim() === (await $.session.id())
  } catch {
    return true // 还没人认领过：谁先收到谁接
  }
}

// 每个系统的监听程序，都是“每次按下/松开往 stdout 打一行”：
//   macOS    ptt/minty-ptt.swift，第一次用时编译（CGEventTap，要「输入监控」权限）
//   Linux    ptt/minty-ptt-linux.py，系统自带的 python3 直接跑（读 /dev/input，要在 input 组里；X11 / Wayland 都行）
//   Windows  ptt/minty-ptt.ps1，PowerShell 直接跑（GetAsyncKeyState，不用权限）
async function pttCommand($: Engine): Promise<string[] | string> {
  const pf = await platform($)
  const dir = join(pf, $.plugin.root, 'ptt')
  if (pf.os === 'windows') {
    const ps = (await findBin($, ['powershell'])) ?? 'powershell.exe'
    return [ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(pf, dir, 'minty-ptt.ps1')]
  }
  if (pf.os === 'linux') {
    const py = await findBin($, ['python3'])
    return py ? [py, join(pf, dir, 'minty-ptt-linux.py')] : '快捷键说话要 python3：sudo apt install python3'
  }
  const bin = join(pf, dir, 'minty-ptt')
  if (await $.fs.exists(bin)) return [bin]
  const swiftc = await findBin($, ['swiftc'])
  const r = swiftc ? await $.process.run([swiftc, '-O', join(pf, dir, 'minty-ptt.swift'), '-o', bin], { timeoutMs: 180_000 }) : null
  return r?.exitCode === 0 ? [bin] : '快捷键说话没开起来：编译 ptt/minty-ptt.swift 失败（要装 Xcode 命令行工具：xcode-select --install）'
}

async function startPtt($: Engine) {
  stopPtt()
  if (opt.pttKey === 'off') return
  const cmd = await pttCommand($)
  if (typeof cmd === 'string') {
    await update($, note, () => cmd)
    void $.ui.toast(cmd)
    return
  }
  // 热重载留下的同一会话的旧监听程序先收掉（最后一个参数是会话 id，只是个标记）
  const tag = await $.session.id()
  await killMatching($, `minty-ptt[^ ]* ${opt.pttKey} ${tag}`, false)
  const stream = $.process.spawn({ argv: [...cmd, opt.pttKey, tag] })
  pttStream = stream
  void (async () => {
    let buf = ''
    try {
      for await (const c of stream) {
        if (c.stream !== 'stdout') continue
        buf += c.text
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (pttStream === stream) await onPtt($, line)
        }
      }
    } catch {}
  })()
}

function stopPtt() {
  const s = pttStream
  pttStream = null
  if (s) void s.return(undefined as never).catch(() => undefined)
}

async function onPtt($: Engine, line: string) {
  if (line === 'no-permission' || line === 'unsupported') {
    const os = (await platform($)).os
    const msg =
      line === 'unsupported'
        ? '这个系统上不支持把 Fn 当快捷键，换一个键（设置 → 按住说话的键）'
        : os === 'linux'
          ? '快捷键说话要能读键盘：运行 sudo usermod -aG input $USER，然后注销重新登录'
          : '快捷键说话要「输入监控」权限：系统设置 → 隐私与安全性 → 输入监控 里打开 Claude，然后重启 Claude'
    await update($, note, () => msg)
    void $.ui.toast(msg)
    return
  }
  if (line === 'down') {
    if (!(await ownsPtt($))) return
    const p = await read($, phase)
    if (recording || p === 'transcribing' || p === 'refining') return
    pttHeld = true
    pttDownAt = await $.clock.now()
    await startRecording($)
    return
  }
  if (!pttHeld) return
  pttHeld = false
  if (line === 'cancel') return stopRecording($, true)
  if (line === 'up') {
    const short = (await $.clock.now()) - pttDownAt < PTT_MIN_MS
    return stopRecording($, short)
  }
}

// ---------- 光球 ----------

// 每种状态的颜色：桌面 SVG 用渐变两端的色值，终端用 ANSI 颜色名
const ORB_COLOR: Record<OrbMood, { hi: string; lo: string; term: string; beat: string }> = {
  idle: { hi: '#7cc4ff', lo: '#2a4bd7', term: 'blue', beat: '3.2s' },
  listen: { hi: '#ff8a8a', lo: '#d1203a', term: 'red', beat: '0.8s' },
  think: { hi: '#e3a6ff', lo: '#7b2fd0', term: 'magenta', beat: '1.2s' },
  wait: { hi: '#ffe08a', lo: '#d08a10', term: 'yellow', beat: '2s' },
  speak: { hi: '#8af5ff', lo: '#0f9fb8', term: 'cyan', beat: '0.6s' },
}

// 桌面版光球，“智能体”风格（100×100 画布）：
//   能量核：渐变球体，里面两团高光涡旋缓慢对转，核本身随节奏呼吸
//   两条倾斜的椭圆轨道朝相反方向进动，各带一颗沿轨道跑的粒子
//   一段彗星尾一样的渐变弧绕核旋转；最外面一圈呼吸的光晕
//   在听：核外一圈 16 根错落起伏的音柱；在想：再加一段反向快转的弧；在念：一圈圈声波往外扩
// 当图片画（不加 isInteractive）：背景透明，SMIL 动画在图片里照样会动；加了会套一个白底的沙盒框
function orbSvg(mood: OrbMood): string {
  const c = ORB_COLOR[mood]
  const speed = { idle: 1, listen: 2.2, think: 3, wait: 1.2, speak: 2 }[mood]
  const dur = (base: number) => `${(base / speed).toFixed(2)}s`
  const spin = (base: number, reverse = false) =>
    `<animateTransform attributeName="transform" type="rotate" additive="sum" from="${reverse ? 360 : 0} 50 50" to="${reverse ? 0 : 360} 50 50" dur="${dur(base)}" repeatCount="indefinite"/>`
  const loop = (attr: string, values: string, d: string, begin = '0s') =>
    `<animate attributeName="${attr}" values="${values}" dur="${d}" begin="${begin}" repeatCount="indefinite"/>`

  // 倾斜的椭圆轨道 + 一颗粒子；整条轨道再绕中心慢慢转（进动）
  const orbit = (tilt: number, rx: number, ry: number, base: number, reverse: boolean, size: number) => {
    const path = `M${50 - rx},50 a${rx},${ry} 0 1,0 ${rx * 2},0 a${rx},${ry} 0 1,0 ${-rx * 2},0`
    return (
      `<g transform="rotate(${tilt} 50 50)">${spin(base * 4, reverse)}` +
      `<path d="${path}" fill="none" stroke="${c.lo}" stroke-opacity="0.55" stroke-width="0.9" stroke-dasharray="1.5 2.5"/>` +
      `<circle r="${size}" fill="#fff" stroke="${c.lo}" stroke-width="0.5"><animateMotion dur="${dur(base)}" repeatCount="indefinite" path="${path}"${reverse ? ' keyPoints="1;0" keyTimes="0;1" calcMode="linear"' : ''}/></circle>` +
      `<circle r="${size * 2.6}" fill="${c.hi}" opacity="0.35" filter="url(#soft)"><animateMotion dur="${dur(base)}" repeatCount="indefinite" path="${path}"${reverse ? ' keyPoints="1;0" keyTimes="0;1" calcMode="linear"' : ''}/></circle>` +
      `</g>`
    )
  }

  // 绕核转的渐变弧（周长 2π·r，露出 len 那么长）
  const comet = (r: number, len: number, base: number, reverse = false, width = 2.4) => {
    const round = (2 * Math.PI * r).toFixed(1)
    return `<circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#comet)" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${len} ${round}">${spin(base, reverse)}</circle>`
  }

  let extra = ''
  if (mood === 'listen') {
    for (let i = 0; i < 16; i++) {
      const b = `${((i * 7) % 16) * 0.045}s`
      extra +=
        `<rect x="49.1" y="21" width="1.8" height="4" rx="0.9" fill="${c.hi}" transform="rotate(${i * 22.5} 50 50)">` +
        loop('height', '3;9;4;11;3', '0.7s', b) +
        loop('y', '22;16;21;14;22', '0.7s', b) +
        `</rect>`
    }
  } else if (mood === 'speak') {
    for (let i = 0; i < 3; i++) {
      const b = `${(i * 0.6).toFixed(1)}s`
      extra +=
        `<circle cx="50" cy="50" r="22" fill="none" stroke="${c.hi}" stroke-width="1.2">` +
        loop('r', '22;46', '1.8s', b) +
        loop('stroke-opacity', '0.7;0', '1.8s', b) +
        `</circle>`
    }
  }
  if (mood === 'think') extra += comet(26, 22, 0.9, true, 1.6)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" style="background:transparent">` +
    `<defs>` +
    `<radialGradient id="core" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="0.28" stop-color="${c.hi}"/><stop offset="0.8" stop-color="${c.lo}"/><stop offset="1" stop-color="#05061a"/></radialGradient>` +
    `<radialGradient id="halo"><stop offset="0.35" stop-color="${c.hi}" stop-opacity="0.55"/><stop offset="1" stop-color="${c.hi}" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="comet" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.lo}" stop-opacity="0"/><stop offset="0.7" stop-color="${c.lo}"/><stop offset="1" stop-color="${c.hi}"/></linearGradient>` +
    `<filter id="soft" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.6"/></filter>` +
    `<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>` +
    `<clipPath id="inside"><circle cx="50" cy="50" r="19"/></clipPath>` +
    `</defs>` +
    // 光晕
    `<circle cx="50" cy="50" r="47" fill="url(#halo)">${loop('opacity', '0.45;0.9;0.45', c.beat)}</circle>` +
    extra +
    orbit(-28, 40, 13, 3.2, false, 1.3) +
    orbit(38, 36, 11, 4.4, true, 1.1) +
    comet(31, 34, 2.6) +
    // 核：外发光 + 球体 + 里面的涡旋高光
    `<circle cx="50" cy="50" r="22" fill="${c.hi}" opacity="0.5" filter="url(#glow)">${loop('r', '20;24;20', c.beat)}</circle>` +
    `<circle cx="50" cy="50" r="19" fill="url(#core)">${loop('r', '18.5;20;18.5', c.beat)}</circle>` +
    `<g clip-path="url(#inside)">` +
    `<g>${spin(7)}<ellipse cx="50" cy="44" rx="15" ry="5" fill="#fff" opacity="0.28" filter="url(#soft)"/></g>` +
    `<g>${spin(11, true)}<ellipse cx="50" cy="57" rx="13" ry="4" fill="${c.hi}" opacity="0.45" filter="url(#soft)"/></g>` +
    `</g>` +
    `<circle cx="50" cy="50" r="19" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="0.6"/>` +
    `</svg>`
  )
}

// ---------- 设置 ----------
//
// /minty settings 打开一个面板，直接看和改所有设置，改完立刻生效、不用重启。
// 面板里改的值存在插件自己的存储（$.store）里，下次启动也还在，并且优先于 settings.json 里的
// pluginConfigs；“恢复默认”清掉它们。

const SETTINGS_PANE = 'minty-settings'
const PREFS_KEY = 'settings'

type Field = {
  key: keyof typeof opt
  title: string
  help: string
  choices?: readonly { value: string; label: string }[]
}

const ON_OFF = [
  { value: 'true', label: '开' },
  { value: 'false', label: '关' },
] as const

const FIELDS: readonly Field[] = [
  { key: 'name', title: '名字', help: '助手叫什么：面板标题、它自我介绍都用这个名字' },
  { key: 'command', title: '命令', help: '斜杠命令的名字（只能小写英文、数字和 -），如 minty → /minty。改完新命令马上能用，旧的重启后消失' },
  {
    key: 'route',
    title: '什么时候发给 Claude Code',
    help: '自动判断：要它干活才发，聊天、问天气就自己答；全部发：说的每句话都整理好发过去（以前的样子）',
    choices: [{ value: 'auto', label: '自动判断' }, { value: 'always', label: '全部发' }],
  },
  { key: 'city', title: '城市', help: '问天气没说地方时查哪儿，如 Seattle、上海；空着就按网络位置猜（天气服务 wttr.in 会看到你的 IP）' },
  { key: 'uiStyle', title: '界面', help: '光球：只留一个转圈按钮；横栏：输入框上方一条，先预览再发', choices: [{ value: 'orb', label: '光球' }, { value: 'bar', label: '横栏' }] },
  { key: 'avatar', title: '形象', help: '面板里画哪套动画；自己做的用 tools/make-avatar.sh 生成到 ~/.claude/minty/avatars/' },
  { key: 'speakReplies', title: '朗读回复', help: '关掉后什么都不念', choices: ON_OFF },
  { key: 'ttsEngine', title: '朗读引擎', help: 'edge 自然、需联网（念的话会发到微软语音服务）；say 是系统自带的朗读、离线（macOS say / Windows System.Speech / Linux espeak-ng）', choices: [{ value: 'edge', label: 'edge 神经网络声音' }, { value: 'say', label: 'macOS say' }] },
  {
    key: 'edgeVoice',
    title: '声音',
    help: 'edge 的声音',
    choices: [
      { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声温和' },
      { value: 'zh-CN-YunxiNeural', label: '云希 · 男声阳光' },
      { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声活泼' },
      { value: 'zh-CN-YunyangNeural', label: '云扬 · 男声播音腔' },
    ],
  },
  { key: 'speechRate', title: '语速', help: '相对正常语速，如 +0%、+15%、-10%' },
  { key: 'voice', title: 'say 的声音', help: 'macOS 的系统声音名，edge 用不了时也用它，如 Tingting（Windows / Linux 用系统默认声音，不看这一项）' },
  { key: 'refineModel', title: '模型', help: '整理指令、快脑回应、念的总结都用它', choices: [{ value: 'haiku', label: 'haiku · 快' }, { value: 'sonnet', label: 'sonnet' }, { value: 'opus', label: 'opus · 慢' }] },
  { key: 'language', title: '识别语言', help: '中英混说用 zh 最稳', choices: [{ value: 'zh', label: 'zh' }, { value: 'auto', label: 'auto' }, { value: 'en', label: 'en' }] },
  { key: 'vocabulary', title: '常用词', help: '容易被听错的英文词，逗号分隔' },
  { key: 'autoSend', title: '整理完自动发送', help: '横栏界面：跳过预览直接发', choices: ON_OFF },
  { key: 'autoFill', title: '整理完放进输入框', help: '横栏界面：跳过预览，填进输入框改', choices: ON_OFF },
  {
    key: 'pttKey',
    title: '按住说话的键',
    help: '在任何 App 里按住它就开始录，松开发出；按住时按了别的键就不算。最近用过的那个会话接这个键',
    choices: [
      { value: 'right-option', label: '右 Option' },
      { value: 'right-command', label: '右 Command' },
      { value: 'right-control', label: '右 Control' },
      { value: 'fn', label: 'Fn / 🌐' },
      { value: 'off', label: '关' },
    ],
  },
  { key: 'whisperModel', title: 'Whisper 模型', help: 'ggml 模型文件路径' },
]

// manifest 里的默认值 + settings.json 的 pluginConfigs（register 时拿到）
let baseOptions: Record<string, unknown> = {}
const DEFAULTS = { ...opt }

// 把一组设置值套到 opt 上；每一项都校验，不合法的忽略
function applyOptions(options: Record<string, unknown>) {
  const str = (k: string) => (typeof options[k] === 'string' ? (options[k] as string) : undefined)
  const bool = (k: string) => (typeof options[k] === 'boolean' ? (options[k] as boolean) : str(k) === 'true' ? true : str(k) === 'false' ? false : undefined)
  const pick = <T extends string>(k: string, allowed: readonly T[]) => {
    const v = str(k)
    return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : undefined
  }
  opt.whisperModel = str('whisperModel') || opt.whisperModel
  opt.language = pick('language', ['zh', 'auto', 'en']) ?? opt.language
  opt.refineModel = pick('refineModel', ['haiku', 'sonnet', 'opus']) ?? opt.refineModel
  opt.voice = str('voice') || opt.voice
  opt.ttsEngine = pick('ttsEngine', ['edge', 'say']) ?? opt.ttsEngine
  opt.edgeVoice = str('edgeVoice') || opt.edgeVoice
  const rate = str('speechRate')
  if (rate && /^[+-]\d{1,3}%$/.test(rate)) opt.speechRate = rate
  if (str('vocabulary') !== undefined) opt.vocabulary = str('vocabulary')!
  opt.autoSend = bool('autoSend') ?? opt.autoSend
  opt.autoFill = bool('autoFill') ?? opt.autoFill
  opt.speakReplies = bool('speakReplies') ?? opt.speakReplies
  opt.uiStyle = pick('uiStyle', ['orb', 'bar']) ?? opt.uiStyle
  opt.route = pick('route', ['auto', 'always']) ?? opt.route
  if (str('city') !== undefined && str('city')!.length <= 60) opt.city = str('city')!.trim()
  const avatar = str('avatar')
  if (avatar && /^[A-Za-z0-9_.-]+$/.test(avatar)) opt.avatar = avatar
  const name = str('name')?.trim()
  if (name && name.length <= 24) opt.name = name
  const command = str('command')?.trim()
  if (command && /^[a-z][a-z0-9-]{0,23}$/.test(command)) opt.command = command
  opt.pttKey = pick('pttKey', PTT_KEYS) ?? opt.pttKey
}

// 设置文件：setup.sh 和设置面板都写它，只存改过的项。优先级：manifest 默认 < settings.json 的 pluginConfigs < 这个文件
async function configPath($: Engine): Promise<string> {
  return join(await platform($), await dataDir($), 'config.json')
}

async function readConfig($: Engine): Promise<Record<string, string | boolean>> {
  try {
    const v = JSON.parse(await $.fs.read(await configPath($))) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, string | boolean>
  } catch {}
  return {}
}

async function writeConfig($: Engine, config: Record<string, string | boolean>) {
  try {
    await makeDir($, await dataDir($))
    await $.fs.write(await configPath($), JSON.stringify(config, null, 2) + '\n')
  } catch {}
  await update($, prefs, () => config)
}

// 启动和热重载时读设置文件。以前的版本把面板里改的值存在 $.store：并进设置文件，以后只认文件
async function loadPrefs($: Engine) {
  let config = await readConfig($)
  try {
    const old = await $.store.get(PREFS_KEY)
    if (old && typeof old === 'object') {
      config = { ...(old as Record<string, string | boolean>), ...config }
      await writeConfig($, config)
      await $.store.delete(PREFS_KEY)
    }
  } catch {}
  Object.assign(opt, DEFAULTS)
  applyOptions(baseOptions)
  applyOptions(config)
  await update($, prefs, () => config)
}

async function setPref($: Engine, field: Field, raw: string): Promise<string> {
  const value: string | boolean = typeof DEFAULTS[field.key] === 'boolean' ? raw === 'true' : raw.trim()
  const before = String(opt[field.key])
  applyOptions({ [field.key]: value })
  if (String(opt[field.key]) !== String(value)) return `“${raw}”不是有效的${field.title}，没改`
  await writeConfig($, { ...(await readConfig($)), [field.key]: value })
  if (field.key === 'uiStyle' && before !== String(value) && (await read($, phase)) === 'idle') await setPhase($, 'idle')
  if (field.key === 'pttKey' && before !== String(value)) {
    await claimPtt($)
    await startPtt($)
  }
  if (field.key === 'command' && before !== String(value)) await registerCommand($)
  if (field.key === 'avatar' && before !== String(value)) {
    await update($, idleVariant, () => '')
    await scheduleIdle($)
  }
  return `${field.title}：${shown(field)}`
}

// 恢复默认：名字和命令是装的时候起的，留着
async function resetPrefs($: Engine) {
  const key = opt.pttKey
  const old = await readConfig($)
  const keep: Record<string, string | boolean> = {}
  for (const k of ['name', 'command'] as const) if (k in old) keep[k] = old[k]!
  await writeConfig($, keep)
  Object.assign(opt, DEFAULTS)
  applyOptions(baseOptions)
  applyOptions(keep)
  if (opt.pttKey !== key) await startPtt($)
}

// 有选项的设置；形象的选项是扫出来的形象包；快捷键按系统叫法
function choicesOf(f: Field): readonly { value: string; label: string }[] | undefined {
  if (f.key === 'avatar') return [...packs.map(p => ({ value: p.id, label: p.name })), { value: 'orb', label: '光球' }]
  if (f.key === 'pttKey' && currentOs !== 'mac')
    return [
      { value: 'right-option', label: '右 Alt' },
      { value: 'right-command', label: currentOs === 'windows' ? '右 Win' : '右 Super' },
      { value: 'right-control', label: '右 Ctrl' },
      { value: 'off', label: '关' },
    ]
  return f.choices
}

function shown(f: Field): string {
  const v = String(opt[f.key])
  return choicesOf(f)?.find(c => c.value === v)?.label ?? (v === '' ? '（空）' : v)
}

// ---------- MINTY 面板：停在对话旁边的大猫 ----------

const PANEL = 'minty'
// 面板里的形象跟着面板大小走：宽度撑满面板（Svg 不给宽高，按图本身的宽度、最多到面板宽），
// 高度按面板剩下的行数算。面板的尺寸只给“格”（代码字体的字宽、行高），一格的高宽比大约是这个数
const CELL_ASPECT = 2.3
// 文字一行占几格宽：中文算两格
const textCells = (s: string) => [...s].reduce((n, c) => n + (/[\u2E80-\uFFFF]/.test(c) ? 2 : 1), 0)

async function openPanel($: Engine) {
  try {
    const r = await $.ui.open({ id: PANEL, title: opt.name })
    await update($, panelOpen, () => r.isPlaced)
  } catch {
    await update($, panelOpen, () => false)
  }
}

async function openSettings($: Engine) {
  await $.ui.open({ id: SETTINGS_PANE, title: `${opt.name} 设置` })
}

// ---------- 形象包 ----------
//
// 一个形象包是一个文件夹：pack.json（{"name": "猫"}）+ 每个状态一段动画图片（idle.avif、listen.avif …，
// 也可以是 .webp / .gif / .png / .svg）。只有 idle 是必须的，缺的状态用 idle。
// 自带的在插件的 avatars/ 里，自己做的（tools/make-avatar.sh）放 ~/.claude/minty/avatars/，同名的以自己的为准。
// 桌面版用 Svg 元素画，一个 SVG 最多 128 KB：图片转成 base64 后超过 AVATAR_MAX 的不用。

// variants：待命的变化（idle-yawn、idle-groom…），durations：每段放一遍多少秒（pack.json 里写的）
type Pack = { id: string; name: string; dir: string; variants: string[]; durations: Record<string, number> }
const AVATAR_MAX = 125_000
const IMAGE_TYPES: Record<string, string> = { avif: 'image/avif', webp: 'image/webp', gif: 'image/gif', png: 'image/png', apng: 'image/apng', svg: 'image/svg+xml' }
let packs: Pack[] = []
let packsScanned = false
const avatarCache = new Map<string, string | null>()

async function dataDir($: Engine): Promise<string> {
  return (await platform($)).dataDir
}

async function scanPacks($: Engine) {
  const found: Pack[] = []
  for (const base of [`${$.plugin.root}/avatars`, `${await dataDir($)}/avatars`]) {
    let entries: { name: string; kind: string }[] = []
    try {
      entries = await $.fs.list(base)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.kind === 'file' || e.name.startsWith('.')) continue
      const dir = `${base}/${e.name}`
      let name = e.name
      let durations: Record<string, number> = {}
      try {
        const j = JSON.parse(await $.fs.read(`${dir}/pack.json`)) as { name?: unknown; durations?: unknown }
        if (typeof j.name === 'string' && j.name.trim()) name = j.name.trim()
        if (j.durations && typeof j.durations === 'object') durations = j.durations as Record<string, number>
      } catch {}
      let variants: string[] = []
      try {
        variants = [...new Set((await $.fs.list(dir)).map(f => /^(idle-[A-Za-z0-9_-]+)\.(avif|webp|gif|png|svg)$/.exec(f.name)?.[1]).filter((v): v is string => !!v))].sort()
      } catch {}
      const i = found.findIndex(p => p.id === e.name)
      if (i >= 0) found.splice(i, 1)
      found.push({ id: e.name, name, dir, variants, durations })
    }
  }
  packs = found
  packsScanned = true
  avatarCache.clear()
}

// 这个状态（或待命的某段变化）的图片，转成 data URI；没有就用 idle 的
async function packImage($: Engine, pack: Pack, mood: string): Promise<string | null> {
  const key = `${pack.dir}/${mood}`
  if (avatarCache.has(key)) return avatarCache.get(key)!
  let uri: string | null = null
  for (const state of mood === 'idle' ? ['idle'] : [mood, 'idle']) {
    for (const [ext, type] of Object.entries(IMAGE_TYPES)) {
      const path = `${pack.dir}/${state}.${ext}`
      if (!(await $.fs.exists(path))) continue
      try {
        const { base64 } = await $.fs.read(path, { as: 'bytes' })
        if (base64.length <= AVATAR_MAX) uri = `data:${type};base64,${base64}`
        else await update($, note, () => `形象「${pack.name}」的 ${state}.${ext} 太大（超过 90 KB），用 tools/make-avatar.sh 重新压一下`)
      } catch {}
      break
    }
    if (uri) break
  }
  avatarCache.set(key, uri)
  return uri
}

// 待命的变化：平时放 idle，每放完 2~4 遍随机插播一段变化，变化放完一遍接回 idle。
// 只在真的待命时插（不在听、不在想、不在说）。换图时动画从第一帧开始放；变化片段从 idle 的第一帧出发、回到它结束，
// 所以只在 idle 正好放回第一帧的那一刻换上去（按它开始放的时间算），放完一遍（pack.json 里的时长）再换回来
let idleTimer: { cancel: () => void } | null = null
let lastVariant = ''
// 面板上现在画的是哪段动画、从什么时候开始放的（画面换了图就从头放）
let shownKey = ''
let shownAt = 0
// 离 idle 放回第一帧还差多少毫秒以内就算“正好”
const LOOP_SLACK_MS = 120

function currentPack(): Pack | undefined {
  return opt.avatar === 'orb' ? undefined : packs.find(p => p.id === opt.avatar)
}

async function scheduleIdle($: Engine) {
  idleTimer?.cancel()
  idleTimer = null
  const pack = currentPack()
  if (!pack || pack.variants.length === 0) return
  const loop = (pack.durations.idle ?? 6) * 1000
  const wait = loop * (2 + Math.floor(Math.random() * 3))
  // 挂定时器之前先经过一次引擎调用：在 session.start 里不经过任何调用就直接挂上的定时器不会触发（测试里实测）
  await $.clock.now()
  ;(idleTimer as { cancel: () => void } | null)?.cancel() // 等待期间可能又排了一个
  idleTimer = $.clock.after(wait, () => void playVariant($))
}

async function playVariant($: Engine) {
  const pack = currentPack()
  if (!pack || pack.variants.length === 0) return
  const { mood } = await orbLook($, '')
  if (mood === 'idle' && (await read($, panelOpen))) {
    // 等 idle 放回第一帧再换：画面上的 idle 是 shownAt 开始放的
    const loop = (pack.durations.idle ?? 6) * 1000
    if (shownKey === `${pack.dir}/idle`) {
      const phase = ((await $.clock.now()) - shownAt) % loop
      if (phase > LOOP_SLACK_MS && loop - phase > LOOP_SLACK_MS) {
        idleTimer = $.clock.after(loop - phase, () => void playVariant($))
        return
      }
    }
    const choices = pack.variants.length > 1 ? pack.variants.filter(v => v !== lastVariant) : pack.variants
    const v = choices[Math.floor(Math.random() * choices.length)]!
    lastVariant = v
    await update($, idleVariant, () => v)
    idleTimer = $.clock.after((pack.durations[v] ?? 3) * 1000, () => {
      void update($, idleVariant, () => '').then(() => scheduleIdle($))
    })
    return
  }
  await scheduleIdle($)
}

// 面板里画什么：选了形象包、而且找得到图就画它，否则画光球
// aspect：画出来的高 ÷ 宽（≤ 1）。图在里面保持正方形、左右居中；markup 给得很宽，显示时缩到面板宽
async function avatarSvg($: Engine, mood: OrbMood, aspect = 1): Promise<string> {
  if (opt.avatar !== 'orb') {
    if (!packsScanned) await scanPacks($)
    const pack = packs.find(p => p.id === opt.avatar)
    const variant = mood === 'idle' ? await read($, idleVariant) : ''
    const clip = variant && pack?.variants.includes(variant) ? variant : mood
    const uri = pack ? await packImage($, pack, clip) : null
    if (uri) {
      const key = `${pack!.dir}/${uri === (await packImage($, pack!, 'idle')) && clip !== 'idle' && !clip.startsWith('idle-') ? 'idle' : clip}`
      if (key !== shownKey) {
        shownKey = key
        shownAt = await $.clock.now()
      }
      const px = 320
      const vw = Math.round(px / aspect)
      return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${vw * 8}" height="${px * 8}" viewBox="0 0 ${vw} ${px}" style="background:transparent">` +
        `<image href="${uri}" x="${(vw - px) / 2}" width="${px}" height="${px}"/></svg>`
      )
    }
  }
  return orbSvg(mood)
}

// ---------- 按钮动作 ----------

async function registerCommand($: Engine) {
  try {
    await $.command.register({
      name: opt.command,
      description: `${opt.name} 语音：开始/结束录音；panel 打开面板；settings 设置；check 检查依赖；speak 开关朗读全部回复；stop 停止`,
      argumentHint: '[panel|settings|check|speak|stop]',
      immediate: true,
    })
  } catch {}
}

async function toggle($: Engine) {
  const p = await read($, phase)
  if (p === 'recording') return stopRecording($)
  if (p === 'transcribing' || p === 'refining') return
  if (p === 'speaking') stopSpeaking()
  return startRecording($)
}

async function stopAll($: Engine) {
  stopSpeaking()
  if (recording) await stopRecording($, true)
  else await setPhase($, 'idle')
}

async function checkSetup($: Engine): Promise<string> {
  const sox = await findBin($, ['sox'])
  const whisper = await findBin($, ['whisper-cli', 'whisper-cpp'])
  const model = await modelPath($)
  const hasModel = await $.fs.exists(model)
  const edge = await findEdgeTts($)
  const os = (await platform($)).os
  // 真的合成一个字试试：edge-tts 装着不代表微软那边能用
  let edgeOk: boolean | null = null
  if (opt.ttsEngine === 'edge' && edge) {
    const pf = await platform($)
    const probe = join(pf, pf.tmp, `minty-tts-check-${await $.clock.now()}.mp3`)
    try {
      const r = await $.process.run([...edge, `--voice=${opt.edgeVoice}`, '--text=好', `--write-media=${probe}`], { timeoutMs: 20_000 })
      edgeOk = r.exitCode === 0
      if (!edgeOk) lastEdgeError = (r.stderr.trim().split('\n').pop() ?? '').slice(0, 120)
    } catch (err) {
      edgeOk = false
      lastEdgeError = String(err).slice(0, 120)
    }
    void removeFile($, probe)
  }
  const player = os === 'mac' ? true : !!(await playerFor($))
  const sysVoice = { mac: `macOS say，声音 ${opt.voice}`, linux: 'espeak-ng', windows: 'Windows 自带的朗读' }[os]
  return [
    `· 系统 ${{ mac: 'macOS', linux: 'Linux', windows: 'Windows' }[os]}`,
    `${sox ? '✓' : '✗'} sox ${sox ?? '— ' + installHint(os, 'sox')}`,
    `${whisper ? '✓' : '✗'} whisper.cpp ${whisper ?? '— ' + installHint(os, 'whisper')}`,
    `${hasModel ? '✓' : '✗'} 模型 ${model}${hasModel ? '' : ' — 见 README 下载'}`,
    opt.ttsEngine === 'edge'
      ? edge
        ? `${edgeOk ? '✓' : '✗'} 朗读 edge-tts ${edgeOk ? '能合成' : `合成失败（${lastEdgeError || '原因不明'}），会退回${sysVoice}`}，声音 ${opt.edgeVoice}，语速 ${opt.speechRate}`
        : `✗ 朗读 edge-tts — uv tool install edge-tts（没装会退回${sysVoice}）`
      : `· 朗读 ${sysVoice}`,
    ...(opt.ttsEngine === 'edge' && !player ? [`✗ 放语音的程序（ffplay / mpv）— ${installHint(os, 'player')}；没装会退回${sysVoice}`] : []),
    `· 界面 ${opt.uiStyle === 'orb' ? '光球（终端在右下角，桌面在输入框右上方）' : '横栏'}`,
    `· 朗读回复 ${opt.speakReplies ? '开' : '关（什么都不念）'}`,
    `· 整理/总结模型 ${opt.refineModel}，识别语言 ${opt.language}，整理完 ${opt.autoSend ? '直接发送' : opt.autoFill ? '放进输入框' : '先预览'}`,
    `· 常用词 ${opt.vocabulary.trim() || '（没填，只用对话里出现的词）'}`,
    `· ${opt.route === 'auto' ? '聊天自己答，要干活才发给 Claude Code' : '每句都发给 Claude Code'}${opt.city ? `，天气默认查 ${opt.city}` : ''}`,
    `· 名字 ${opt.name}，命令 /${opt.command}，形象 ${opt.avatar === 'orb' ? '光球' : (packs.find(p => p.id === opt.avatar)?.name ?? `${opt.avatar}（没找到，画光球）`)}`,
    `· 按住说话的键 ${opt.pttKey === 'off' ? '关' : opt.pttKey}${pttStream ? '（在监听）' : '（没在监听）'}`,
  ].join('\n')
}

function cleanTranscript(out: string): string {
  return out
    .split('\n')
    .map(l => l.replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/, '').trim())
    .filter(l => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SOUND)\]$/i.test(l) && !/^[(（](音乐|掌声|笑声)[)）]$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    // whisper 在中文后面常给半角标点、中英之间常不留空格：“修好了,TypeScript” → “修好了，TypeScript”
    .replace(/([\u3400-\u9fff])\s*,\s*/g, '$1，')
    .replace(/\s*,\s*([\u3400-\u9fff])/g, '，$1')
    .replace(/([\u3400-\u9fff])\s*\?/g, '$1？')
    .replace(/([\u3400-\u9fff])\s*!/g, '$1！')
    .replace(/([\u3400-\u9fff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9.%])([\u3400-\u9fff])/g, '$1 $2')
}

function firstLine(s: string): string {
  return (s.trim().split('\n').find(l => l.trim()) ?? '').slice(0, 160)
}

// ---------- 事件 ----------

export const register: Register = (on, options) => {
  cached = null // 系统重新判断（热重载、测试里换了环境）
  baseOptions = { ...options }
  applyOptions(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 热重载后录音/朗读进程已经没了：清掉卡在中途的状态
    await loadPrefs($)
    if (opt.uiStyle === 'orb') void openPanel($)
    // 新开的会话先认领快捷键；监听程序在后台起（第一次要编译，不挡着会话启动）
    await claimPtt($)
    void startPtt($)
    const p = await read($, phase)
    if (p !== 'idle' && p !== 'review') await setPhase($, 'idle')
    await registerCommand($)
    await scanPacks($)
    await update($, idleVariant, () => '')
    await scheduleIdle($)
    return started
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== opt.command) return next(e)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'check') return { text: await checkSetup($) }
    if (arg === 'panel' || arg === '面板' || arg === 'cat') {
      await openPanel($)
      return {}
    }
    if (arg === 'settings' || arg === 'config' || arg === '设置') {
      await openSettings($)
      return {}
    }
    if (arg === 'stop') {
      await stopAll($)
      return {}
    }
    if (arg === 'speak') {
      const now = !(await read($, speakAll))
      await update($, speakAll, () => now)
      return { text: now ? '之后每条回复都会念总结' : '只念语音发起的那条回复的总结' }
    }
    void toggle($)
    return {}
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await update($, working, () => false)
      const wanted = speakNextAnswer || (await read($, speakAll))
      speakNextAnswer = false
      const answered = e.reason === 'answer' && e.answer.trim() !== ''
      if (answered && opt.speakReplies && wanted) void speakSummary($, e.answer)
    }
    return result
  })

  // 用户自己打字发消息时，停止朗读
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      await claimPtt($) // 在这个会话里打字发了消息：快捷键归它
      if ((await read($, phase)) === 'speaking') await stopAll($)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // 主 Session 在不在忙：光球转紫色，快脑也据此说“排在后面”
  on('turn.start', async ($, e, next) => {
    await update($, working, () => true)
    return next(e)
  })

  // 光球（Client）发来的按下 / 放开
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'orb') return next(e)
    const type = typeof e.data === 'object' && e.data !== null ? (e.data as { type?: unknown }).type : undefined
    if (type === 'down') await orbDown($)
    else if (type === 'up') await orbUp($)
    return {}
  })

  // MINTY 面板：上面一只大猫，下面是它在说的整段话（或听到的话），再下面是按钮。
  // 没有“说话”按钮：点猫就开始录，再点一下说完。终端的猫是 Client，自己收按下/放开（ui.message）；
  // 桌面的猫是 Svg，点不了，所以猫正下方那行状态字本身就是按钮，点它等于点猫
  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const p = await read($, phase)
    // 终端的猫是 Client（字符小球），自己收按下/放开；其他界面的猫是图片，点不了
    const catTaps = e.surface === 'terminal' && 'Client' in els
    const { mood, label } = await orbLook($, catTaps ? '点猫说话' : '点我说话')
    const line = await read($, said)
    const heard = await read($, raw)
    const saying = mood === 'speak'
    const cols = Math.max(16, e.props.bodyColumns - 2)
    const rows = Math.max(12, e.props.scroll.bodyRows)
    // 形象下面的文字和按钮占几行：状态一行、听到的话和说的话按宽度折行、按钮一行、间距
    const wrapRows = (s: string) => (s ? Math.ceil(textCells(s) / cols) : 0)
    const shownHeard = p !== 'idle' && p !== 'recording' && heard !== '' && !saying ? '听到：' + heard : ''
    const textRows = 4 + wrapRows(shownHeard) + wrapRows(line)
    // 形象能占的高 ÷ 宽：面板瘦高时撑满宽度（正方形），矮宽时按剩下的高度来
    const petAspect = Math.min(1, Math.max(0.3, ((rows - textRows - 2) * CELL_ASPECT) / cols))
    const svg = 'Svg' in els ? await avatarSvg($, mood, petAspect) : ''
    const pet = catTaps ? (
      <els.Client key="orb" module="./orb.tsx" props={{ mood }} width={6} />
    ) : 'Svg' in els ? (
      svg.includes('<image') ? (
        <els.Svg source={svg} alt={`${opt.name}：${label}`} />
      ) : (
        // 光球（没选形象包、或者包里没图）：光球的 SVG 是 100 × 100 的，按面板宽度给个尺寸
        <els.Svg source={svg} alt={`${opt.name}：${label}`} width={180} height={180} />
      )
    ) : null
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" width={cols} minHeight={rows - 1}>
        {pet}
        {catTaps ? (
          <Text bold color={ORB_COLOR[mood].term}>
            {label}
          </Text>
        ) : (
          <Button key="panel-talk" plain label={label} onPress={() => void orbTap($)} />
        )}
        {p !== 'idle' && p !== 'recording' && heard !== '' && !saying ? (
          <Text dimColor wrap="wrap">
            听到：{heard}
          </Text>
        ) : null}
        {line !== '' ? (
          <Text color={saying ? 'cyan' : undefined} dimColor={!saying} wrap="wrap">
            {line}
          </Text>
        ) : null}
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          {saying && <Button key="panel-hush" label="⏹ 停" onPress={() => hushOrb()} />}
          <Button key="panel-settings" plain dimColor label="⚙ 设置" onPress={() => void openSettings($)} />
        </Box>
      </Box>
    )
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANEL) await update($, panelOpen, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const changed = await read($, prefs)
    const msg = await read($, note)
    if (!packsScanned) await scanPacks($)
    const rows = FIELDS.map(f => {
      const mark = f.key in changed ? '•' : ' '
      const choices = choicesOf(f)
      let control: RenderElement
      if (choices && 'Select' in els) {
        control = (
          <els.Select
            key={`set-${f.key}`}
            options={choices}
            value={String(opt[f.key])}
            onSelect={v => void setPref($, f, v).then(m => update($, note, () => m))}
          />
        )
      } else if (choices) {
        // 没有下拉框的界面：点一下换到下一个选项
        const i = choices.findIndex(c => c.value === String(opt[f.key]))
        const nextChoice = choices[(i + 1) % choices.length]!
        control = (
          <Button
            key={`set-${f.key}`}
            label={shown(f)}
            onPress={() => void setPref($, f, nextChoice.value).then(m => update($, note, () => m))}
          />
        )
      } else if ('Input' in els) {
        control = (
          <els.Input
            key={`set-${f.key}`}
            value={String(opt[f.key])}
            placeholder={f.help}
            submitLabel="保存"
            onSubmit={v => void setPref($, f, v).then(m => update($, note, () => m))}
          />
        )
      } else {
        control = <Text>{shown(f)}</Text>
      }
      return (
        <Box key={`row-${f.key}`} flexDirection="column" marginBottom={1}>
          <Text bold>
            {mark} {f.title}
          </Text>
          {control}
          <Text dimColor wrap="wrap">
            {'  '}
            {f.help}
          </Text>
        </Box>
      )
    })
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">
          改完立刻生效，下次启动也保留。• 表示改过的项。
        </Text>
        {msg !== '' && <Text color="green">{msg}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {rows}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          <Button key="set-reset" label="恢复默认" onPress={() => void resetPrefs($).then(() => update($, note, () => '已恢复默认'))} />
          <Button key="set-check" label="检查依赖" onPress={() => void checkSetup($).then(t => update($, note, () => t.split('\n').filter(l => l.startsWith('✗')).join('；') || '依赖都齐了 ✓'))} />
        </Box>
      </Box>
    )
  })

  // 终端：窗口右下角——输入框下面那一行的最右边，只放一个会转的光球（按住说话）
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (opt.uiStyle !== 'orb' || e.surface !== 'terminal') return next(e)
    const els = $.ui.resolve(e)
    if (!('Client' in els)) return next(e)
    const { Box, Text, Client } = els
    const { mood, label } = await orbLook($, '按住说话')
    const modes = e.props.modes.join(' & ')
    return (
      <Box flexDirection="row" columnGap={2} justifyContent="flex-end">
        {modes !== '' && <Text dimColor>{modes}</Text>}
        <Client key="orb" module="./orb.tsx" props={{ mood, label, mini: true }} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const orbPhase = await read($, phase)
    if (opt.uiStyle === 'orb' && orbPhase !== 'review') {
      // 光球 / 桌宠模式：MINTY 住在旁边的面板里，输入框上方不再放东西。
      // 终端的转圈按钮在右下角那一行；面板被关掉时这里只留一个按钮把它叫回来
      if (e.surface === 'terminal' || (await read($, panelOpen))) return next(e)
      const { Box, Button } = $.ui.resolve(e)
      const width = Math.max(20, e.props.bodyColumns)
      const reopen = (
        <Box flexDirection="row" width={width} justifyContent="flex-end">
          <Button key="open-panel" plain dimColor label={`${opt.avatar === 'orb' ? '●' : '🐾'} ${opt.name}`} onPress={() => void openPanel($)} />
        </Box>
      )
      const theirs = await next(e)
      return theirs ? (
        <Box flexDirection="column">
          {theirs}
          {reopen}
        </Box>
      ) : (
        reopen
      )
    }
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // 终端的光球是 Client，点它就开始说；桌面的光球是图片，旁边那行“点我说话”才是点击区
    const orbTaps = e.surface === 'terminal' && 'Client' in els
    const p = await read($, phase)
    const msg = await read($, note)
    const all = await read($, speakAll)
    const rawText = await read($, raw)
    const refinedText = await read($, refined)
    const width = Math.max(20, e.props.bodyColumns)

    // 左边：在说什么、听到什么；右边：状态、所有按钮、光球
    let mood: OrbMood = 'idle'
    let status = opt.name
    let info: RenderElement | null = null
    let controls: RenderElement[] = []
    const dimLine = (text: string, wrap: 'wrap' | 'truncate-end' = 'truncate-end') =>
      text ? (
        <Text dimColor wrap={wrap}>
          {text}
        </Text>
      ) : null

    if (p === 'recording') {
      mood = 'listen'
      status = '录音中'
      controls = [
        <Button key="stop" plain hotkey="0" label="说完了" onPress={() => void stopRecording($)} />,
        <Button key="cancel" plain hotkey="9" dimColor label="取消" onPress={() => void stopAll($)} />,
      ]
    } else if (p === 'transcribing' || p === 'refining') {
      mood = 'think'
      status = p === 'transcribing' ? '转写中…' : '整理中…'
    } else if (p === 'review') {
      mood = 'wait'
      status = '要发吗？'
      info = (
        <Box flexDirection="column">
          {dimLine('听到：' + rawText)}
          <Text wrap="wrap">{refinedText}</Text>
        </Box>
      )
      controls = [
        <Button key="send" plain hotkey="1" label="发送" onPress={() => void send($)} />,
        <Button key="edit" plain hotkey="2" label="改一下" onPress={() => void editInPrompt($)} />,
        <Button key="redo" plain hotkey="3" label="重说" onPress={() => void startRecording($)} />,
        <Button key="discard" plain hotkey="9" dimColor label="算了" onPress={() => void setPhase($, 'idle')} />,
      ]
    } else if (p === 'speaking') {
      mood = 'speak'
      status = '在念'
      info = dimLine(refinedText, 'wrap')
      controls = [<Button key="hush" plain hotkey="0" label="别念了" onPress={() => void stopAll($)} />]
    } else {
      info = dimLine(msg)
      controls = [
        <Button
          key="speak-all"
          plain
          hotkey="9"
          dimColor
          label={!opt.speakReplies ? '朗读：已关' : all ? '全部朗读：开' : '全部朗读：关'}
          onPress={() => update($, speakAll, v => !v)}
        />,
      ]
    }

    // 光球：终端用会动的字符小球（画面线程上自己跑动画），桌面用带 SMIL 动画的 SVG
    const orb =
      orbTaps ? (
        <els.Client key="orb" module="./orb.tsx" props={{ mood }} width={6} />
      ) : 'Svg' in els ? (
        <els.Svg source={orbSvg(mood)} alt={`${opt.name}：${status}`} width={56} height={56} />
      ) : null

    const mine = (
      <Box flexDirection="row" width={width} justifyContent="space-between" alignItems="flex-end" columnGap={2}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {info}
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          <Box flexDirection="column" alignItems="flex-end">
            {p === 'idle' && !orbTaps ? (
              <Button key="talk" plain label="点我说话" onPress={() => void toggle($)} />
            ) : (
              <Text color={ORB_COLOR[mood].term} bold>
                {p === 'idle' ? '点光球说话' : status}
              </Text>
            )}
            <Box flexDirection="row" columnGap={2}>
              {controls}
            </Box>
          </Box>
          {orb}
        </Box>
      </Box>
    )

    // 和其他 mod 共用这条横栏：把它们的内容放在下面
    const theirs = await next(e)
    if (!theirs) return mine
    return (
      <Box flexDirection="column">
        {mine}
        {theirs}
      </Box>
    )
  })
}

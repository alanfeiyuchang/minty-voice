import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10, contentRows: 0 },
    view: {},
  },
} as const

// 引擎会按所在系统解析路径（Windows 上 /opt/… 会变成 C:\\opt\\…）：比较路径时统一成 / 再按结尾比
const norm = (p: string) => p.replace(/\\/g, '/')
const SOX = '/opt/homebrew/bin/sox'
const PTT_BIN = '/ptt/minty-ptt'
const PTT_OWNER = '/tmp/minty-ptt-owner'
const WHISPER = '/opt/homebrew/bin/whisper-cli'
const MODEL = '/Users/me/.whisper/ggml-large-v3-turbo.bin'

// 横栏下面没有别的 mod：引擎那一层什么都不画
function emptyBand(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => $.ui.resolve(e).Box({}))
}

const EDGE = '/Users/me/.local/bin/edge-tts'
// 这些测试测的是输入框上方的横栏（bar 界面）
const bar = (options: Record<string, string | boolean> = {}) => ({ options: { uiStyle: 'bar', ...options } })
const ACK = '收到，我先去修 React component。'
const SUMMARY = '搞定了，React component 里的 bug 已经修好。测试也全部通过了，你看要不要提交。'

type Log = {
  runs: string[][]
  spawns: { argv: readonly string[]; input?: string }[]
  models: { system: string; prompt: string }[]
}
const newLog = (): Log => ({ runs: [], spawns: [], models: [] })

// 一台“假 Mac”：sox、whisper-cli、模型都在；whisper 吐出一段中英混说的原话
function fakeMac(on: On, log: Log, mac: { edge?: 'ok' | 'offline' | 'missing'; holdSox?: boolean; ack?: string; play?: boolean; onPlay?: ($: EngineInterface) => Promise<void>; pttOwner?: string; heard?: string; refined?: string; config?: Record<string, string | boolean>; userPacks?: Record<string, { name: string; files: string[] }>; written?: string[]; decision?: Record<string, string>; weatherSay?: string } = {}) {
  const edge = mac.edge ?? 'ok'
  const kill = new Map<string, () => void>()
  // 按住快捷键说话：ptt/minty-ptt 每按下/松开一次往 stdout 打一行；emit 模拟按键
  const pttLines: string[] = []
  let pttWake = () => {}
  const emit = (line: string) => {
    pttLines.push(line)
    pttWake()
  }
  emptyBand(on)
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/Users/me' })
  mock.store(on)
  on('fs.exists', async ($, e) => ({
    value: norm(e.path).endsWith(PTT_BIN) || packFile(e.path) !== undefined || [SOX, WHISPER, MODEL, ...(edge === 'missing' ? [] : [EDGE]), ...(mac.play ? ['/opt/homebrew/bin/play'] : [])].some(x => norm(e.path).endsWith(x)) || norm(e.path).endsWith('.wav'),
  }))
  // 录好的那一段有内容
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 96_000, mtimeMs: 0, isLink: false } }))
  // 形象包：插件自带的 avatars/cat（五个状态），加上 ~/.claude/minty/avatars/ 里用户自己的
  const packs: Record<string, { base: string; name: string; files: string[] }> = {
    cat: { base: '/avatars', name: '猫', files: ['idle.avif', 'listen.avif', 'think.avif', 'wait.avif', 'speak.avif', 'idle-yawn.avif', 'idle-groom.avif'] },
  }
  for (const [id, pk] of Object.entries(mac.userPacks ?? {})) packs[id] = { base: '/.claude/minty/avatars', ...pk }
  function packFile(path: string): string | undefined {
    path = norm(path)
    for (const [id, pk] of Object.entries(packs)) {
      const dir = `${pk.base}/${id}/`
      const i = path.lastIndexOf(dir)
      if (i >= 0 && (pk.base !== '/avatars' || !path.slice(0, i).endsWith('/.claude/minty')) && pk.files.includes(path.slice(i + dir.length))) return path.slice(i + dir.length)
    }
    return undefined
  }
  on('fs.list', async ($, e) => {
    for (const [id, pk] of Object.entries(packs))
      if (norm(e.path).endsWith(`${pk.base}/${id}`)) return { value: pk.files.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
    const user = norm(e.path).endsWith('/.claude/minty/avatars')
    const ids = Object.entries(packs).filter(([, pk]) => (pk.base !== '/avatars') === user && norm(e.path).endsWith('/avatars')).map(([id]) => id)
    return { value: ids.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', async ($, e, next) => {
    if (norm(e.path).endsWith(PTT_OWNER) && mac.pttOwner) return { value: mac.pttOwner }
    if (norm(e.path).endsWith('/.claude/minty/config.json') && mac.config) return { value: JSON.stringify(mac.config) }
    for (const [id, pk] of Object.entries(packs))
      if (norm(e.path).endsWith(`${pk.base}/${id}/pack.json`)) return { value: JSON.stringify({ name: pk.name, durations: { idle: 6, 'idle-yawn': 3, 'idle-groom': 3 } }) }
    // 每个文件给一段不同的 base64，测试能分出画的是哪一段
    const f = packFile(e.path)
    if (f) return { value: { base64: { 'idle-yawn.avif': 'WWFXTg==', 'idle-groom.avif': 'R1JPTw==' }[f] ?? 'AAAA' } }
    return next(e)
  })
  on('fs.write', async ($, e, next) => {
    if (norm(e.path).endsWith(PTT_OWNER)) return { value: undefined }
    if (norm(e.path).endsWith('/.claude/minty/config.json')) {
      mac.written?.push(e.text)
      return { value: undefined }
    }
    return next(e)
  })
  on('session.messages', async () => ({
    value: [
      { role: 'user' as const, text: '看一下 whisper.cpp 能不能用 Core ML', toolUses: [] },
      { role: 'assistant' as const, text: '可以，whisper.cpp 支持 Core ML，我改了 useEffect 和 useEffect 的依赖。', toolUses: [] },
    ],
  }))
  on('process.run', async ($, e) => {
    log.runs.push([...e.argv])
    if (e.argv[0] === '/usr/bin/pkill') kill.get(e.argv[3]!)?.()
    // whisper 的老毛病：中英之间不留空格、中文后面跟半角逗号
    const stdout = e.argv[0] === WHISPER ? (mac.heard ?? '那个瑞爱克特的component有bug,帮我fix一下然后跑一下test') + '\n' : ''
    const exitCode = e.argv[0] === EDGE && edge === 'offline' ? 1 : 0
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  // 录音进程立刻结束 = 录满自动停（走完整条流水线）
  on('process.spawn', async function* ($, e) {
    log.spawns.push({ argv: e.argv, input: e.input })
    if (String(e.argv[0]).endsWith(PTT_BIN)) {
      yield { stream: 'stdout' as const, text: 'ready\n' }
      for (;;) {
        while (pttLines.length) yield { stream: 'stdout' as const, text: pttLines.shift()! + '\n' }
        await new Promise<void>(r => (pttWake = r))
      }
    }
    if (e.argv[0] === '/usr/bin/afplay' && mac.onPlay) await mac.onPlay($)
    if (e.argv[0] === SOX && mac.holdSox) {
      // 按住说话：一直录到被 pkill
      await new Promise<void>(r => kill.set(e.argv[9]!, r))
    }
    return { value: { code: 0, signal: null } }
  })
  on('model.complete', async ($, e) => {
    log.models.push({ system: e.system ?? '', prompt: e.prompt })
    const sys = e.system ?? ''
    // 快脑：默认判成“要 Claude Code 干活”，随口应一声
    const text = sys.includes('判断这句话该怎么处理')
      ? JSON.stringify(mac.decision ?? { route: 'task', say: mac.ack ?? ACK, task: e.prompt.split('【用户刚说的】\n')[1] ?? '' })
      : sys.includes('关于天气')
        ? (mac.weatherSay ?? '西雅图现在 12 度，下小雨，出门带把伞。')
      : sys.includes('语音合成')
        ? SUMMARY
        : (mac.refined ?? '修复 React component 里的 bug，然后运行测试。')
    return {
      value: {
        isAnswered: true,
        text,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  return { clock, emit }
}

// 横栏待命时开始说话：没有麦克风按钮了。桌面点光球旁边那行“点我说话”；终端点光球（这里用 /minty，
// 点光球的按下/放开另有测试）
async function startTalk($: Engine, ui: { press: (a: { key: string }) => Promise<unknown> }, surface: 'terminal' | 'desktop') {
  if (surface === 'desktop') await ui.press({ key: 'talk' })
  else await $.command.run({ command: 'minty', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
}

// 说一句话、发出去，然后 Claude 回复完
// 朗读是回复完之后在后台跑的：等横栏回到待命、不再显示“别念了”
async function talkThenAnswer($: Engine, surface: 'terminal' | 'desktop') {
  const ui = await $.ui.mount({ plugin: 'minty', surface, ...BAND })
  await startTalk($, ui, surface)
  await until(async () => !!(await ui.find({ key: 'send' })))
  await ui.press({ key: 'send' })
  await $.turn.complete({ answer: '我修好了 bug，测试全过。', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  let quiet = 0
  for (let i = 0; i < 5000 && quiet < 50; i++) {
    await Promise.resolve()
    quiet = (await ui.find({ key: 'hush' })) ? 0 : quiet + 1
  }
  return ui
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`说话 → 转写 → 整理 → 预览 → 发送（${surface}）`, bar(), async ($, on) => {
    const log = newLog()
    fakeMac(on, log)
    const sent: { text: string; asUser: boolean }[] = []
    on('prompt.submit', async ($, e) => {
      sent.push({ text: e.text, asUser: e.origin.kind === 'plugin' && e.origin.asUser === true })
      return { text: e.text }
    })

    const ui = await $.ui.mount({ plugin: 'minty', surface, ...BAND })
    // 没有 🎙 按钮；桌面是“点我说话”那行字，终端是光球本身
    expect(await ui.find({ type: 'Button', text: /🎙/ })).toBeUndefined()
    if (surface === 'desktop') expect(await ui.find({ key: 'talk', text: /点我说话/ })).toBeDefined()
    else expect(await ui.find({ key: 'talk' })).toBeUndefined()

    await startTalk($, ui, surface)
    await until(async () => !!(await ui.find({ key: 'send' })))

    // sox 用默认麦克风、16kHz 单声道
    expect(log.spawns[0]?.argv.slice(0, 9)).toEqual([SOX, '-q', '-d', '-c', '1', '-r', '16000', '-b', '16'])
    // whisper 用中文 + 混说提示词
    const w = log.runs.find(a => a[0] === WHISPER)
    expect(w).toBeDefined()
    expect(w?.includes('zh')).toBe(true)
    // 上文提示里带着最近对话里出现的术语
    const prompt = w?.[w.indexOf('--prompt') + 1] ?? ''
    expect(prompt).toContain('whisper.cpp')
    expect(prompt).toContain('useEffect')
    // 整理那一步也拿到常用词
    expect(log.models[0]?.prompt).toContain('【常用词】')
    expect(log.models[0]?.prompt).toContain('Core ML')

    // 预览里有原话和整理后的指令
    // 原话补上了中英之间的空格和中文逗号
    expect(await ui.find({ type: 'Text', text: /瑞爱克特的 component 有 bug，帮我 fix/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /修复 React component/ })).toBeDefined()

    await ui.press({ key: 'send' })
    expect(sent).toEqual([{ text: '修复 React component 里的 bug，然后运行测试。', asUser: true }])
    if (surface === 'desktop') expect(await ui.find({ key: 'talk' })).toBeDefined()
    await ui.unmount()
  })
}

test('朗读全部回复可以开关', bar(), async ($, on) => {
  emptyBand(on)
  const ui = await $.ui.mount({ plugin: 'minty', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'speak-all' })).toBeDefined()
  await ui.press({ key: 'speak-all' })
  expect(await ui.find({ key: 'speak-all', text: /开/ })).toBeDefined()
  await ui.unmount()
})

test('/minty check 列出缺的依赖', bar(), async ($, on) => {
  mock.env(on, { HOME: '/Users/me' })
  on('fs.exists', async () => ({ value: false }))
  const r = await $.command.run({
    command: 'minty',
    args: 'check',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(r.text).toContain('brew install sox')
  expect(r.text).toContain('brew install whisper-cpp')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`回复用 edge 神经网络声音一句一句念（${surface}）`, bar(), async ($, on) => {
    const log = newLog()
    fakeMac(on, log)
    on('prompt.submit', async ($, e) => ({ text: e.text }))
    const ui = await talkThenAnswer($, surface)

    const edgeRuns = log.runs.filter(a => a[0] === EDGE)
    expect(edgeRuns.length).toBe(2)
    expect(edgeRuns[0]).toContain('--voice=zh-CN-XiaoxiaoNeural')
    expect(edgeRuns[0]).toContain('--text=搞定了，React component 里的 bug 已经修好。')
    expect(edgeRuns[1]).toContain('--text=测试也全部通过了，你看要不要提交。')
    const players = log.spawns.map(s => s.argv[0]).filter(a => a !== SOX)
    expect(players).toEqual(['/usr/bin/afplay', '/usr/bin/afplay'])
    await ui.unmount()
  })
}

test('edge 断网时退回 macOS say', bar(), async ($, on) => {
  const log = newLog()
  fakeMac(on, log, { edge: 'offline' })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  const ui = await talkThenAnswer($, 'terminal')
  const said = log.spawns.find(s => s.argv[0] === '/usr/bin/say')
  expect(said?.argv).toEqual(['/usr/bin/say', '-v', 'Tingting'])
  expect(said?.input).toBe(SUMMARY)
  expect(log.spawns.some(s => s.argv[0] === '/usr/bin/afplay')).toBe(false)
  await ui.unmount()
})

test('朗读引擎选 say 时不碰 edge', bar({ ttsEngine: 'say' }), async ($, on) => {
  const log = newLog()
  fakeMac(on, log)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  const ui = await talkThenAnswer($, 'terminal')
  expect(log.runs.some(a => a[0] === EDGE)).toBe(false)
  expect(log.spawns.some(s => s.argv[0] === '/usr/bin/say')).toBe(true)
  await ui.unmount()
})

async function until(cond: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 20_000 && !(await cond()); i++) await Promise.resolve()
}

test('整理完直接放进输入框，不出预览', bar({ autoFill: true }), async ($, on) => {
  const log = newLog()
  fakeMac(on, log)
  const filled: string[] = []
  on('prompt.fill', async ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  const ui = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...BAND })
  await ui.press({ key: 'talk' })
  expect(filled).toEqual(['修复 React component 里的 bug，然后运行测试。'])
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  expect(await ui.find({ key: 'talk' })).toBeDefined()
  await ui.unmount()
})

test('朗读回复关掉后什么都不念', bar({ speakReplies: false }), async ($, on) => {
  const log = newLog()
  fakeMac(on, log)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  const ui = await talkThenAnswer($, 'terminal')
  expect(log.runs.some(a => a[0] === EDGE)).toBe(false)
  expect(log.spawns.some(s => s.argv[0] === '/usr/bin/say' || s.argv[0] === '/usr/bin/afplay')).toBe(false)
  expect(log.models.some(m => m.system.includes('语音合成'))).toBe(false)
  await ui.unmount()
})

test('对话模式已经去掉：横栏没有对话按钮，检查依赖里也不再提', bar(), async ($, on) => {
  const log = newLog()
  fakeMac(on, log)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'minty', surface, ...BAND })
    expect(await ui.find({ key: 'live' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /对话/ })).toBeUndefined()
    await ui.unmount()
  }
  await $.command.run({ command: 'minty', args: 'check', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    .then(r => expect(r.text).not.toContain('对话模式'))
  expect(log.spawns.some(s => s.argv.includes('silence'))).toBe(false)
})

test('光球在右边：终端是会动的字符球，桌面是 SVG', bar(), async ($, on) => {
  emptyBand(on)
  const term = await $.ui.mount({ plugin: 'minty', surface: 'terminal', ...BAND })
  expect(await term.find({ type: 'Client', key: 'orb' })).toBeDefined()
  await term.unmount()
  const desk = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...BAND })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  expect(await desk.find({ key: 'talk' })).toBeDefined()
  await desk.unmount()
})

const FOOTER = {
  component: 'SessionMode',
  props: { modes: [] as string[] },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`终端右下角光球：按住说话，放开后快脑先应一声、指令同时发给 Code（${surface}）`, async ($, on) => {
    const log = newLog()
    const { clock } = fakeMac(on, log, { holdSox: true })
    const sent: string[] = []
    on('prompt.submit', async ($, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    // 原来的横栏按钮都没了
    const band = await $.ui.mount({ plugin: 'minty', surface, ...BAND })
    expect(await band.find({ key: 'talk' })).toBeUndefined()
    await band.unmount()

    const foot = await $.ui.mount({ plugin: 'minty', surface: 'terminal', ...FOOTER })
    expect(await foot.find({ type: 'Client', key: 'orb' })).toBeDefined()

    await foot.pointer({ type: 'down', x: 0, y: 0, button: 'left' })
    // 开录了
    expect(log.spawns.some(s => s.argv[0] === SOX)).toBe(true)
    await clock.set(2000)
    await foot.pointer({ type: 'up', x: 0, y: 0, button: 'left' })
    await until(() => sent.length > 0 && log.spawns.some(s => s.argv[0] === '/usr/bin/afplay'))

    // 主 Session 拿到整理好的指令，快脑的回应用 edge 念出来
    expect(sent).toEqual(['修复 React component 里的 bug，然后运行测试。'])
    expect(log.models.some(m => m.system.includes('判断这句话该怎么处理'))).toBe(true)
    expect(log.runs.some(a => a[0] === EDGE && a.includes(`--text=${ACK}`))).toBe(true)
    await foot.unmount()
  })
}

test('光球点一下也能用：点一下开始录，再点一下说完', async ($, on) => {
  const log = newLog()
  fakeMac(on, log, { holdSox: true })
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const foot = await $.ui.mount({ plugin: 'minty', surface: 'terminal', ...FOOTER })
  const tap = async () => {
    await foot.pointer({ type: 'down', x: 0, y: 0, button: 'left' })
    await foot.pointer({ type: 'up', x: 0, y: 0, button: 'left' })
  }
  // 时钟不动 = 按下马上放开（点了一下）：还在录
  await tap()
  expect(log.runs.some(a => a[0] === '/usr/bin/pkill')).toBe(false)
  // 再点一下：说完了
  await tap()
  await until(() => sent.length > 0)
  expect(log.runs.some(a => a[0] === '/usr/bin/pkill')).toBe(true)
  expect(sent.length).toBe(1)
  await foot.unmount()
})

const SETTINGS = {
  component: 'Pane',
  requestId: 'minty-settings',
  props: {
    title: 'MINTY 设置',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40, contentRows: 0 },
    view: {},
  },
} as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`设置面板：换声音、改语速立刻生效（${surface}）`, bar(), async ($, on) => {
    const log = newLog()
    fakeMac(on, log)
    on('prompt.submit', async ($, e) => ({ text: e.text }))
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    await $.command.run({ command: 'minty', args: 'settings', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    const pane = await $.ui.mount({ plugin: 'minty', surface, ...SETTINGS })
    expect(await pane.find({ key: 'set-edgeVoice' })).toBeDefined()
    await pane.select({ key: 'set-edgeVoice', value: 'zh-CN-YunxiNeural' })
    // 不合法的值不改
    await pane.input({ key: 'set-speechRate', text: '很快' })
    expect(await pane.find({ type: 'Text', text: /不是有效的/ })).toBeDefined()
    expect(await pane.find({ key: 'set-liveThreshold' })).toBeUndefined()
    await pane.input({ key: 'set-speechRate', text: '+20%' })
    await pane.unmount()

    const ui = await talkThenAnswer($, surface)
    const edgeRun = log.runs.find(a => a[0] === EDGE)
    expect(edgeRun).toContain('--voice=zh-CN-YunxiNeural')
    expect(edgeRun).toContain('--rate=+20%')
    await ui.unmount()
  })
}

test('有 sox 的 play 时用它播：剪掉每句首尾的静音，只留短停顿', bar(), async ($, on) => {
  const log = newLog()
  fakeMac(on, log, { play: true })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  const ui = await talkThenAnswer($, 'terminal')
  const plays = log.spawns.filter(s => s.argv[0] === '/opt/homebrew/bin/play')
  expect(plays.length).toBe(2)
  expect(plays[0]!.argv.slice(3)).toEqual(['silence', '1', '0.02', '0.3%', 'reverse', 'silence', '1', '0.02', '0.3%', 'reverse', 'pad', '0', '0.15'])
  expect(log.spawns.some(s => s.argv[0] === '/usr/bin/afplay')).toBe(false)
  await ui.unmount()
})

test('形象选光球时画光球', bar({ uiStyle: 'orb', avatar: 'orb' }), async ($, on) => {
  emptyBand(on)
  const ui = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...BAND })
  const orb = await ui.find({ type: 'Svg' })
  expect(String((orb?.props as { source?: string } | undefined)?.source)).not.toContain('data:image/avif')
  await ui.unmount()
})

const PANEL = {
  component: 'Pane',
  requestId: 'minty',
  props: { ...SETTINGS.props, title: 'MINTY', bodyColumns: 40 },
} as const


const LONG_ACK = '收到，我先去看录音那段是怎么实现的，然后把静音阈值调低一点，再跑一遍所有测试。'

test('MINTY 面板：大猫、整段回答、按钮都在面板里；面板开着时输入框上方什么都不放', async ($, on) => {
  const log = newLog()
  fakeMac(on, log, { holdSox: true, ack: LONG_ACK })
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'minty', args: 'panel', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  const band = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...BAND })
  expect(await band.find({ type: 'Button' })).toBeUndefined()
  expect(await band.find({ type: 'Svg' })).toBeUndefined()
  await band.unmount()

  const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
  const pet = await panel.find({ type: 'Svg' })
  expect((pet?.props as { width?: number } | undefined)?.width).toBe(180)
  expect(String((pet?.props as { source?: string } | undefined)?.source)).toContain('data:image/avif;base64,')
  // 没有麦克风和对话模式按钮；猫正下方那行字就是点击区：点一下开始说，再点一下说完
  expect(await panel.find({ type: 'Button', text: /🎙|对话/ })).toBeUndefined()
  expect(await panel.find({ key: 'panel-talk', text: /点我说话/ })).toBeDefined()
  await panel.press({ key: 'panel-talk' })
  expect(log.spawns.some(s => s.argv[0] === SOX)).toBe(true)
  await panel.press({ key: 'panel-talk' })
  await until(async () => sent.length > 0 && !!(await panel.find({ type: 'Text', text: /再跑一遍所有测试/ })))
  expect(sent).toEqual(['修复 React component 里的 bug，然后运行测试。'])
  // 整段话都在，不截成一行
  expect(await panel.find({ type: 'Text', text: LONG_ACK })).toBeDefined()
  await panel.unmount()
})

test('MINTY 面板：念的时候有“停”，一按就不念了', async ($, on) => {
  const log = newLog()
  let release = () => {}
  const gate = new Promise<void>(r => (release = r))
  let plays = 0
  fakeMac(on, log, {
    holdSox: true,
    ack: '收到，我先去看录音那段是怎么实现的，然后把静音阈值调低一点。再跑一遍所有测试，看看有没有哪里出问题，最后告诉你结果。',
    onPlay: async () => {
      if (++plays === 1) await gate
    },
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
  expect(await panel.find({ key: 'panel-hush' })).toBeUndefined()
  await panel.press({ key: 'panel-talk' })
  await panel.press({ key: 'panel-talk' })
  await until(async () => plays >= 1 && !!(await panel.find({ key: 'panel-hush' })))
  await panel.press({ key: 'panel-hush' })
  release()
  await until(async () => !(await panel.find({ key: 'panel-hush' })))
  expect(plays).toBe(1)
  await panel.unmount()
})

test('面板被关掉时，输入框上方只剩一个把它叫回来的按钮', async ($, on) => {
  emptyBand(on)
  mock.store(on)
  const opened: string[] = []
  on('ui.open', async ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const band = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...BAND })
  expect(await band.find({ key: 'orb-tap' })).toBeUndefined()
  await band.press({ key: 'open-panel' })
  expect(opened).toContain('minty')
  await band.unmount()
})

test('MINTY 面板（终端）：点猫就开始说，再点一下说完发出', async ($, on) => {
  const log = newLog()
  fakeMac(on, log, { holdSox: true })
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const panel = await $.ui.mount({ plugin: 'minty', surface: 'terminal', ...PANEL })
  expect(await panel.find({ type: 'Client', key: 'orb' })).toBeDefined()
  expect(await panel.find({ key: 'panel-talk' })).toBeUndefined()
  const tap = async () => {
    await panel.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
    await panel.pointer({ type: 'up', x: 1, y: 1, button: 'left' })
  }
  await tap()
  expect(log.spawns.some(s => s.argv[0] === SOX)).toBe(true)
  expect(sent.length).toBe(0)
  await tap()
  await until(() => sent.length > 0)
  expect(sent).toEqual(['修复 React component 里的 bug，然后运行测试。'])
  await panel.unmount()
})

// 会话启动：引擎那一层只回个 cwd，会话 id 固定
function sessionStart(on: On) {
  on('session.start', async () => ({ cwd: '/w' }))
  on('session.id', async () => ({ value: 'this-session' }))
}

async function startSession($: Engine) {
  await ($.session as unknown as { start: (e: object) => Promise<unknown> }).start({ cwd: '/w', surface: 'desktop', isInteractive: true })
}

test('按住右 Option 说话：按下开录，松开发出；太短或组合键都不算', async ($, on) => {
  const log = newLog()
  const { clock, emit } = fakeMac(on, log, { holdSox: true })
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  sessionStart(on)
  await startSession($)
  await until(() => log.spawns.some(s => String(s.argv[0]).endsWith(PTT_BIN)))
  const ptt = log.spawns.find(s => String(s.argv[0]).endsWith(PTT_BIN))!
  expect(ptt.argv[1]).toBe('right-option')
  const sox = () => log.spawns.filter(s => s.argv[0] === SOX).length
  const kills = () => log.runs.filter(a => a[0] === '/usr/bin/pkill' && String(a[3]).startsWith('/tmp/minty-')).length

  // 按住说话，松开发出
  emit('down')
  await until(() => sox() === 1)
  await clock.set(3000)
  emit('up')
  await until(() => sent.length > 0)
  expect(sent).toEqual(['修复 React component 里的 bug，然后运行测试。'])

  // 碰一下（不到 300ms）：录的扔掉，不转写
  const whisperRuns = () => log.runs.filter(a => a[0] === WHISPER).length
  const before = whisperRuns()
  emit('down')
  await until(() => sox() === 2)
  await clock.set(3100)
  emit('up')
  await until(() => kills() === 2)
  await clock.advance(10)
  expect(whisperRuns()).toBe(before)

  // 按住时又按了别的键（右 Option + 字母）：不算说话
  emit('down')
  await until(() => sox() === 3)
  emit('cancel')
  await until(() => kills() === 3)
  await clock.set(9000)
  emit('up')
  await clock.advance(10)
  expect(whisperRuns()).toBe(before)
  expect(sent.length).toBe(1)
})

test('快捷键只归最近用过的会话：别的会话认领了就不录', async ($, on) => {
  const log = newLog()
  const { emit } = fakeMac(on, log, { holdSox: true, pttOwner: 'another-session' })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  sessionStart(on)
  await startSession($)
  await until(() => log.spawns.some(s => String(s.argv[0]).endsWith(PTT_BIN)))
  emit('down')
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(log.spawns.some(s => s.argv[0] === SOX)).toBe(false)
})

for (const [name, mac] of [
  ['只听出一个“。”', { heard: '。' }],
  ['whisper 脑补的“谢谢观看”', { heard: '谢谢观看。' }],
  ['整理模型说原话里没有要求', { heard: '嗯', refined: '<空>' }],
] as const) {
  test(`没说出东西时不发：${name}`, async ($, on) => {
    const log = newLog()
    fakeMac(on, log, { holdSox: true, ...mac })
    const sent: string[] = []
    on('prompt.submit', async ($, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
    await panel.press({ key: 'panel-talk' })
    await panel.press({ key: 'panel-talk' })
    await until(async () => !!(await panel.find({ key: 'panel-talk', text: /没听清/ })))
    expect(await panel.find({ key: 'panel-talk', text: /没听清/ })).toBeDefined()
    expect(sent).toEqual([])
    await panel.unmount()
  })
}

test('改名字和命令：面板标题、快脑的自称、斜杠命令都换成新的', async ($, on) => {
  const log = newLog()
  fakeMac(on, log, { holdSox: true, config: { name: '小橘', command: 'xiaoju' } })
  const registered: string[] = []
  on('command.register', async ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  const opened: string[] = []
  on('ui.open', async ($, e) => {
    opened.push(e.title ?? '')
    return { value: { isPlaced: true } }
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  sessionStart(on)
  await startSession($)
  expect(registered).toContain('xiaoju')
  expect(registered).not.toContain('minty')
  expect(opened).toContain('小橘')

  const r = await $.command.run({ command: 'xiaoju', args: 'check', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(r.text).toContain('名字 小橘，命令 /xiaoju')

  const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
  await panel.press({ key: 'panel-talk' })
  await panel.press({ key: 'panel-talk' })
  await until(() => log.models.some(m => m.system.includes('判断这句话该怎么处理')))
  expect(log.models.find(m => m.system.includes('判断这句话该怎么处理'))?.system).toContain('你是 小橘')
  await panel.unmount()
})

test('形象可替换：用户自己的形象包能选、能画；缺的状态用 idle', async ($, on) => {
  const log = newLog()
  const written: string[] = []
  fakeMac(on, log, { holdSox: true, userPacks: { dog: { name: '小狗', files: ['idle.webp'] } }, written })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  const pane = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...SETTINGS })
  const select = await pane.find({ key: 'set-avatar' })
  const options = (select?.props as { options?: { value: string; label: string }[] } | undefined)?.options ?? []
  expect(options.map(o => o.label)).toEqual(['猫', '小狗', '光球'])
  await pane.select({ key: 'set-avatar', value: 'dog' })
  expect(JSON.parse(written.at(-1) ?? '{}')).toMatchObject({ avatar: 'dog' })
  await pane.unmount()

  const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
  expect(String((await panel.find({ type: 'Svg' }))?.props.source)).toContain('data:image/webp;base64,')
  // 在听：小狗没有 listen，就用 idle
  await panel.press({ key: 'panel-talk' })
  expect(String((await panel.find({ type: 'Svg' }))?.props.source)).toContain('data:image/webp;base64,')
  await panel.unmount()
})

const NO_SUBMIT_CASES = [
  ['闲聊：自己答，不发给 Claude Code', { route: 'chat', say: '我挺好的，你今天写得怎么样？' }, '我挺好的，你今天写得怎么样？'],
  ['问天气：查完自己答，不发给 Claude Code', { route: 'weather', place: 'Seattle' }, '西雅图现在 12 度，下小雨，出门带把伞。'],
] as const

for (const [name, decision, answer] of NO_SUBMIT_CASES) {
  test(name, async ($, on) => {
    const log = newLog()
    fakeMac(on, log, { holdSox: true, decision: { ...decision } })
    const fetched: string[] = []
    on('http.fetch', async ($, e) => {
      fetched.push(e.url)
      const body = {
        current_condition: [{ temp_C: '12', FeelsLikeC: '10', lang_zh: [{ value: '小雨' }] }],
        weather: [{ date: '2026-10-07', maxtempC: '14', mintempC: '9', hourly: [{ chanceofrain: '80' }] }],
      }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
    })
    const sent: string[] = []
    on('prompt.submit', async ($, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
    await panel.press({ key: 'panel-talk' })
    await panel.press({ key: 'panel-talk' })
    await until(async () => !!(await panel.find({ type: 'Text', text: answer })))
    expect(await panel.find({ type: 'Text', text: answer })).toBeDefined()
    expect(log.runs.some(a => a[0] === EDGE && a.some(x => x.startsWith('--text=') && answer.startsWith(x.slice(7))))).toBe(true)
    expect(sent).toEqual([])
    // 整理指令那一步也没跑
    expect(log.models.some(m => m.system.startsWith('你是语音输入整理器'))).toBe(false)
    if (decision.route === 'weather') {
      expect(fetched[0]).toContain('wttr.in/Seattle')
      expect(log.models.find(m => m.system.includes('关于天气'))?.prompt).toContain('小雨')
    }
    await panel.unmount()
  })
}

test('接着刚才的话说“好”：快脑把要做的事补全，再整理发给 Claude Code', async ($, on) => {
  const log = newLog()
  fakeMac(on, log, { holdSox: true, decision: { route: 'task', say: '好。', task: '把录音那段的超时改成 5 分钟' } })
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
  await panel.press({ key: 'panel-talk' })
  await panel.press({ key: 'panel-talk' })
  await until(() => sent.length > 0)
  // 整理那一步拿到的是补全后的要求，不是“好”
  expect(log.models.find(m => m.system.startsWith('你是语音输入整理器'))?.prompt).toContain('把录音那段的超时改成 5 分钟')
  expect(sent.length).toBe(1)
  await panel.unmount()
})

test('设置成“全部发”时不判断，每句都发给 Claude Code', async ($, on) => {
  const log = newLog()
  fakeMac(on, log, { holdSox: true, config: { route: 'always' }, decision: { route: 'chat', say: '不该用到' } })
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  sessionStart(on)
  await startSession($)
  const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
  await panel.press({ key: 'panel-talk' })
  await panel.press({ key: 'panel-talk' })
  await until(() => sent.length > 0)
  expect(log.models.some(m => m.system.includes('判断这句话该怎么处理'))).toBe(false)
  await panel.unmount()
})

test('待命动画有变化：放几遍 idle 后插播一段变化，放完一遍接回 idle；在听的时候不插', async ($, on) => {
  const log = newLog()
  const { clock } = fakeMac(on, log, { holdSox: true })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  sessionStart(on)
  await startSession($)
  const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
  const src = async () => String((await panel.find({ type: 'Svg' }))?.props.source)
  const isVariant = (x: string) => x.includes('WWFXTg==') || x.includes('R1JPTw==')
  expect(isVariant(await src())).toBe(false)
  // idle 一遍 6 秒，每放 2~4 遍插播一段；一秒一秒往前走，看到变化出现、3 秒左右又换回 idle
  let shownAt = -1
  for (let t = 0; t < 30 && shownAt < 0; t++) {
    await clock.advance(1000)
    if (isVariant(await src())) shownAt = t
  }
  expect(shownAt).toBeGreaterThanOrEqual(11)
  await clock.advance(3_100)
  expect(isVariant(await src())).toBe(false)
  // 在听的时候：到点了也不插
  await panel.press({ key: 'panel-talk' })
  await clock.advance(30_000)
  expect((await panel.find({ type: 'Svg' }))?.props.source).toBeDefined()
  expect(isVariant(await src())).toBe(false)
  await panel.unmount()
})

// ---------- Linux / Windows ----------
// 模拟另一个系统：环境变量、程序装在哪、uname 说什么；看录音、转换、播放、朗读、快捷键监听用的命令对不对

type OsName = 'linux' | 'windows'
const WIN_HOME = 'C:\\Users\\me'
const WIN = {
  sox: 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe',
  whisper: `${WIN_HOME}\\.claude\\minty\\whisper\\whisper-cli.exe`,
  model: `${WIN_HOME}\\.whisper\\ggml-large-v3-turbo.bin`,
  ffplay: `${WIN_HOME}\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffplay.exe`,
  edge: `${WIN_HOME}\\.local\\bin\\edge-tts.exe`,
  ps: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  temp: `${WIN_HOME}\\AppData\\Local\\Temp`,
}
const LNX = {
  sox: '/usr/bin/sox',
  whisper: '/home/me/.claude/minty/whisper/whisper-cli',
  model: '/home/me/.whisper/ggml-large-v3-turbo.bin',
  ffplay: '/usr/bin/ffplay',
  edge: '/home/me/.local/bin/edge-tts',
  py: '/usr/bin/python3',
  espeak: '/usr/bin/espeak-ng',
}

function fakeOs(on: On, log: Log, os: OsName, extra: { config?: Record<string, string | boolean>; pttLines?: string[] } = {}) {
  emptyBand(on)
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on)
  mock.env(on, os === 'windows'
    ? { OS: 'Windows_NT', USERPROFILE: WIN_HOME, TEMP: WIN.temp, LOCALAPPDATA: `${WIN_HOME}\\AppData\\Local`, SystemRoot: 'C:\\Windows' }
    : { HOME: '/home/me' })
  const have = os === 'windows' ? [WIN.sox, WIN.whisper, WIN.model, WIN.ffplay, WIN.edge, WIN.ps] : Object.values(LNX)
  // 在 macOS 上跑测试时，引擎把 C:\\… 当成相对路径、前面拼上当前目录：按结尾比
  on('fs.exists', async ($, e) => ({ value: have.some(h => norm(e.path).endsWith(norm(h))) || norm(e.path).endsWith('.wav') || norm(e.path).endsWith('.raw') }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 96_000, mtimeMs: 0, isLink: false } }))
  on('fs.read', async ($, e) => (norm(e.path).endsWith('config.json') && extra.config ? { value: JSON.stringify(extra.config) } : { deny: 'no file' }))
  on('fs.write', async () => ({ value: undefined }))
  on('fs.list', async () => ({ value: [] }))
  on('session.messages', async () => ({ value: [] }))
  on('process.run', async ($, e) => {
    log.runs.push([...e.argv])
    const stdout = e.argv[0] === 'uname' ? 'Linux\n' : e.argv[0] === WIN.whisper || e.argv[0] === LNX.whisper ? '帮我跑一下测试\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e) {
    log.spawns.push({ argv: e.argv, input: e.input })
    if (String(e.argv.at(-3) ?? '').includes('minty-ptt') || e.argv.some(a => String(a).includes('minty-ptt'))) {
      for (const l of extra.pttLines ?? ['ready']) yield { stream: 'stdout' as const, text: l + '\n' }
    }
    return { value: { code: 0, signal: null } }
  })
  on('model.complete', async ($, e) => {
    log.models.push({ system: e.system ?? '', prompt: e.prompt })
    const sys = e.system ?? ''
    const text = sys.includes('判断这句话该怎么处理')
      ? JSON.stringify({ route: 'task', say: '好。', task: '帮我跑一下测试' })
      : sys.includes('语音合成') ? '好了，测试都过了。' : '运行测试。'
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  return { clock }
}

async function talkOnPanel($: Engine, sent: string[]) {
  const panel = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...PANEL })
  await panel.press({ key: 'panel-talk' })
  await until(() => sent.length > 0)
  await panel.unmount()
}

test('Windows：录成 raw 再用 sox 转 wav（不用 pkill）、ffplay 放语音、PowerShell 删临时文件', async ($, on) => {
  const log = newLog()
  fakeOs(on, log, 'windows')
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await talkOnPanel($, sent)
  const rec = log.spawns.find(s => s.argv[0] === WIN.sox)!
  expect(rec.argv).toContain('raw')
  const rawFile = String(rec.argv.find(a => String(a).endsWith('.raw')))
  expect(rawFile.startsWith(WIN.temp + '\\minty-')).toBe(true)
  // 停下后转成 wav，whisper 读的是 wav
  const conv = log.runs.find(a => a[0] === WIN.sox)!
  expect(conv.slice(1, 3)).toEqual(['-q', '-t'])
  expect(conv).toContain(rawFile)
  const wav = rawFile.replace(/\.raw$/, '.wav')
  expect(conv.at(-1)).toBe(wav)
  expect(log.runs.find(a => a[0] === WIN.whisper)).toContain(wav)
  expect(log.runs.some(a => String(a[0]).includes('pkill'))).toBe(false)
  // 临时文件用 PowerShell 删
  expect(log.runs.some(a => a[0] === WIN.ps && a.some(x => x.includes('Remove-Item')))).toBe(true)
  // 快脑的应答：edge-tts 合成，ffplay 放
  await until(() => log.spawns.some(s => s.argv[0] === WIN.ffplay))
  expect(log.spawns.find(s => s.argv[0] === WIN.ffplay)?.argv.slice(1, 3)).toEqual(['-nodisp', '-autoexit'])
})

test('Windows：没有 edge 时用系统自带的 System.Speech 朗读', async ($, on) => {
  const log = newLog()
  fakeOs(on, log, 'windows', { config: { ttsEngine: 'say' } })
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  sessionStart(on)
  await startSession($)
  await talkOnPanel($, sent)
  await until(() => log.spawns.some(s => s.argv[0] === WIN.ps && String(s.argv.at(-1)).includes('System.Speech')))
  const sp = log.spawns.find(s => s.argv[0] === WIN.ps && String(s.argv.at(-1)).includes('System.Speech'))!
  expect(sp.input).toBe('好。')
})

test('Windows：快捷键监听是 PowerShell 脚本，设置里的键叫“右 Alt”', async ($, on) => {
  const log = newLog()
  fakeOs(on, log, 'windows', { pttLines: ['ready'] })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  sessionStart(on)
  await startSession($)
  await until(() => log.spawns.some(s => s.argv.includes('-File')))
  const ptt = log.spawns.find(s => s.argv.includes('-File'))!
  expect(ptt.argv[0]).toBe(WIN.ps)
  expect(String(ptt.argv[ptt.argv.indexOf('-File') + 1]).endsWith('\\ptt\\minty-ptt.ps1')).toBe(true)
  expect(ptt.argv.slice(-2)).toEqual(['right-option', 'this-session'])
  const pane = await $.ui.mount({ plugin: 'minty', surface: 'desktop', ...SETTINGS })
  const sel = await pane.find({ key: 'set-pttKey' })
  expect(((sel?.props as { options?: { label: string }[] }).options ?? []).map(o => o.label)).toEqual(['右 Alt', '右 Win', '右 Ctrl', '关'])
  await pane.unmount()
})

test('Linux：录 wav、pkill 收尾、ffplay 放语音；快捷键是 python3 脚本，没权限时提示加 input 组', async ($, on) => {
  const log = newLog()
  fakeOs(on, log, 'linux', { pttLines: ['no-permission'] })
  const sent: string[] = []
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const toasts: string[] = []
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  sessionStart(on)
  await startSession($)
  await until(() => toasts.length > 0)
  const ptt = log.spawns.find(s => s.argv[0] === LNX.py)!
  expect(String(ptt.argv[1]).endsWith('/ptt/minty-ptt-linux.py')).toBe(true)
  expect(toasts[0]).toContain('input')
  await talkOnPanel($, sent)
  const rec = log.spawns.find(s => s.argv[0] === LNX.sox)!
  expect(String(rec.argv[9]).startsWith('/tmp/minty-') && String(rec.argv[9]).endsWith('.wav')).toBe(true)
  expect(log.runs.some(a => a[0] === '/usr/bin/pkill' && a[1] === '-INT')).toBe(true)
  await until(() => log.spawns.some(s => s.argv[0] === LNX.ffplay))
})

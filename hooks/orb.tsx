// MINTY 的光球（Client 画面模块）：按状态换颜色和动画，在画面线程上自己跑（surface.every），
// 不用每一帧都回到 hooks 模块。
//
//   mini：窗口右下角那一行里的转圈按钮。按下 / 放开发给 hooks 模块（ui.message）做按住说话
//   否则：横栏 / 面板里 3 行高的小圆球；点它（按下 / 放开）一样发给 hooks 模块，点一下就开始说话

import type { ClientModule } from 'claude-code'

import type { OrbMood } from '../types'

type Props = { mood: OrbMood; label?: string; mini?: boolean }

const COLOR: Record<OrbMood, string> = {
  idle: 'blue',
  listen: 'red',
  think: 'magenta',
  wait: 'yellow',
  speak: 'cyan',
}

// 3 行球的“球心”，4 个字符宽
const CORE: Record<OrbMood, string[]> = {
  idle: ['░░░░', '▒▒▒▒', '▓▓▓▓', '████', '▓▓▓▓', '▒▒▒▒'],
  listen: ['▂▅▇▃', '▅▇▃▂', '▇▃▂▅', '▃▂▅▇'],
  think: ['●···', '·●··', '··●·', '···●', '··●·', '·●··'],
  wait: ['████', '████', '▓▓▓▓', '▓▓▓▓'],
  speak: ['▁▃▅▇', '▃▅▇▅', '▅▇▅▃', '▇▅▃▁', '▅▃▁▃', '▃▁▃▅'],
}

// 一行的转圈：四分之一圆在圈里转；越忙转得越快（每几个 tick 走一格）
const SPIN = ['◴', '◷', '◶', '◵']
const PULSE = ['◉', '◉', '◎', '○', '◎']
const STEP: Record<OrbMood, number> = { idle: 6, listen: 1, think: 2, wait: 4, speak: 1 }

type State = { f: number }

const Orb: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.every(120, () => surface.setState({ f: ((surface.state?.f ?? 0) + 1) % 3600 }))
    surface.onPointer(ev => {
      if (ev.type === 'down') surface.post({ type: 'down' })
      else if (ev.type === 'up') surface.post({ type: 'up' })
    })
    surface.setState({ f: 0 })
  }
  const mood: OrbMood = props && props.mood in COLOR ? props.mood : 'idle'
  const f = surface.state?.f ?? 0
  const color = COLOR[mood]

  if (props?.mini) {
    const glyph = mood === 'speak' ? PULSE[f % PULSE.length] : SPIN[Math.floor(f / STEP[mood]) % SPIN.length]
    return (
      <Box flexDirection="row" columnGap={1}>
        {props.label ? <Text dimColor>{props.label}</Text> : null}
        <Text color={color} bold>
          {glyph}
        </Text>
      </Box>
    )
  }

  const frames = CORE[mood]
  // 待命时外壳也跟着“呼吸”
  const dim = mood === 'idle' && f % 12 < 6
  return (
    <Box flexDirection="column" width={6}>
      <Text color={color} dimColor={dim}>
        {' ▄▄▄▄ '}
      </Text>
      <Text color={color}>{'▐' + frames[f % frames.length] + '▌'}</Text>
      <Text color={color} dimColor={dim}>
        {' ▀▀▀▀ '}
      </Text>
    </Box>
  )
}

export default Orb

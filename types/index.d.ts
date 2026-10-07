export type Phase =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'refining'
  | 'review'
  | 'speaking'

/** 光球的样子：待命、在听、在想、等你确认、在念 */
export type OrbMood = 'idle' | 'listen' | 'think' | 'wait' | 'speak'

declare module 'claude-code' {
  interface PluginState {
    minty: {
      /** 当前所处阶段 */
      phase: Phase
      /** whisper 转写出的原话 */
      raw: string
      /** 整理后的指令，或正在念的总结 */
      refined: string
      /** 一行提示或错误信息 */
      note: string
      /** 打开时，所有回复都念总结（不只语音发起的） */
      speakAll: boolean
      /** MINTY 正在念（快脑的回应或回复总结） */
      speakingNow: boolean
      /** 主 Session 正在跑一轮 */
      working: boolean
      /** 设置面板里改过的项 */
      prefs: Record<string, string | boolean>
      /** MINTY 正在念、或最后念过的那句话 */
      said: string
      /** MINTY 面板（大猫）是否画在屏幕上 */
      panelOpen: boolean
      /** 待命时正在插播的那段变化（idle-yawn 之类），空字符串 = 普通的 idle */
      idleVariant: string
    }
  }
}

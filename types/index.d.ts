export type Today = {
  date: string
  exercise: string
  goal: number
  unit: string
  count: number
  isRest: boolean
}

export type Day = {
  date: string
  count: number
  goal: number
  isSkipped: boolean
}

export type OnboardPick = {
  program: string
  size: string
  hasRoutine: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-gym': {
      today: Today | null
      debt: number
      isUnlocked: boolean
      isWaiting: boolean
      isIntroduced: boolean
      onboardStep: number
      onboardPick: OnboardPick
      history: Day[]
    }
  }
}

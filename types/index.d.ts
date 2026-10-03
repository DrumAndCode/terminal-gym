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
  exercise: string
  isSkipped: boolean
}

export type OnboardPick = {
  program: string
  size: string
  hasRoutine: boolean
}

// Where today stands against the schedule of sets.
export type Pace = {
  required: number
  behind: number
  setSize: number
  nextDueAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-gym': {
      today: Today | null
      pace: Pace | null
      isWaiting: boolean
      isIntroduced: boolean
      onboardStep: number
      onboardPick: OnboardPick
      history: Day[]
    }
  }
}

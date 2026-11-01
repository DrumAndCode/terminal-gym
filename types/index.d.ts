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
  // "s" for timed exercises; absent for reps.
  unit?: string
}

export type OnboardPick = {
  program: string
  size: string
  hasRoutine: boolean
  // Custom: the routine whose days it keeps, and each exercise's goal as typed.
  base: Record<string, { exercise: string; goal: number; unit?: string }>
  custom: Record<string, string>
  isCustomInvalid: boolean
}

// Where today stands against the schedule of sets.
export type Pace = {
  required: number
  behind: number
  setSize: number
  nextDueAt: number | null
  // While a breather runs, catch-up reps are owed but prompts are not held.
  restUntil: number | null
  // The day's first set, before any reps: an opener, not a debt.
  isOpening?: boolean
  // The breather is a `/fit snooze`: the set was put off, not partly done.
  isPutOff?: boolean
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
      // Every day with reps, oldest first; null until the scoreboard first loads it.
      ledger: Day[] | null
      chartDays: number
      olderStreak: number
    }
  }
}

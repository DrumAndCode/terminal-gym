import type { Day, Pace } from '../types'

export type Routine = Record<string, { exercise: string; goal: number; unit?: string }>

export const DEFAULT_ROUTINE: Routine = {
  mon: { exercise: 'pushups', goal: 100 },
  tue: { exercise: 'dips', goal: 100 },
  wed: { exercise: 'squats', goal: 300 },
  thu: { exercise: 'pushups', goal: 100 },
  fri: { exercise: 'dips', goal: 100 },
  sat: { exercise: 'squats', goal: 300 },
  sun: { exercise: 'pushups', goal: 100 },
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_MS = 86_400_000

const pad = (n: number) => String(n).padStart(2, '0')

export const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const weekdayKey = (ms: number) => WEEKDAYS[new Date(ms).getDay()] ?? 'sun'

// Noon anchors keep day arithmetic clear of DST shifts.
export const lastDays = (ms: number, n: number) => {
  const d = new Date(ms)
  const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
  return Array.from({ length: n }, (_, i) => noon - (n - 1 - i) * DAY_MS)
}

export const bar = (count: number, goal: number, width = 10) => {
  const filled = goal > 0 ? Math.min(width, Math.floor((count / goal) * width)) : 0
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

export type FitCommand =
  | { kind: 'status' }
  | { kind: 'week' }
  | { kind: 'skip' }
  | { kind: 'unskip' }
  | { kind: 'help' }
  | { kind: 'hide' }
  | { kind: 'reset' }
  | { kind: 'intro' }
  | { kind: 'program' }
  | { kind: 'swap'; exercise?: string }
  | { kind: 'strict'; isOn: boolean }
  | { kind: 'add'; n: number }
  | { kind: 'set'; n: number }
  | { kind: 'error'; text: string }

const USAGE = 'usage: /fit [<n> | set <n> | reset | swap [exercise] | rest [off] | score | program | rules | strict | easy | start | hide]'

export const parseFit = (args: string): FitCommand => {
  const [head = '', value] = args.trim().split(/\s+/)
  if (head === '' || head === 'status') return { kind: 'status' }
  if (head === 'score') return { kind: 'week' }
  if (head === 'rest') return value === 'off' ? { kind: 'unskip' } : { kind: 'skip' }
  if (head === 'program') return { kind: 'program' }
  if (head === 'swap') {
    // Names may be several words ("jumping jacks"): keep everything after "swap".
    const name = args.trim().replace(/^swap\s*/, '').replace(/\s+/g, ' ').toLowerCase()
    return name === '' ? { kind: 'swap' } : { kind: 'swap', exercise: name }
  }
  if (head === 'rules') return { kind: 'help' }
  if (head === 'hide') return { kind: 'hide' }
  if (head === 'reset') return { kind: 'reset' }
  if (head === 'start') return { kind: 'intro' }
  if (head === 'strict') return { kind: 'strict', isOn: true }
  if (head === 'easy') return { kind: 'strict', isOn: false }
  if (head === 'set') {
    return value !== undefined && /^\d+$/.test(value)
      ? { kind: 'set', n: Number(value) }
      : { kind: 'error', text: 'fit: set needs a number' }
  }
  if (/^-?\d+$/.test(head)) return { kind: 'add', n: Number(head) }
  return { kind: 'error', text: USAGE }
}

const isDone = (day: Day) => !day.isSkipped && day.goal > 0 && day.count >= day.goal

// Today counts once done; an unfinished today does not break the run yet.
export const streak = (history: readonly Day[]) => {
  let run = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const day = history[i]
    if (day === undefined) break
    if (isDone(day)) run++
    else if (i !== history.length - 1) break
  }
  return run
}

// The engine environment has Uint8Array#toBase64; es2023 typings do not.
type Base64Bytes = Uint8Array & { toBase64: () => string }

const ACCENT = 0xc8a86b
const PARTIAL = 0x6b5d3f
const EMPTY = 0x343434
const DEFAULT = 0x01000000

// The streak, counting days older than the window when the window is all done.
export const fullStreak = (history: readonly Day[], older: number) => {
  const run = streak(history)
  const last = history[history.length - 1]
  const coversWindow = run === history.length || (run === history.length - 1 && last !== undefined && !isDone(last))
  return coversWindow ? run + older : run
}

export const isDoneDay = (day: Day) => isDone(day)

// One row per week, seven 2-cell days with a gap: 20 columns.
export const heatCells = (history: readonly Day[]) => {
  const weeks = Math.ceil(history.length / 7)
  const columns = 20
  const words = new Uint32Array(columns * weeks * 3)
  for (let row = 0; row < weeks; row++) {
    for (let col = 0; col < columns; col++) {
      const day = history[row * 7 + Math.floor(col / 3)]
      const isGap = col % 3 === 2 || day === undefined
      const color = isGap
        ? DEFAULT
        : isDone(day)
          ? ACCENT
          : day.count > 0
            ? PARTIAL
            : EMPTY
      const at = (row * columns + col) * 3
      // Today, the last day, is drawn shaded so it stands out from finished days.
      const isToday = row * 7 + Math.floor(col / 3) === history.length - 1
      words[at] = isGap ? 0x20 : isToday ? 0x2592 : 0x2588
      words[at + 1] = color
      words[at + 2] = DEFAULT
    }
  }
  return { columns, rows: weeks, cells: (new Uint8Array(words.buffer) as Base64Bytes).toBase64() }
}

// Grey until the first rep, then a muted traffic light: red under a third of the
// goal, yellow on the way, green for the last fifth. No goal: undefined draws dim.
export const progressColor = (count: number, goal: number) => {
  if (goal <= 0 || count <= 0) return undefined
  const share = count / goal
  return share >= 0.8 ? '#87af87' : share >= 1 / 3 ? '#d7af5f' : '#d75f5f'
}

export const daily = (exercise: string, goal: number): Routine =>
  Object.fromEntries(WEEKDAYS.map(day => [day, { exercise, goal }]))

export const ROUTINES = {
  'Push · dip · squat rotation': DEFAULT_ROUTINE,
  'Daily pushups': daily('pushups', 100),
  'Daily squats': daily('squats', 200),
} as const satisfies Record<string, Routine>

export const SIZES = { Light: 0.5, Standard: 1, Heavy: 2 } as const satisfies Record<string, number>

export const scale = (routine: Routine, factor: number): Routine =>
  Object.fromEntries(
    Object.entries(routine).map(([day, plan]) => [
      day,
      { ...plan, goal: Math.max(5, Math.round((plan.goal * factor) / 5) * 5) },
    ]),
  )

// "30 burpees" typed under Other: one exercise every day.
export const parseCustom = (text: string): Routine | undefined => {
  const match = /^\s*(\d+)\s+([a-z][a-z -]*?)\s*$/i.exec(text)
  if (match === null) return undefined
  const [, goal = '0', exercise = ''] = match
  return Number(goal) > 0 ? daily(exercise.toLowerCase(), Number(goal)) : undefined
}

// Today's exercise, swapped: the next one in the routine, or the one named.
export const pickSwap = (routine: Routine, current: string, wanted?: string) => {
  const plans = [...new Map(Object.values(routine).map(plan => [plan.exercise, plan])).values()]
  if (wanted !== undefined) return plans.find(plan => plan.exercise.toLowerCase() === wanted)
  if (plans.length === 0) return undefined
  const at = plans.findIndex(plan => plan.exercise === current)
  return plans[(at + 1) % plans.length]
}

// The scoreboard's barbell, the name across the bar. 34 columns wide.
export const BARBELL = {
  plates: ' ▐█▌▐█▌                    ▐█▌▐█▌ ',
  left: '━▐█▌▐█▌━━━ ',
  name: 'TERMINAL GYM',
  right: ' ━━━▐█▌▐█▌━',
  width: 34,
} as const

// Terminal cells a string takes: emoji draw two cells wide.
export const cells = (text: string) =>
  [...text].reduce((w, ch) => w + ((ch.codePointAt(0) ?? 0) >= 0x1f000 || ch === '✅' ? 2 : 1), 0)

// The terminal draws a Button as `[ label ]`, and a row puts one cell between buttons.
export const buttonsWidth = (labels: readonly string[]) =>
  labels.reduce((w, label) => w + cells(label) + 4, 0) + labels.length - 1

// The band's one-line barbell wordmark.
// Small plate, big plate, bar: ❚█═TERMINAL-GYM═█❚
export const MINI_BARBELL = { small: '❚', plate: '█═', name: 'TERMINAL-GYM', plateRight: '═█' } as const

// A set is a tenth of the goal, rounded to fives, unless the person picked a size.
export const setSizeFor = (goal: number, setting: number) => {
  if (goal <= 0) return 0
  if (setting > 0) return Math.min(setting, goal)
  return Math.min(goal, Math.max(5, Math.round(goal / 10 / 5) * 5))
}

// The goal as evenly spaced sets: the first due at the start, the last at the
// end of the window. `required` is what should be done by `now`.
export const paceAt = (
  goal: number,
  count: number,
  setSize: number,
  startedAt: number,
  now: number,
  windowMs: number,
): Pace => {
  if (goal <= 0 || setSize <= 0) return { required: 0, behind: 0, setSize, nextDueAt: null }
  const sets = Math.ceil(goal / setSize)
  const gap = sets > 1 ? windowMs / (sets - 1) : windowMs
  const due = Math.min(sets, 1 + Math.floor(Math.max(0, now - startedAt) / gap))
  const required = Math.min(goal, due * setSize)
  return {
    required,
    behind: Math.max(0, required - count),
    setSize,
    nextDueAt: due < sets ? startedAt + due * gap : null,
  }
}

export const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const describeRoutine = (routine: Routine) =>
  [...new Set(Object.values(routine).map(p => `${p.goal}${p.unit ?? ''} ${p.exercise}`))].join(' / ')

export const HELP = `## House rules

**Your agent put in the reps. You next.**
When a turn runs long, drop and do a set.

### Log a set
\`/fit 20\` adds 20 reps
or press **+5 / +10 / +25** above the prompt

### Commands
| Command | Does |
|---|---|
| \`/fit\` | today's progress |
| \`/fit set 80\` | fix today's count |
| \`/fit reset\` | today back to 0 |
| \`/fit swap\` | switch today's exercise |
| \`/fit rest\` | rest day (breaks streak) |
| \`/fit rest off\` | undo today's rest day |
| \`/fit score\` | streak + grid |
| \`/fit program\` | pick your training |
| \`/fit strict\` / \`/fit easy\` | strict mode on / off |
| \`/fit rules\` | these rules |
| \`/fit start\` | replay the welcome |
| \`/fit hide\` | close panels |

### Strict mode
Off by default. When it's on:
- today's goal is split into sets, spread over 8 hours (by default) from your first prompt
- prompts before 5am count as the night before
- the first set is due right away
- fall behind and your prompts wait until you catch up
- a toast tells you when each set comes due
- \`/fit rest\` bails, but costs your streak

**Turn it on:** type \`/fit strict\`
**Turn it off:** type \`/fit easy\`

### Your data
Stays on this machine, in \`~/.claude/fitness\`.`

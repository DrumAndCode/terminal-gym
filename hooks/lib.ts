import type { Day } from '../types'

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

const USAGE = 'usage: /fit [<n> | set <n> | reset | swap [exercise] | rest | score | program | rules | coach strict|easy | tour | hide]'

export const parseFit = (args: string): FitCommand => {
  const [head = '', value] = args.trim().split(/\s+/)
  if (head === '' || head === 'status') return { kind: 'status' }
  if (head === 'score') return { kind: 'week' }
  if (head === 'rest') return { kind: 'skip' }
  if (head === 'program') return { kind: 'program' }
  if (head === 'swap') {
    // Names may be several words ("jumping jacks"): keep everything after "swap".
    const name = args.trim().replace(/^swap\s*/, '').replace(/\s+/g, ' ').toLowerCase()
    return name === '' ? { kind: 'swap' } : { kind: 'swap', exercise: name }
  }
  if (head === 'rules') return { kind: 'help' }
  if (head === 'hide') return { kind: 'hide' }
  if (head === 'reset') return { kind: 'reset' }
  if (head === 'tour') return { kind: 'intro' }
  if (head === 'coach') {
    return value === 'strict' || value === 'easy'
      ? { kind: 'strict', isOn: value === 'strict' }
      : { kind: 'error', text: 'usage: /fit coach strict | easy' }
  }
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
      words[at] = isGap ? 0x20 : 0x2588
      words[at + 1] = color
      words[at + 2] = DEFAULT
    }
  }
  return { columns, rows: weeks, cells: (new Uint8Array(words.buffer) as Base64Bytes).toBase64() }
}

// Same muted accents the old statusline used: amber in progress, green done.
export const progressColor = (count: number, goal: number) =>
  goal > 0 && count >= goal ? '#87af87' : count > 0 ? '#d7af5f' : undefined

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
| \`/fit score\` | streak + grid |
| \`/fit program\` | pick your training |
| \`/fit coach strict\` | strict mode |
| \`/fit rules\` | these rules |
| \`/fit tour\` | replay the welcome |
| \`/fit hide\` | close panels |

### Strict mode
Off by default. When it's on:
- long turns put you in rep debt
- your next prompt waits until you pay it off
- \`/fit rest\` bails, but costs your streak

**Turn it on:** type \`/fit coach strict\`
**Turn it off:** type \`/fit coach easy\`

### Your data
Stays on this machine, in \`~/.claude/fitness\`.`

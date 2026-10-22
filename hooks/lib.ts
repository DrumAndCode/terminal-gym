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
  | { kind: 'reload' }
  | { kind: 'reset' }
  | { kind: 'intro' }
  | { kind: 'program' }
  | { kind: 'swap'; exercise?: string }
  | { kind: 'strict'; isOn: boolean }
  | { kind: 'progress'; isOn: boolean }
  | { kind: 'add'; n: number }
  | { kind: 'set'; n: number }
  | { kind: 'goal'; n: number }
  // null: back to the configured window from the first prompt.
  | { kind: 'window'; hours: number | null }
  | { kind: 'window-until'; hour: number; minute: number }
  | { kind: 'snooze'; minutes: number }
  | { kind: 'error'; text: string }

// How long a set can be put off, and how often.
export const SNOOZE = { defaultMinutes: 30, maxMinutes: 60, perDay: 2 } as const

const USAGE = 'usage: /fit [<n> | set <n> | reset | goal <n> | window <hours>|<hhmm>|off | snooze [minutes] | swap [exercise] | rest [off] | streak | program | progress [off] | help | strict | easy | reload | start | hide]'

export const parseFit = (args: string): FitCommand => {
  const [head = '', value] = args.trim().split(/\s+/)
  if (head === '' || head === 'status') return { kind: 'status' }
  if (head === 'streak') return { kind: 'week' }
  if (head === 'rest') return value === 'off' ? { kind: 'unskip' } : { kind: 'skip' }
  if (head === 'program') return { kind: 'program' }
  if (head === 'swap') {
    // Names may be several words ("jumping jacks"): keep everything after "swap".
    const name = args.trim().replace(/^swap\s*/, '').replace(/\s+/g, ' ').toLowerCase()
    return name === '' ? { kind: 'swap' } : { kind: 'swap', exercise: name }
  }
  if (head === 'help' || head === 'rules') return { kind: 'help' }
  if (head === 'hide') return { kind: 'hide' }
  if (head === 'reload' || head === 'sync') return { kind: 'reload' }
  if (head === 'reset') return { kind: 'reset' }
  if (head === 'start') return { kind: 'intro' }
  if (head === 'strict') return { kind: 'strict', isOn: value !== 'off' }
  if (head === 'easy') return { kind: 'strict', isOn: false }
  if (head === 'progress') return { kind: 'progress', isOn: value !== 'off' }
  if (head === 'set') {
    return value !== undefined && /^\d+$/.test(value)
      ? { kind: 'set', n: Number(value) }
      : { kind: 'error', text: 'fit: set needs a number' }
  }
  if (head === 'goal') {
    return value !== undefined && /^\d+$/.test(value) && Number(value) > 0
      ? { kind: 'goal', n: Number(value) }
      : { kind: 'error', text: 'fit: goal needs a number of reps, like /fit goal 60' }
  }
  if (head === 'window') {
    if (value === 'off') return { kind: 'window', hours: null }
    // "1240", "940" or "12:40": an end time today, on the 24-hour clock.
    const clock = value === undefined ? null : /^(\d{1,2}):?(\d{2})$/.exec(value)
    if (clock !== null && (value?.includes(':') === true || (value?.length ?? 0) >= 3)) {
      const hour = Number(clock[1])
      const minute = Number(clock[2])
      return hour < 24 && minute < 60
        ? { kind: 'window-until', hour, minute }
        : { kind: 'error', text: 'fit: window needs a time like 1240 or 12:40 (24-hour clock)' }
    }
    // "3", "1.5" or "3h": hours from now, up to a day.
    const hours = value !== undefined && /^\d+(\.\d+)?h?$/.test(value) ? parseFloat(value) : NaN
    return hours > 0 && hours <= 24
      ? { kind: 'window', hours }
      : { kind: 'error', text: 'fit: window needs hours from now (up to 24) like /fit window 3, an end time like 1240, or off' }
  }
  if (head === 'snooze' || head === 'later') {
    // "30" or "30m": minutes from now, within the cap.
    const minutes = value === undefined ? SNOOZE.defaultMinutes : /^\d+m?$/.test(value) ? parseInt(value, 10) : NaN
    return minutes > 0 && minutes <= SNOOZE.maxMinutes
      ? { kind: 'snooze', minutes }
      : { kind: 'error', text: `fit: snooze takes minutes from now, up to ${SNOOZE.maxMinutes}, like /fit snooze 30` }
  }
  if (/^-?\d+$/.test(head)) return { kind: 'add', n: Number(head) }
  return { kind: 'error', text: USAGE }
}

export const isDone = (day: Day) => !day.isSkipped && day.goal > 0 && day.count >= day.goal

// Any reps keep a streak alive; only a day with none, or a rest day, breaks it.
export const keepsStreak = (day: Day) => !day.isSkipped && day.count > 0

// Today counts once it has reps; an empty today does not break the run yet,
// but a rest day taken today does.
export const streak = (history: readonly Day[]) => {
  let run = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const day = history[i]
    if (day === undefined) break
    if (keepsStreak(day)) run++
    else if (i !== history.length - 1 || day.isSkipped) break
  }
  return run
}

// The engine environment has Uint8Array#toBase64; es2023 typings do not.
type Base64Bytes = Uint8Array & { toBase64: () => string }

const ACCENT = 0xc8a86b
const PARTIAL = 0x6b5d3f
const EMPTY = 0x343434
const DEFAULT = 0x01000000

// The streak, counting days older than the window when every day in it has reps.
export const fullStreak = (history: readonly Day[], older: number) => {
  const run = streak(history)
  const last = history[history.length - 1]
  const coversWindow = run === history.length || (run === history.length - 1 && last !== undefined && !keepsStreak(last) && !last.isSkipped)
  return coversWindow ? run + older : run
}

// The grid's colors as text colors, for its legend.
export const GRID_COLORS = {
  goal: `#${ACCENT.toString(16)}`,
  some: `#${PARTIAL.toString(16)}`,
  none: `#${EMPTY.toString(16)}`,
} as const

// One row per week, seven 2-cell days with a gap: 20 columns. A blank row
// between weeks keeps the days square, so it reads as a grid, not bars.
export const heatCells = (history: readonly Day[]) => {
  const weeks = Math.ceil(history.length / 7)
  const columns = 20
  const rows = Math.max(1, weeks * 2 - 1)
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    const week = row / 2
    for (let col = 0; col < columns; col++) {
      const day = row % 2 === 1 ? undefined : history[week * 7 + Math.floor(col / 3)]
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
      const isToday = row % 2 === 0 && week * 7 + Math.floor(col / 3) === history.length - 1
      words[at] = isGap ? 0x20 : isToday ? 0x2592 : 0x2588
      words[at + 1] = color
      words[at + 2] = DEFAULT
    }
  }
  return { columns, rows, cells: (new Uint8Array(words.buffer) as Base64Bytes).toBase64() }
}

// Grey until the first rep, then yellow on the way and green for the last fifth.
// No red: an unfinished day is work in progress, not an error. No goal: undefined draws dim.
export const progressColor = (count: number, goal: number) => {
  if (goal <= 0 || count <= 0) return undefined
  const share = count / goal
  return share >= 0.8 ? '#87af87' : '#d7af5f'
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

// Each exercise in a routine once, with its first day's goal.
export const exerciseGoals = (routine: Routine) => {
  const goals: Record<string, number> = {}
  for (const plan of Object.values(routine)) goals[plan.exercise] ??= plan.goal
  return goals
}

// A custom program: the base routine's days, each exercise at the goal typed
// for it. A field left at its prefill changes nothing, so days that differ keep
// their own goals. Undefined while any goal isn't a whole number above zero.
export const customRoutine = (base: Routine, goals: Record<string, string>): Routine | undefined => {
  const parsed = new Map<string, number>()
  for (const [exercise, prefill] of Object.entries(exerciseGoals(base))) {
    const text = (goals[exercise] ?? '').trim()
    if (!/^\d+$/.test(text) || Number(text) <= 0) return undefined
    if (Number(text) !== prefill) parsed.set(exercise, Number(text))
  }
  return Object.fromEntries(
    Object.entries(base).map(([day, plan]) => [day, { ...plan, goal: parsed.get(plan.exercise) ?? plan.goal }]),
  )
}

// "30 burpees" typed under Other: one exercise every day.
export const parseCustom = (text: string): Routine | undefined => {
  const match = /^\s*(\d+)\s+([a-z][a-z -]*?)\s*$/i.exec(text)
  if (match === null) return undefined
  const [, goal = '0', exercise = ''] = match
  return Number(goal) > 0 ? daily(exercise.toLowerCase(), Number(goal)) : undefined
}

// A goal's step: a twentieth (5%) in fives, at least 5.
export const stepFor = (goal: number) => Math.max(5, Math.round(goal / 20 / 5) * 5)

// Where an exercise's goal goes next, from its days before today, newest first.
// Only days with reps count as sessions: rest days and empty days are passed
// over. The last session must have been trained at `goal`, so a day with a goal
// of its own (`/fit goal`) or one already counted moves nothing. A hit steps up;
// two short sessions in a row step back. Undefined: the goal stays.
export const nextGoal = (goal: number, past: readonly Day[]) => {
  const [last, before] = past.filter(day => !day.isSkipped && day.count > 0)
  if (last === undefined || goal <= 0 || last.goal !== goal) return undefined
  if (last.count >= goal) return goal + stepFor(goal)
  if (before === undefined || before.goal !== goal || before.count >= goal) return undefined
  // Never below 5, and a goal already there stays.
  const down = Math.max(5, goal - stepFor(goal))
  return down < goal ? down : undefined
}

// Whether an exercise's goal can move: every routine day of it at one goal. A
// routine that sets two goals for one exercise trades sessions between them,
// so neither is the last session of the other.
export const canProgress = (routine: Routine, exercise: string) =>
  new Set(Object.values(routine).filter(plan => plan.exercise === exercise).map(plan => plan.goal)).size === 1

// The routine with an exercise's goal moved: only the days at the old goal, so
// days a custom program set apart keep theirs.
export const moveGoal = (routine: Routine, exercise: string, from: number, to: number): Routine =>
  Object.fromEntries(
    Object.entries(routine).map(([day, plan]) => [
      day,
      plan.exercise === exercise && plan.goal === from ? { ...plan, goal: to } : plan,
    ]),
  )

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

// The band's quick-log buttons: a third, two thirds and a whole set, in fives
// (tens from a 60-rep set); the last is the set exactly. A set too small for
// three steps gets half, one and two, without repeats.
export const repSteps = (setSize: number) => {
  if (setSize <= 0) return [5, 10, 25]
  const step = setSize >= 60 ? 10 : 5
  const [third, twoThirds] = [1, 2].map(i => Math.round((setSize * i) / 3 / step) * step) as [number, number]
  if (third > 0 && third < twoThirds && twoThirds < setSize) return [third, twoThirds, setSize]
  return [...new Set([Math.ceil(setSize / 2), setSize, setSize * 2])]
}

// The goal as evenly spaced sets: the first due at the start, the last at the
// end of the window. `required` is what should be done by `now`.
const setGap = (goal: number, setSize: number, windowMs: number) => {
  const sets = Math.ceil(goal / setSize)
  return sets > 1 ? windowMs / (sets - 1) : windowMs
}

export const paceAt = (
  goal: number,
  count: number,
  setSize: number,
  startedAt: number,
  now: number,
  windowMs: number,
): Pace => {
  if (goal <= 0 || setSize <= 0) return { required: 0, behind: 0, setSize, nextDueAt: null, restUntil: null }
  const sets = Math.ceil(goal / setSize)
  const gap = setGap(goal, setSize, windowMs)
  const due = Math.min(sets, 1 + Math.floor(Math.max(0, now - startedAt) / gap))
  const required = Math.min(goal, due * setSize)
  return {
    required,
    behind: Math.max(0, required - count),
    setSize,
    nextDueAt: due < sets ? startedAt + due * gap : null,
    restUntil: null,
  }
}

// Behind, a set logged (a short one counts) earns a breather of half the gap
// between sets before the rest is due: catching up never means back-to-back sets.
export const breatherMs = (goal: number, setSize: number, windowMs: number) =>
  goal <= 0 || setSize <= 0 ? 0 : setGap(goal, setSize, windowMs) / 2

// Time left, rounded up to the minute: "23m", "1h", "1h 5m".
export const untilText = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`
}

export const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const describeRoutine = (routine: Routine) =>
  [...new Set(Object.values(routine).map(p => `${p.goal}${p.unit ?? ''} ${p.exercise}`))].join(' / ')

export const HELP = `## Help

**Your agent put in the reps. You next.**
When a turn runs long, drop and do a set.

### Log a set
\`/fit 20\` adds 20 reps
or press a **+** button above the prompt (sized to your set)

### Commands
| Command | Does |
|---|---|
| \`/fit\` | today's progress |
| \`/fit set 80\` | fix today's count |
| \`/fit reset\` | today back to 0 |
| \`/fit goal 60\` | change today's goal |
| \`/fit window 3\` | finish today in the next 3h |
| \`/fit snooze 30\` | put the due set off 30 min (twice a day) |
| \`/fit swap\` | switch today's exercise |
| \`/fit rest\` | rest day, before any reps (breaks streak) |
| \`/fit rest off\` | undo today's rest day |
| \`/fit streak\` | streak + grid |
| \`/fit program\` | pick your training |
| \`/fit progress\` | hit a goal, the next session of it goes up 5% (\`off\` to stop) |
| \`/fit strict\` / \`/fit easy\` | strict mode on / off |
| \`/fit help\` | this list |
| \`/fit reload\` | re-read the log now (other sessions sync every 10s anyway) |
| \`/fit start\` | replay the welcome |
| \`/fit hide\` | close panels |

### Strict mode
Off by default. When it's on:
- today's goal is split into sets, spread over 8 hours (by default) from your first prompt
- \`/fit window 3\` spreads what's left over the next 3 hours instead (ending by midnight)
- prompts before 5am count as the night before
- the first set is due right away
- fall behind and your prompts wait until you catch up
- log a set, even a short one, and you get a breather before the rest
- just eaten? \`/fit snooze 30\` puts the due set off, once per set and twice a day
- a toast tells you when each set comes due
- \`/fit easy\` stops holding prompts; \`/fit rest\` (before any reps) takes the day off

**Turn it on:** type \`/fit strict\`
**Turn it off:** type \`/fit easy\`

### Your data
Stays on this machine, in \`~/.claude/fitness\`.`

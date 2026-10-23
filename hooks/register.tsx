import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Day, OnboardPick, Pace, Today } from '../types'
import {
  DEFAULT_ROUTINE,
  BARBELL,
  HELP,
  SNOOZE,
  MINI_BARBELL,
  ROUTINES,
  SIZES,
  bar,
  earnedBreatherMs,
  clockTime,
  untilText,
  paceAt,
  setSizeFor,
  stepFor,
  buttonsWidth,
  canProgress,
  cells,
  cheer,
  customRoutine,
  dayKey,
  exerciseGoals,
  fullStreak,
  keepsStreak,
  describeRoutine,
  GRID_COLORS,
  heatCells,
  lastDays,
  moveGoal,
  nextGoal,
  parseFit,
  pickSwap,
  progressColor,
  repSteps,
  scale,
  streak,
  weekdayKey,
} from './lib'
import type { Routine } from './lib'

type Engine = EngineInterface

const PANE = 'gym-week'
const HELP_PANE = 'gym-help'
const ONBOARD_PANE = 'gym-onboard'
const HISTORY_DAYS = 28
const TOAST_MS = 10_000
const HOUR_MS = 60 * 60_000
// How often a session looks for reps another session, or the shell, logged.
const SYNC_MS = 10_000

// Toasts stay up long enough to read mid-set.
const toast = ($: Engine, text: string) => $.ui.toast(text, { timeoutMs: TOAST_MS })

// The pace settings, set from the options each time the module registers.
const paceConfig = { setSize: 0, windowMs: 8 * HOUR_MS }
let dueTimer: { cancel: () => void } | undefined
// Redraws the band each minute, so "rest for 13m" and "next set in 23m" count down.
let bandTicker: { cancel: () => void } | undefined
// Polls the log on disk, which every session and the shell script share.
let syncTimer: { cancel: () => void } | undefined
// The log as this session last read it: the routine's time and each day's file.
let seenOnDisk = ''
// Progressive goals, set from the options; and the day this session last moved
// a goal for, so the check runs once a day.
const progressConfig = { isOn: false }
let progressedOn = ''

const today = atom({ plugin: 'terminal-gym', key: 'today' } as const, null)
const olderStreak = atom({ plugin: 'terminal-gym', key: 'olderStreak' } as const, 0)
const pace = atom({ plugin: 'terminal-gym', key: 'pace' } as const, null)
const isWaiting = atom({ plugin: 'terminal-gym', key: 'isWaiting' } as const, false)
const history = atom({ plugin: 'terminal-gym', key: 'history' } as const, [])
const isIntroduced = atom({ plugin: 'terminal-gym', key: 'isIntroduced' } as const, false)
const onboardStep = atom({ plugin: 'terminal-gym', key: 'onboardStep' } as const, 0)
const onboardPick = atom({ plugin: 'terminal-gym', key: 'onboardPick' } as const, {
  program: 'Push · dip · squat rotation',
  size: 'Standard',
  hasRoutine: false,
  base: DEFAULT_ROUTINE,
  custom: {},
  isCustomInvalid: false,
})

// Same files as the `fit` shell script, so both agree.
const files = async ($: Engine) => {
  const dir = `${(await $.env.get('HOME')) ?? ''}/.claude/fitness`
  return { routine: `${dir}/routine.json`, log: `${dir}/log` }
}

const loadRoutine = async ($: Engine, routinePath: string): Promise<Routine> => {
  if (!(await $.fs.exists(routinePath))) {
    await $.fs.write(routinePath, `${JSON.stringify(DEFAULT_ROUTINE, null, 2)}\n`)
    return DEFAULT_ROUTINE
  }
  return JSON.parse(await $.fs.read(routinePath)) as Routine
}

const readCount = async ($: Engine, path: string) => {
  if (!(await $.fs.exists(path))) return 0
  const n = parseInt(await $.fs.read(path), 10)
  return Number.isFinite(n) ? n : 0
}

// `/fit swap` leaves the day's plan beside its count as `<date>.swap`.
const readSwap = async ($: Engine, logDir: string, date: string): Promise<Routine[string] | undefined> => {
  const path = `${logDir}/${date}.swap`
  if (!(await $.fs.exists(path))) return undefined
  // A damaged or odd file falls back to the routine instead of breaking every refresh.
  try {
    const plan = JSON.parse(await $.fs.read(path)) as Partial<Routine[string]>
    return typeof plan.exercise === 'string' && typeof plan.goal === 'number'
      ? { exercise: plan.exercise, goal: plan.goal, unit: plan.unit }
      : undefined
  } catch {
    return undefined
  }
}

// `/fit rest` leaves `<date>.skip`; `/fit rest off` writes "off" into it to undo.
const readRest = async ($: Engine, path: string) =>
  (await $.fs.exists(path)) && (await $.fs.read(path)).trim() !== 'off'

// Progressive goals: at the day's first look, today's exercise moves on from
// its last sessions, the next time it comes around. Days before are frozen at
// the goals they were trained at first. Two sessions at once compute the same
// move, and the second finds the routine already moved, so a goal moves once.
const progress = async ($: Engine, date: string) => {
  if (!progressConfig.isOn || progressedOn === date) return
  progressedOn = date
  const { routine: routinePath, log: logDir } = await files($)
  // A day with a plan of its own (`/fit swap`, `/fit goal`) isn't the routine's.
  if (await $.fs.exists(`${logDir}/${date}.swap`)) return
  const routine = await loadRoutine($, routinePath)
  const now = await $.clock.now()
  const plan = routine[weekdayKey(now)]
  if (plan === undefined || !canProgress(routine, plan.exercise)) return
  const before = lastDays(now, HISTORY_DAYS).slice(0, -1).reverse()
  const days = await Promise.all(before.map(ms => readDay($, routine, logDir, ms)))
  const to = nextGoal(plan.goal, days.filter(day => day.exercise === plan.exercise))
  if (to === undefined) return
  await freezePastDays($, routine)
  await $.fs.write(routinePath, `${JSON.stringify(moveGoal(routine, plan.exercise, plan.goal, to), null, 2)}\n`)
  const unit = plan.unit ?? ''
  toast($, to > plan.goal
    ? `📈 ${plan.exercise} up to ${to}${unit}: your last session hit ${plan.goal}${unit}.`
    : `${plan.exercise} back to ${to}${unit} after two short sessions. Rebuild.`)
}

const refreshToday = async ($: Engine): Promise<Today> => {
  const { routine, log: logDir } = await files($)
  const date = dayKey(await $.clock.now())
  await progress($, date)
  const plan =
    (await readSwap($, logDir, date)) ?? (await loadRoutine($, routine))[weekdayKey(await $.clock.now())]
  const next: Today = {
    date,
    exercise: plan?.exercise ?? 'reps',
    goal: plan?.goal ?? 0,
    unit: plan?.unit ?? '',
    count: await readCount($, `${logDir}/${date}`),
    isRest: await readRest($, `${logDir}/${date}.skip`),
  }
  await update($, today, () => next)
  return next
}

const DAY_MS = 86_400_000

const readDay = async ($: Engine, routine: Routine, logDir: string, ms: number): Promise<Day> => {
  const date = dayKey(ms)
  const plan = (await readSwap($, logDir, date)) ?? routine[weekdayKey(ms)]
  return {
    date,
    count: await readCount($, `${logDir}/${date}`),
    goal: plan?.goal ?? 0,
    exercise: plan?.exercise ?? 'reps',
    isSkipped: await readRest($, `${logDir}/${date}.skip`),
  }
}

// Days with reps in a row just before the window, so a streak can outlast it.
// Cached per window: a full walk once, then one day's step as the window slides.
const olderRun = async ($: Engine, days: readonly Day[], routine: Routine, logDir: string) => {
  const first = days[0]
  if (first === undefined || !keepsStreak(first)) {
    await $.store.delete('streakRun')
    return 0
  }
  const oldest = lastDays(await $.clock.now(), HISTORY_DAYS)[0] ?? 0
  const asOf = dayKey(oldest)
  const cache = (await $.store.get('streakRun')) as { asOf?: string; older?: number } | undefined
  let older: number
  if (cache?.asOf === asOf && typeof cache.older === 'number') {
    older = cache.older
  } else if (cache?.asOf === dayKey(oldest - DAY_MS) && typeof cache.older === 'number') {
    // The window moved on a day: the day that left it joins the older run.
    older = keepsStreak(await readDay($, routine, logDir, oldest - DAY_MS)) ? cache.older + 1 : 0
  } else {
    older = 0
    for (let back = 1; back <= 366; back++) {
      if (!keepsStreak(await readDay($, routine, logDir, oldest - back * DAY_MS))) break
      older++
    }
  }
  await $.store.set('streakRun', { asOf, older })
  return older
}

const refreshHistory = async ($: Engine) => {
  const { routine: routinePath, log: logDir } = await files($)
  const routine = await loadRoutine($, routinePath)
  const days: Day[] = await Promise.all(
    lastDays(await $.clock.now(), HISTORY_DAYS).map(async ms => {
      const date = dayKey(ms)
      const plan = (await readSwap($, logDir, date)) ?? routine[weekdayKey(ms)]
      return {
        date,
        count: await readCount($, `${logDir}/${date}`),
        goal: plan?.goal ?? 0,
        exercise: plan?.exercise ?? 'reps',
        isSkipped: await readRest($, `${logDir}/${date}.skip`),
      }
    }),
  )
  await update($, history, () => days)
  const older = await olderRun($, days, routine, logDir)
  await update($, olderStreak, () => older)
  return days
}

type Schedule = { from: number; ms: number; base: number }

// The day's pace, kept in `<date>.day` beside its count so every session reads
// the same one: when the day started, a `/fit window`, a breather's end, and
// the `/fit snooze`s taken (how many today, and the due point the last put off).
type DayState = { start?: number; window?: Schedule; breather?: number; laters?: number; putOff?: number }

const dayPath = async ($: Engine, date: string) => `${(await files($)).log}/${date}.day`

const isSchedule = (w: unknown): w is Schedule =>
  typeof w === 'object' && w !== null && ['from', 'ms', 'base'].every(k => typeof (w as Record<string, unknown>)[k] === 'number')

// Only the fields of the right shape: a damaged file reads as an empty day.
const asDayState = (raw: unknown): DayState => {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    ...(typeof r.start === 'number' ? { start: r.start } : {}),
    ...(isSchedule(r.window) ? { window: r.window } : {}),
    ...(typeof r.breather === 'number' ? { breather: r.breather } : {}),
    ...(typeof r.laters === 'number' ? { laters: r.laters } : {}),
    ...(typeof r.putOff === 'number' ? { putOff: r.putOff } : {}),
  }
}

// Up to 0.1.4 these sat in the plugin store, which a session may cache. A day
// started before the update still reads from there until its file is written.
const legacyDayState = async ($: Engine, date: string): Promise<DayState> => {
  const dated = (key: string) => $.store.get(key) as Promise<{ date?: string; [k: string]: unknown } | undefined>
  const [start, window, breather] = await Promise.all([dated('dayStart'), dated('window'), dated('breather')])
  return asDayState({
    start: start?.date === date ? start.at : undefined,
    window: window?.date === date ? { from: window.from, ms: window.ms, base: window.base } : undefined,
    breather: breather?.date === date ? breather.until : undefined,
  })
}

// The file's state, or null when it doesn't parse: another session may be
// mid-write, so a damaged file is read once more before giving up.
const readDayFile = async ($: Engine, path: string): Promise<DayState | null> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return asDayState(JSON.parse(await $.fs.read(path)))
    } catch {
      // Read it again.
    }
  }
  return null
}

const readDayState = async ($: Engine, date: string): Promise<DayState> => {
  const path = await dayPath($, date)
  if (!(await $.fs.exists(path))) return legacyDayState($, date)
  return (await readDayFile($, path)) ?? {}
}

// A damaged file is never written over: that would make the other session's
// loss permanent. The change is skipped, and the next one finds the file whole.
const writeDayState = async ($: Engine, date: string, change: (state: DayState) => DayState) => {
  const path = await dayPath($, date)
  const state = (await $.fs.exists(path)) ? await readDayFile($, path) : await legacyDayState($, date)
  if (state === null) return false
  await $.fs.write(path, `${JSON.stringify(change(state))}\n`)
  return true
}

// The day starts at the person's first prompt; sets are spread from there.
const dayStart = async ($: Engine, date: string) => (await readDayState($, date)).start

// Prompts before this hour belong to the night before: they never start the
// day, or a 00:30 prompt would leave every set overdue by morning.
const DAY_BEGINS_HOUR = 5

const startDay = async ($: Engine) => {
  const now = await $.clock.now()
  if (new Date(now).getHours() < DAY_BEGINS_HOUR) return
  const date = dayKey(now)
  if ((await dayStart($, date)) === undefined) await writeDayState($, date, s => ({ ...s, start: now }))
}

// Ends a breather, and forgets which set a `/fit snooze` put off: with the debt
// cleared or the count lowered, that set is no longer the one due.
const endBreather = ($: Engine, date: string) =>
  writeDayState($, date, ({ breather: _b, putOff: _p, ...rest }) => rest)

// `/fit goal` and `/fit window` change which set is due. A breather sized for
// the old schedule ends. A put-off keeps its time, since the person's minutes
// set it, not the goal, and it now names the new due point.
const reschedule = async ($: Engine, date: string): Promise<Pace | null> => {
  const now = await $.clock.now()
  const { breather, putOff } = await readDayState($, date)
  const kept = putOff !== undefined && breather !== undefined && breather > now
  await writeDayState($, date, ({ breather: b, putOff: _, ...rest }) => (kept ? { ...rest, breather: b } : rest))
  const p = await refreshPace($)
  if (!kept || p === null) return p
  await writeDayState($, date, s => ({ ...s, putOff: p.required }))
  return refreshPace($)
}

// The span today's sets are spread over: the configured window from the first
// prompt, or after `/fit window`, the reps left then (above `base`) over the hours named.
const scheduleOf = ({ window, start }: DayState): Schedule | undefined => {
  if (window !== undefined) return window
  return start === undefined ? undefined : { from: start, ms: paceConfig.windowMs, base: 0 }
}

const schedule = async ($: Engine, date: string) => scheduleOf(await readDayState($, date))

// Recomputes the pace and arms a timer for the next set or breather's end.
const refreshPace = async ($: Engine): Promise<Pace | null> => {
  dueTimer?.cancel()
  dueTimer = undefined
  // Re-read today: the date may have rolled over, or the shell script logged reps.
  const t = await refreshToday($)
  const day = t === null ? {} : await readDayState($, t.date)
  const s = scheduleOf(day)
  const now = await $.clock.now()
  let next: Pace | null = null
  if (t !== null && !t.isRest && s !== undefined) {
    const left = paceAt(Math.max(0, t.goal - s.base), t.count - s.base, setSizeFor(t.goal, paceConfig.setSize), s.from, now, s.ms)
    next = {
      ...left,
      // Goal met: the schedule may still hold sets, but none are due.
      nextDueAt: t.goal > 0 && t.count >= t.goal ? null : left.nextDueAt,
      required: left.required + s.base,
      // A breather still running: catch-up reps owed, but prompts not held.
      restUntil: day.breather !== undefined && day.breather > now ? day.breather : null,
      isPutOff: day.putOff !== undefined && day.putOff === left.required + s.base,
      // A window set mid-day (base > 0) is never the day's opener, even after a reset.
      isOpening: s.base === 0 && t.count === 0 && left.behind > 0 && left.required <= left.setSize,
    }
  }
  await update($, pace, () => next)
  bandTicker?.cancel()
  bandTicker = undefined
  // Only the countdowns paceText draws: "rest for 13m" and "next set in 23m".
  const countdownTo = next === null ? null
    : next.behind > 0 ? (next.isPutOff !== true ? next.restUntil : null)
    : next.nextDueAt
  if (countdownTo !== null) {
    // Wake when the minute shown changes, so a re-arm (a sync, a prompt) never delays it.
    // Each wait is measured from the clock, so an early timer or a sleep corrects itself.
    const tick = (at: number) => {
      const left = countdownTo - at
      if (left <= 0) return
      const timer = $.clock.after(left % 60_000 || 60_000, async () => {
        $.ui.invalidate('ui.render')
        const at = await $.clock.now()
        // A refreshPace while this waited has armed its own ticker: leave it be.
        if (bandTicker === timer) tick(at)
      })
      bandTicker = timer
    }
    tick(now)
  }
  const wakeAt = Math.min(next?.nextDueAt ?? Infinity, next?.restUntil ?? Infinity)
  if (wakeAt !== Infinity && t !== null && t.count < t.goal) {
    dueTimer = $.clock.after(Math.max(1, wakeAt - now), () => void setDue($))
  }
  return next
}

const setDue = async ($: Engine) => {
  const p = await refreshPace($)
  const t = await read($, today)
  if (p === null || t === null || p.behind <= 0 || p.restUntil !== null) return
  toast($, p.isOpening === true
    ? `🏁 First set: ${p.behind} ${t.exercise} to start the day.`
    : `⏱ Set due: ${p.behind} ${t.exercise}. ${p.required}/${t.goal} by now.`)
}

// A Close button's press: a refused close says why instead of doing nothing.
const closePane = async ($: Engine, id: string) => {
  try {
    await $.ui.close({ id })
  } catch (err) {
    toast($, `Couldn't close the panel (${err instanceof Error ? err.message : String(err)}). Try Esc or /fit hide.`)
  }
}

// Owed reps read as a set that's due, not a debt; a breather as rest left.
const paceText = (p: Pace | null, isStrict: boolean, now: number) => {
  if (p === null) return ''
  if (p.isOpening === true) return `  🏁 first set: ${p.behind} to start the day`
  if (p.behind > 0 && p.restUntil !== null) {
    if (p.isPutOff === true) return `  ${p.behind} due · back at ${clockTime(p.restUntil)}`
    return `  ${p.behind} due · rest for ${untilText(p.restUntil - now)}`
  }
  if (p.behind > 0) return `  ${p.behind} due now${isStrict ? ' · log it to keep prompting' : ''}`
  return p.nextDueAt === null ? '' : `  next set in ${untilText(p.nextDueAt - now)}`
}

const line = (t: Today) => {
  const isDone = t.goal > 0 && t.count >= t.goal
  return `${isDone ? '✅' : '💪'} ${bar(t.count, t.goal)} ${t.count}/${t.goal}${t.unit} ${t.exercise}`
}

const withStreak = (t: Today, days: readonly Day[], older = 0) => {
  const run = fullStreak(days, older)
  return run > 0 ? `${line(t)}  🔥${run}d` : line(t)
}

const logReps = async ($: Engine, change: (count: number) => number) => {
  const owed = await refreshPace($)
  const before = await refreshToday($)
  const count = Math.max(0, change(before.count))
  await $.fs.write(`${(await files($)).log}/${before.date}`, `${count}\n`)

  const after = { ...before, count }
  await update($, today, () => after)
  await update($, history, days =>
    days.map(day => (day.date === after.date ? { ...day, count } : day)),
  )

  // A set that still leaves reps owed earns a breather before the rest: a short
  // one counts, and fewer reps than the band's smallest button earn a shorter
  // one. Clearing the debt or lowering the count ends one, so later sets aren't hidden.
  const added = count - before.count
  const stillOwed = owed === null ? 0 : owed.behind - added
  const s = await schedule($, after.date)
  if (owed !== null && s !== undefined && stillOwed > 0 && added > 0) {
    const until = (await $.clock.now()) + earnedBreatherMs(added, after.goal - s.base, owed.setSize, s.ms)
    const isFullSet = added >= (repSteps(owed.setSize)[0] ?? owed.setSize)
    // Reps never cut short a longer breather or put-off already running. A
    // full set means it's no longer the set that was put off; a few reps under
    // a put-off that ends later leave its hold and its mark alone.
    await writeDayState($, after.date, state => {
      const isLater = state.breather !== undefined && state.breather > until
      if (isLater && !isFullSet) return state
      const { putOff: _, ...rest } = state
      return { ...rest, breather: isLater ? state.breather : until }
    })
  } else if (stillOwed <= 0 || added < 0) {
    await endBreather($, after.date)
  }
  await refreshPace($)
  if (after.goal > 0 && before.count < after.goal && count >= after.goal) {
    // The routine's goal hit, by the rule `nextGoal` moves it on: say where the
    // next session of it goes. A swap counts; a goal of its own does not.
    const routine = await loadRoutine($, (await files($)).routine)
    const isPlanned = progressConfig.isOn && canProgress(routine, after.exercise) &&
      Object.values(routine).some(plan => plan.exercise === after.exercise && plan.goal === after.goal)
    const next = isPlanned ? ` Next ${after.exercise} day: ${after.goal + stepFor(after.goal)}${after.unit}.` : ''
    toast($, `✅ Done. ${count}/${after.goal}${after.unit} ${after.exercise}. That's the work.${next}`)
  } else if (added > 0) {
    toast($, cheer(added, count, after.goal, after.exercise, after.unit))
  }
  return after
}

// Everything on disk another session can change, as one string: the routine's
// modification time, then each log file's name, size and time. A directory's
// own time only moves when a file is added, not when today's count is rewritten.
const diskFingerprint = async ($: Engine) => {
  const { routine, log: logDir } = await files($)
  const routineAt = (await $.fs.exists(routine)) ? (await $.fs.stat(routine)).mtimeMs : 0
  const entries = (await $.fs.exists(logDir)) ? await $.fs.list(logDir) : []
  return [routineAt, ...entries.map(entry => `${entry.name}:${entry.size}:${entry.mtimeMs}`)].join('|')
}

// Re-reads today, the history and the pace when the files changed since this
// session last looked (or always, when forced). Two sessions share one log:
// a set logged in one shows in the other's band within a poll.
const syncFromDisk = async ($: Engine, isForced = false) => {
  let now: string
  try {
    now = await diskFingerprint($)
  } catch {
    // A missing or unreadable directory: nothing to catch up on this time.
    return false
  }
  if (!isForced && now === seenOnDisk) return false
  seenOnDisk = now
  await refreshHistory($)
  await refreshPace($)
  return true
}

// The reps the last nudge suggested, for the spinner.
let nudgeReps = 0

// Easy mode: a suggestion once a turn runs long, sized to the set that's due.
// On pace or in a breather there's nothing owed, so nothing to suggest.
const nudge = async ($: Engine) => {
  const p = await refreshPace($)
  const t = await read($, today)
  if (t === null || t.isRest || (t.goal > 0 && t.count >= t.goal)) return
  if (p !== null && (p.behind <= 0 || p.restUntil !== null)) return
  nudgeReps = p === null ? setSizeFor(t.goal, paceConfig.setSize) : Math.min(p.behind, p.setSize)
  if (nudgeReps <= 0) return
  await update($, isWaiting, () => true)
  toast($, `Your agent's mid-set. You next: ${nudgeReps} ${t.exercise}.`)
}

const endRest = async ($: Engine) => {
  const t = await refreshToday($)
  if (!t.isRest) return { text: `Today isn't a rest day. ${line(t)}` }
  await $.fs.write(`${(await files($)).log}/${t.date}.skip`, 'off\n')
  const back = await refreshToday($)
  await refreshHistory($)
  await refreshPace($)
  return { text: `Rest day undone. Back to work. ${line(back)}` }
}

const markIntroduced = async ($: Engine) => {
  await $.store.set('introduced', true)
  await update($, isIntroduced, () => true)
}

const KEEP = 'Keep my current routine'
const CUSTOM = 'Custom goals'
const DEFAULT_PROGRAM = 'Push · dip · squat rotation'

const openOnboarding = async ($: Engine) => {
  // Open first: a pane counts as asked for only while the press or command that
  // asked is still being answered. Opened after other awaits, the engine treats
  // it as unasked and leaves it undrawn below 144 columns.
  await update($, onboardStep, () => 0)
  const opened = await $.ui.open({ id: ONBOARD_PANE, title: 'TERMINAL GYM', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) toast($, 'Widen the terminal to see the walkthrough, or type /fit program.')
  // A seeded default counts as no routine of their own; only custom ones get "keep".
  const { routine: routinePath } = await files($)
  const base = await loadRoutine($, routinePath)
  const hasRoutine = JSON.stringify(base) !== JSON.stringify(DEFAULT_ROUTINE)
  // Custom starts from the current routine's days and goals.
  const custom = Object.fromEntries(Object.entries(exerciseGoals(base)).map(([name, goal]) => [name, String(goal)]))
  await update($, onboardPick, () => ({
    program: hasRoutine ? KEEP : DEFAULT_PROGRAM,
    size: 'Standard',
    hasRoutine,
    base,
    custom,
    isCustomInvalid: false,
  }))
}

const pickedRoutine = (p: OnboardPick): Routine | undefined => {
  if (p.program === CUSTOM) return customRoutine(p.base, p.custom)
  const preset = ROUTINES[p.program as keyof typeof ROUTINES] as Routine | undefined
  return preset === undefined ? undefined : scale(preset, SIZES[p.size as keyof typeof SIZES] ?? 1)
}

// A new program changes today on; the days before keep the plan they were
// trained against, written down as their own plan the way `/fit swap` does.
const freezePastDays = async ($: Engine, old: Routine) => {
  const { log: logDir } = await files($)
  for (const ms of lastDays(await $.clock.now(), HISTORY_DAYS).slice(0, -1)) {
    const path = `${logDir}/${dayKey(ms)}.swap`
    const plan = old[weekdayKey(ms)]
    if (plan !== undefined && !(await $.fs.exists(path))) await $.fs.write(path, `${JSON.stringify(plan)}\n`)
  }
}

const finishOnboarding = async ($: Engine) => {
  const p = await read($, onboardPick)
  const { routine: routinePath } = await files($)
  const routine = pickedRoutine(p)
  // A custom goal that isn't a number sends the person back to fix it.
  if (p.program === CUSTOM && routine === undefined) {
    await update($, onboardPick, now => ({ ...now, isCustomInvalid: true }))
    await update($, onboardStep, () => 1)
    return
  }
  if (routine !== undefined) {
    const old = await loadRoutine($, routinePath)
    if (JSON.stringify(old) !== JSON.stringify(routine)) await freezePastDays($, old)
    if (p.hasRoutine) await $.fs.write(`${routinePath}.bak`, await $.fs.read(routinePath))
    await $.fs.write(routinePath, `${JSON.stringify(routine, null, 2)}\n`)
  }
  await markIntroduced($)
  await refreshToday($)
  await refreshHistory($)
  await refreshPace($)
  await $.ui.close({ id: ONBOARD_PANE })
  const plan = routine ?? (JSON.parse(await $.fs.read(routinePath)) as Routine)
  toast($, `Program set: ${describeRoutine(plan)}. Get to work.`)
}

// A made-up fortnight for the walkthrough's example grid.
const SAMPLE_DAYS: Day[] = [1, 1, 0.4, 1, 1, 0, 1, 1, 1, 0.6, 1, 1, 1, 0.3].map((share, i) => ({
  date: `sample-${i}`,
  count: Math.round(share * 100),
  goal: 100,
  exercise: 'pushups',
  isSkipped: false,
}))

// Everything a conversation needs: the /fit command and today's state.
const boot = async ($: Engine) => {
  const introduced = (await $.store.get('introduced')) === true
  await update($, isIntroduced, () => introduced)
  // A new conversation looks again: the routine may have moved since.
  progressedOn = ''
  await refreshToday($)
  await refreshHistory($)
  // Re-arms the due timer, which a restart or reload drops.
  await refreshPace($)
  // Remember the log as read, then watch it for what other sessions log.
  try {
    seenOnDisk = await diskFingerprint($)
  } catch {
    seenOnDisk = ''
  }
  syncTimer?.cancel()
  syncTimer = $.clock.every(SYNC_MS, () => void syncFromDisk($))
  // Last, so a refused registration can't leave the band without its state.
  await $.command.register({
    name: 'fit',
    description: "Log reps toward today's goal",
    argumentHint: '[n | snooze [min] | goal n | window hours | swap | streak | strict | easy | help]',
    immediate: true,
  })
}

export const register: Register = (on, options) => {
  const isStrict = options.strict === true
  const nudgeMs = Number(options.nudgeSeconds ?? 30) * 1000
  // Whole reps only: a fractional set would make fractional buttons.
  paceConfig.setSize = Math.max(0, Math.round(Number(options.setSize ?? 0)) || 0)
  paceConfig.windowMs = Math.max(1, Number(options.windowHours ?? 8)) * HOUR_MS
  progressConfig.isOn = options.progress === true
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await boot($)
    return next(e)
  })

  // /clear and an in-session /resume switch to another conversation in the
  // same process without another session.start, so the setup runs again here.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') await boot($)
    return next(e)
  })

  on('command.run', { command: 'fit' }, async ($, e) => {
    const cmd = parseFit(e.args)
    switch (cmd.kind) {
      case 'error':
        return { text: cmd.text }
      case 'add':
      case 'set': {
        if ((await refreshToday($)).isRest) return { text: "Today's a rest day. /fit rest off to train." }
        const n = cmd.n
        const t = await logReps($, count => (cmd.kind === 'add' ? count + n : n))
        return { text: `${line(t)}${paceText(await read($, pace), isStrict, await $.clock.now())}` }
      }
      case 'skip': {
        const t = await refreshToday($)
        if (t.isRest) return { text: 'Already a rest day. /fit rest off to train.' }
        // Reps logged means a training day: a rest day would wipe the streak.
        if (t.count > 0) {
          return { text: `You've logged ${t.count}${t.unit} ${t.exercise} today, so it's a training day. /fit rest is for a day off; it resets your streak.` }
        }
        await $.fs.write(`${(await files($)).log}/${t.date}.skip`, '')
        await refreshToday($)
        await refreshHistory($)
        await refreshPace($)
        return { text: `Rest day logged. Streak resets, no sets due today. Back at it tomorrow. (/fit rest off to undo)` }
      }
      case 'unskip':
        return endRest($)
      case 'week': {
        if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
          await $.ui.close({ id: PANE })
          return { text: 'Scoreboard closed.' }
        }
        const days = await refreshHistory($)
        await $.ui.open({ id: PANE, title: 'TERMINAL GYM', focus: true, closeOnEscape: true })
        return { text: `🔥 ${fullStreak(days, await read($, olderStreak))}-day streak · Esc or /fit streak to close` }
      }
      case 'swap': {
        const before = await refreshToday($)
        const { routine: routinePath, log: logDir } = await files($)
        const routine = await loadRoutine($, routinePath)
        const names = [...new Set(Object.values(routine).map(p => p.exercise))]
        if (names.length === 0) return { text: 'Your program has no exercises. /fit program to pick one.' }
        const plan = pickSwap(routine, before.exercise, cmd.exercise)
        if (plan === undefined) {
          return { text: `No ${cmd.exercise} in your program. Pick one of: ${names.join(', ')}.` }
        }
        if (plan.exercise === before.exercise) return { text: `Already on ${plan.exercise} today.` }
        await $.fs.write(`${logDir}/${before.date}.swap`, `${JSON.stringify(plan)}\n`)
        await refreshHistory($)
        const amount = before.unit === '' ? `${before.count} reps` : `${before.count}${before.unit}`
        const carried = before.count > 0 ? ` Your ${amount} carry over.` : ''
        const swapped = await refreshToday($)
        await refreshPace($)
        return { text: `Swapped to ${plan.exercise} today.${carried} ${line(swapped)}` }
      }
      case 'goal': {
        // Today's plan with a new goal, in the same file `/fit swap` writes.
        const before = await refreshToday($)
        if (before.isRest) return { text: "Today's a rest day. /fit rest off to train." }
        const plan = { exercise: before.exercise, goal: cmd.n, ...(before.unit === '' ? {} : { unit: before.unit }) }
        await $.fs.write(`${(await files($)).log}/${before.date}.swap`, `${JSON.stringify(plan)}\n`)
        await refreshHistory($)
        const after = await refreshToday($)
        return { text: `Today's goal is ${cmd.n}${after.unit} ${after.exercise}. ${line(after)}${paceText(await reschedule($, before.date), isStrict, await $.clock.now())}` }
      }
      case 'window': {
        const t = await refreshToday($)
        if (cmd.hours === null) {
          await writeDayState($, t.date, ({ window: _, ...rest }) => rest)
          return {
            text: `Back to ${paceConfig.windowMs / HOUR_MS}h from your first prompt. ${line(t)}${paceText(await reschedule($, t.date), isStrict, await $.clock.now())}`,
          }
        }
        if (t.isRest) return { text: "Today's a rest day. /fit rest off to train." }
        if (t.goal <= 0) return { text: 'No goal today. /fit goal 60 to set one.' }
        if (t.count >= t.goal) return { text: `Today's goal is done. ${line(t)}` }
        const now = await $.clock.now()
        // Today ends at midnight: a window can't run into tomorrow's log. It ends a
        // minute early so its last set comes due today, not on the stroke of midnight.
        const d = new Date(now)
        const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
        const ms = Math.max(1, Math.min(cmd.hours * HOUR_MS, midnight - now - 60_000))
        await writeDayState($, t.date, s => ({ ...s, window: { from: now, ms, base: t.count } }))
        const span = ms < cmd.hours * HOUR_MS ? 'between now and midnight' : `over the next ${cmd.hours}h (done by ${clockTime(now + ms)})`
        return {
          text: `${t.goal - t.count}${t.unit} ${t.exercise} left, spread ${span}. ${line(t)}${paceText(await reschedule($, t.date), isStrict, await $.clock.now())}`,
        }
      }
      case 'window-until': {
        const t = await refreshToday($)
        if (t.isRest) return { text: "Today's a rest day. /fit rest off to train." }
        if (t.goal <= 0) return { text: 'No goal today. /fit goal 60 to set one.' }
        if (t.count >= t.goal) return { text: `Today's goal is done. ${line(t)}` }
        const now = await $.clock.now()
        const d = new Date(now)
        const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), cmd.hour, cmd.minute).getTime()
        const named = `${String(cmd.hour).padStart(2, '0')}:${String(cmd.minute).padStart(2, '0')}`
        if (end <= now) return { text: `${named} has already passed today. 3–4 digits are a clock time (1240 = 12:40); for hours from now, use 1–2 digits like /fit window 2.` }
        // The same window `/fit window <hours>` sets, ending at the time named.
        await writeDayState($, t.date, s => ({ ...s, window: { from: now, ms: end - now, base: t.count } }))
        return {
          text: `${t.goal - t.count}${t.unit} ${t.exercise} left, spread between now and ${named}. ${line(t)}${paceText(await reschedule($, t.date), isStrict, await $.clock.now())}`,
        }
      }
      case 'snooze': {
        // A breather with no reps logged: the set stays owed, prompts go through
        // until the time is up. Once per due set and twice a day, so strict stays strict.
        const p = await refreshPace($)
        const t = await read($, today)
        if (t === null || t.isRest) return { text: "Today's a rest day. Nothing to put off." }
        if (t.goal > 0 && t.count >= t.goal) return { text: `Today's goal is done. ${line(t)}` }
        if (p === null) return { text: 'Nothing is due yet. The day starts with your first prompt.' }
        if (p.behind <= 0) {
          return { text: p.nextDueAt === null ? 'Nothing is due.' : `Nothing is due until ${clockTime(p.nextDueAt)}. Put it off then.` }
        }
        if (p.restUntil !== null) {
          return { text: `Already ${p.isPutOff === true ? 'put off' : 'resting'} until ${clockTime(p.restUntil)}. Log a set, even a short one, when it ends.` }
        }
        const day = await readDayState($, t.date)
        if (day.putOff === p.required) {
          return { text: `This set was already put off once. Log it, even a short one (/fit ${repSteps(p.setSize)[0] ?? p.setSize} earns a breather).` }
        }
        if ((day.laters ?? 0) >= SNOOZE.perDay) {
          return { text: `That's ${SNOOZE.perDay} put off today already. Log a set, even a short one, or /fit easy stops holding prompts.` }
        }
        const until = (await $.clock.now()) + cmd.minutes * 60_000
        await writeDayState($, t.date, s => ({ ...s, breather: until, laters: (s.laters ?? 0) + 1, putOff: p.required }))
        return {
          text: `${p.behind} ${t.exercise} put off until ${clockTime(until)}. ${line(t)}${paceText(await refreshPace($), isStrict, await $.clock.now())}`,
        }
      }
      case 'program':
        await openOnboarding($)
        return { text: 'Pick your program.' }
      case 'intro':
        await $.store.delete('introduced')
        await update($, isIntroduced, () => false)
        return { text: 'Welcome is back above your prompt.' }
      case 'reset':
        return { text: `Reset. ${line(await logReps($, () => 0))}${paceText(await read($, pace), isStrict, await $.clock.now())}` }
      case 'help':
        await markIntroduced($)
        await $.ui.open({ id: HELP_PANE, title: 'HELP' })
        return { text: 'Help opened · /fit hide to close' }
      case 'strict': {
        const { deny } = await $.config.set({ key: 'terminal-gym.strict', value: cmd.isOn })
        if (deny !== undefined) return { text: `Couldn't change strict mode: ${deny}` }
        return {
          text: cmd.isOn
            ? `Coach is strict. Today's goal is spread into sets over ${paceConfig.windowMs / HOUR_MS}h from your first prompt; fall behind and prompts wait until you catch up.`
            : 'Coach is easy. Same schedule on the band, nudges only, nothing held.',
        }
      }
      case 'progress': {
        const { deny } = await $.config.set({ key: 'terminal-gym.progress', value: cmd.isOn })
        if (deny !== undefined) return { text: `Couldn't change progressive goals: ${deny}` }
        return {
          text: cmd.isOn
            ? 'Progressive goals on. Hit a goal, and the next session of that exercise is about 5% more. Two short sessions in a row step it back.'
            : 'Progressive goals off. Goals stay where they are now.',
        }
      }
      case 'hide':
        await $.ui.close({ id: PANE })
        await $.ui.close({ id: HELP_PANE })
        return { text: 'Terminal Gym panels closed.' }
      case 'status': {
        const t = await refreshToday($)
        const shown = withStreak(t, await refreshHistory($), await read($, olderStreak))
        return { text: `${shown}${paceText(await refreshPace($), isStrict, await $.clock.now())}` }
      }
      case 'reload': {
        // Every session reads the same files, so a reload is a fresh read of them.
        if (!(await syncFromDisk($, true))) return { text: "Couldn't read ~/.claude/fitness just now. Nothing changed; try again." }
        const t = await read($, today)
        if (t === null) return { text: 'Reloaded from disk.' }
        const shown = withStreak(t, await read($, history), await read($, olderStreak))
        return { text: `Reloaded from disk. ${shown}${paceText(await read($, pace), isStrict, await $.clock.now())}` }
      }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // Only prompts the person typed count: background tasks, loops and other
    // sessions start turns too. Slash commands (like /fit 10) always pass.
    const isTyped = e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/')
    if (!isTyped) return next(e)
    await startDay($)
    const p = await refreshPace($)
    const t = await read($, today)
    // Claude Code puts a dropped prompt back in the box itself; a fill here
    // as well left it there twice.
    if (isStrict && p !== null && p.behind > 0 && p.restUntil === null) {
      if (p.isOpening === true) {
        return {
          drop: `Start the day with a set: ${p.behind} ${t?.exercise ?? 'reps'}. /fit ${p.behind} to log it, then send your prompt. /fit rest skips the day (breaks streak).`,
        }
      }
      return {
        drop: `${p.behind} ${t?.exercise ?? 'reps'} due now (${p.required}/${t?.goal ?? 0} by now). /fit ${p.behind} to log it, then send your prompt. /fit snooze 30 puts it off; /fit easy stops holding prompts.`,
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    timer?.cancel()
    if (!isStrict && options.nudges !== false) timer = $.clock.after(nudgeMs, () => void nudge($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      timer?.cancel()
      timer = undefined
      await update($, isWaiting, () => false)
      await refreshToday($)
      await refreshPace($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const t = await read($, today)
    if (options.spinner === false || t === null || !(await read($, isWaiting))) return next(e)
    return next({ ...e, props: { ...e.props, message: `${nudgeReps} ${t.exercise} while Claude works` } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, today)
    if (options.band === false || e.props.hasSurvey || t === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    // Lay the band out in rows that fit, widest first: one line, then the
    // header over the buttons, then every piece on its own line.
    const cols = e.props.bodyColumns
    const WORDMARK = MINI_BARBELL.small + MINI_BARBELL.plate + MINI_BARBELL.name + MINI_BARBELL.plateRight + MINI_BARBELL.small
    const TAGLINE = 'Your agent put in the reps. You next.'
    const BUTTONS_WIDTH = buttonsWidth(['Pick your training', 'Help', 'Just train'])
    const HEADER_WIDTH = cells(WORDMARK) + 2 + cells(TAGLINE)

    if (!(await read($, isIntroduced))) {
      const buttons = (
        <Box key="buttons" flexDirection={cols >= BUTTONS_WIDTH ? 'row' : 'column'}>
          <Button key="setup" label="Pick your training" variant="primary" onPress={() => openOnboarding($)} />
          {cols >= BUTTONS_WIDTH && <Text> </Text>}
          <Button key="help" label="Help" onPress={() => $.ui.open({ id: HELP_PANE, title: 'HELP' })} />
          {cols >= BUTTONS_WIDTH && <Text> </Text>}
          <Button key="dismiss" label="Just train" onPress={() => markIntroduced($)} />
        </Box>
      )
      const header = (
        <Box key="header" flexDirection={cols >= HEADER_WIDTH ? 'row' : 'column'}>
          {cols >= cells(WORDMARK) ? (
            <Box>
              <Text dimColor>{MINI_BARBELL.small}</Text>
              <Text color="#d7af5f">{MINI_BARBELL.plate}</Text>
              <Text bold>{MINI_BARBELL.name}</Text>
              <Text color="#d7af5f">{MINI_BARBELL.plateRight}</Text>
              <Text dimColor>{MINI_BARBELL.small}</Text>
              {cols >= HEADER_WIDTH && <Text>  </Text>}
            </Box>
          ) : (
            <Text bold wrap="truncate-end">
              {MINI_BARBELL.name}
            </Text>
          )}
          <Text dimColor wrap="truncate-end">{TAGLINE}</Text>
        </Box>
      )
      const isOneLine = cols >= HEADER_WIDTH + 1 + BUTTONS_WIDTH
      return (
        <Box key="band" flexDirection={isOneLine ? 'row' : 'column'}>
          {header}
          {isOneLine && <Text> </Text>}
          {buttons}
        </Box>
      )
    }

    // A rest day is deliberate, not a miss: no rep buttons, just a way back.
    if (t.isRest) {
      const REST = `😴 Rest day · ${t.exercise} back tomorrow`
      const TRAIN = 'Train today'
      return (
        <Box key="rest" flexDirection={cols >= cells(REST) + 2 + buttonsWidth([TRAIN]) ? 'row' : 'column'}>
          <Text dimColor wrap="truncate-end">
            {REST}
            {'  '}
          </Text>
          <Button key="train" label={TRAIN} onPress={() => endRest($)} />
        </Box>
      )
    }

    const days = await read($, history)
    const color = progressColor(t.count, t.goal)
    const add = (n: number) => () => void logReps($, count => count + n)
    const progress = `${line(t)}${paceText(await read($, pace), isStrict, await $.clock.now())}`
    const run = fullStreak(days, await read($, olderStreak))
    const streakText = run > 0 ? `  🔥${run}d` : ''
    const LOG_LABEL = 'log reps: '
    // Buttons sized to today's set: a 300 goal's 30-rep sets get +10 +20 +30.
    const steps = repSteps(setSizeFor(t.goal, paceConfig.setSize))
    const logWidth = cells(LOG_LABEL) + buttonsWidth(steps.map(n => `+${n}`)) + cells(streakText)

    return (
      <Box key="tracker" flexDirection={cols >= cells(progress) + 2 + logWidth ? 'row' : 'column'}>
        <Text color={color} dimColor={color === undefined} wrap="truncate-end">
          {progress}
          {'  '}
        </Text>
        <Box>
          <Text dimColor>{LOG_LABEL}</Text>
          {steps.map((n, i) => (
            <Box key={`step${i}`}>
              {i > 0 && <Text> </Text>}
              <Button key={`add${n}`} label={`+${n}`} onPress={add(n)} />
            </Box>
          ))}
          {streakText !== '' && <Text>{streakText}</Text>}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const days = await read($, history)
    const run = fullStreak(days, await read($, olderStreak))
    const heat = heatCells(days)
    const week = days.slice(-7)

    const { Box, Text } = $.ui.resolve(e)
    // The bar needs a monospace grid of BARBELL.width cells: the terminal's.
    // Elsewhere, or too narrow, the name alone.
    const barbell =
      e.surface === 'terminal' && e.props.bodyColumns >= BARBELL.width ? (
        <Box flexDirection="column">
          <Text>{BARBELL.plates}</Text>
          <Box>
            <Text>{BARBELL.left}</Text>
            <Text bold>{BARBELL.name}</Text>
            <Text>{BARBELL.right}</Text>
          </Box>
          <Text>{BARBELL.plates}</Text>
          <Text> </Text>
        </Box>
      ) : (
        <Text bold>{BARBELL.name}</Text>
      )

    // One row a day: date, its progress bar in the band's colors, then the count.
    // Counts padded to one width so the exercise names line up.
    const counts = week.map(day => (day.isSkipped ? 'rest' : `${day.count}/${day.goal}`))
    const countWidth = Math.max(0, ...counts.map(count => count.length))
    const filled = (day: Day) => (day.goal > 0 ? Math.min(10, Math.floor((day.count / day.goal) * 10)) : 0)
    const summary = week.map((day, i) => {
      const mark = day.isSkipped ? '–' : day.goal > 0 && day.count >= day.goal ? '✓' : '·'
      const isToday = i === week.length - 1
      const color = day.isSkipped ? undefined : progressColor(day.count, day.goal)
      return (
        <Box key={`day-${day.date}`}>
          <Text dimColor={!isToday} bold={isToday}>{`${mark} ${day.date.slice(5)}  `}</Text>
          {/* Thin lines, not shaded blocks: blocks on stacked rows merge into slabs. */}
          <Text color={color ?? GRID_COLORS.none}>{'━'.repeat(day.isSkipped ? 0 : filled(day))}</Text>
          <Text dimColor>{(day.isSkipped ? '╌' : '─').repeat(10 - (day.isSkipped ? 0 : filled(day)))}</Text>
          <Text dimColor={!isToday} bold={isToday}>
            {`  ${(counts[i] ?? '').padEnd(countWidth)}  ${day.exercise}${isToday ? '  ◀ today' : ''}`}
          </Text>
        </Box>
      )
    })

    if (e.surface === 'terminal') {
      const { Button, Raster } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {barbell}
          <Text bold>🔥 {run}-day streak</Text>
          <Text> </Text>
          {summary}
          <Text> </Text>
          <Text dimColor>last {HISTORY_DAYS / 7} weeks, a square a day</Text>
          <Raster key="heat" {...heat} />
          <Box>
            <Text color={GRID_COLORS.goal}>█ </Text>
            <Text dimColor>goal  </Text>
            <Text color={GRID_COLORS.some}>█ </Text>
            <Text dimColor>some reps  </Text>
            <Text color={GRID_COLORS.none}>█ </Text>
            <Text dimColor>none  ▒ today</Text>
          </Box>
          <Text> </Text>
          <Text dimColor>Esc or /fit streak to close</Text>
          <Button key="close" label="Close" onPress={() => closePane($, PANE)} />
        </Box>
      )
    }

    const { Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {barbell}
        <Text bold>🔥 {run}-day streak</Text>
        {summary}
        <Button key="close" label="Close" onPress={() => closePane($, PANE)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HELP_PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Markdown text={HELP} />
        <Text> </Text>
        <Box>
          <Button key="setup" label="Pick your training" variant="primary" onPress={() => openOnboarding($)} />
          <Text> </Text>
          <Button key="close" label="Close" onPress={() => closePane($, HELP_PANE)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: ONBOARD_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const step = await read($, onboardStep)
    const p = await read($, onboardPick)
    const go = (to: number) => async () => {
      // Custom goals must all be numbers before leaving the program step.
      if (step === 1 && to > step && p.program === CUSTOM && pickedRoutine(p) === undefined) {
        await update($, onboardPick, now => ({ ...now, isCustomInvalid: true }))
        return
      }
      await update($, onboardStep, () => to)
    }
    const choose = (patch: Partial<OnboardPick>) => () => void update($, onboardPick, now => ({ ...now, ...patch }))
    const dots = [0, 1, 2].map(i => (i === step ? '●' : '○')).join(' ')

    const header = (title: string) => (
      <Box flexDirection="column">
        <Text dimColor>
          Step {step + 1} of 3 {dots}
        </Text>
        <Text bold>{title}</Text>
        <Text> </Text>
      </Box>
    )

    const nav = (
      <Box>
        {step > 0 && <Button key="back" label="Back" onPress={go(step - 1)} />}
        {step > 0 && <Text> </Text>}
        {step < 2 ? (
          <Button key="next" label="Next" variant="primary" onPress={go(step + 1)} />
        ) : (
          <Button key="finish" label="Let's go" variant="primary" onPress={() => finishOnboarding($)} />
        )}
      </Box>
    )

    if (step === 0) {
      return (
        <Box flexDirection="column">
          {header('Your agent works the code. You work the reps.')}
          <Text>Every day has a rep goal.</Text>
          <Text>When Claude runs a long turn, that's your cue for a set.</Text>
          <Text> </Text>
          <Text>Log reps two ways:</Text>
          <Text dimColor>  type /fit 20</Text>
          <Text dimColor>  or press a + button above your prompt</Text>
          <Text> </Text>
          {nav}
        </Box>
      )
    }

    if (step === 1) {
      // The mobile app draws no Input, so Custom needs another surface there.
      const elements = $.ui.resolve(e)
      const Input = e.surface !== 'mobile' && 'Input' in elements ? elements.Input : undefined
      const programs = [...(p.hasRoutine ? [KEEP] : []), ...Object.keys(ROUTINES), ...(Input === undefined ? [] : [CUSTOM])]
      const routine = pickedRoutine(p)
      const isCustom = p.program === CUSTOM
      const setGoal = (exercise: string) => (value: string) =>
        void update($, onboardPick, now => ({ ...now, custom: { ...now.custom, [exercise]: value }, isCustomInvalid: false }))
      const fields = Input !== undefined && isCustom && (
        <Box flexDirection="column">
          <Text> </Text>
          <Text dimColor>Daily goal per exercise</Text>
          {Object.entries(exerciseGoals(p.base)).map(([exercise, goal]) => (
            <Input
              key={`goal-${exercise}`}
              label={`${exercise} `}
              placeholder={String(goal)}
              value={p.custom[exercise] ?? ''}
              submitLabel="set"
              onInput={setGoal(exercise)}
              onSubmit={setGoal(exercise)}
            />
          ))}
          {p.isCustomInvalid && <Text color="#d75f5f">Every goal needs a whole number above 0.</Text>}
        </Box>
      )
      return (
        <Box flexDirection="column">
          {header('Pick your program')}
          {programs.map((name, i) => (
            <Button
              key={`program-${i}`}
              label={`${name === p.program ? '●' : '○'} ${name}`}
              plain
              onPress={choose({ program: name })}
            />
          ))}
          {fields}
          {routine !== undefined && !isCustom && (
            <Box flexDirection="column">
              <Text> </Text>
              <Text dimColor>Goal size</Text>
              <Box>
                {Object.keys(SIZES).map(size => (
                  <Box>
                    <Button
                      key={`size-${size}`}
                      label={`${size === p.size ? '●' : '○'} ${size}`}
                      plain
                      onPress={choose({ size })}
                    />
                    <Text>  </Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
          <Text> </Text>
          <Text dimColor>
            {routine !== undefined
              ? describeRoutine(routine)
              : isCustom
                ? 'Your days stay as they are, at these goals.'
                : 'Your routine stays as it is.'}
          </Text>
          <Text> </Text>
          {nav}
        </Box>
      )
    }

    const routine = pickedRoutine(p)
    const exercise = routine?.mon?.exercise ?? (await read($, today))?.exercise ?? 'pushups'
    const sample = withStreak(
      { date: '', exercise, goal: 100, unit: '', count: 60, isRest: false },
      // three finished days and reps today: 🔥4d
      [
        ...Array.from({ length: 3 }, (_, i) => ({ date: `d${i}`, count: 100, goal: 100, exercise, isSkipped: false })),
        { date: 'today', count: 60, goal: 100, exercise, isSkipped: false },
      ],
    )
    const preview =
      e.surface === 'terminal' ? (
        (() => {
          const { Raster } = $.ui.resolve(e)
          return <Raster key="sample-grid" {...heatCells(SAMPLE_DAYS)} />
        })()
      ) : (
        <Text dimColor>■ ■ ■ ■ ■ □ ■</Text>
      )

    return (
      <Box flexDirection="column">
        {header('Keep the streak alive')}
        <Text>Train any reps and the streak grows.</Text>
        <Text>It sits at the end of your tracker:</Text>
        <Text color="#d7af5f">  {sample}</Text>
        <Text dimColor>A day with none, or a rest day, resets it to zero.</Text>
        <Text> </Text>
        <Text>See every day as a grid:</Text>
        <Text dimColor>  type /fit streak</Text>
        {preview}
        <Text> </Text>
        {nav}
      </Box>
    )
  })
}

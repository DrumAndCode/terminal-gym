import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Day, OnboardPick, Pace, Today } from '../types'
import {
  DEFAULT_ROUTINE,
  BARBELL,
  HELP,
  MINI_BARBELL,
  ROUTINES,
  SIZES,
  bar,
  clockTime,
  paceAt,
  setSizeFor,
  buttonsWidth,
  cells,
  dayKey,
  fullStreak,
  isDone,
  describeRoutine,
  heatCells,
  lastDays,
  parseFit,
  pickSwap,
  progressColor,
  scale,
  streak,
  weekdayKey,
} from './lib'
import type { Routine } from './lib'

type $ = EngineInterface

const PANE = 'gym-week'
const HELP_PANE = 'gym-help'
const ONBOARD_PANE = 'gym-onboard'
const HISTORY_DAYS = 28
const TOAST_MS = 10_000
const HOUR_MS = 60 * 60_000

// Toasts stay up long enough to read mid-set.
const toast = ($: $, text: string) => $.ui.toast(text, { timeoutMs: TOAST_MS })

// The pace settings, set from the options each time the module registers.
const paceConfig = { setSize: 0, windowMs: 8 * HOUR_MS }
let dueTimer: { cancel: () => void } | undefined

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
})

// Same files as the `fit` shell script, so both agree.
const files = async ($: $) => {
  const dir = `${(await $.env.get('HOME')) ?? ''}/.claude/fitness`
  return { routine: `${dir}/routine.json`, log: `${dir}/log` }
}

const loadRoutine = async ($: $, routinePath: string): Promise<Routine> => {
  if (!(await $.fs.exists(routinePath))) {
    await $.fs.write(routinePath, `${JSON.stringify(DEFAULT_ROUTINE, null, 2)}\n`)
    return DEFAULT_ROUTINE
  }
  return JSON.parse(await $.fs.read(routinePath)) as Routine
}

const readCount = async ($: $, path: string) => {
  if (!(await $.fs.exists(path))) return 0
  const n = parseInt(await $.fs.read(path), 10)
  return Number.isFinite(n) ? n : 0
}

// `/fit swap` leaves the day's plan beside its count as `<date>.swap`.
const readSwap = async ($: $, logDir: string, date: string): Promise<Routine[string] | undefined> => {
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
const readRest = async ($: $, path: string) =>
  (await $.fs.exists(path)) && (await $.fs.read(path)).trim() !== 'off'

const refreshToday = async ($: $): Promise<Today> => {
  const { routine, log: logDir } = await files($)
  const date = dayKey(await $.clock.now())
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

const readDay = async ($: $, routine: Routine, logDir: string, ms: number): Promise<Day> => {
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

// Finished days in a row just before the window, so a streak can outlast it.
// Cached per window: a full walk once, then one day's step as the window slides.
const olderRun = async ($: $, days: readonly Day[], routine: Routine, logDir: string) => {
  const first = days[0]
  if (first === undefined || !isDone(first)) {
    await $.store.delete('streakCache')
    return 0
  }
  const oldest = lastDays(await $.clock.now(), HISTORY_DAYS)[0] ?? 0
  const asOf = dayKey(oldest)
  const cache = (await $.store.get('streakCache')) as { asOf?: string; older?: number } | undefined
  let older: number
  if (cache?.asOf === asOf && typeof cache.older === 'number') {
    older = cache.older
  } else if (cache?.asOf === dayKey(oldest - DAY_MS) && typeof cache.older === 'number') {
    // The window moved on a day: the day that left it joins the older run.
    older = isDone(await readDay($, routine, logDir, oldest - DAY_MS)) ? cache.older + 1 : 0
  } else {
    older = 0
    for (let back = 1; back <= 366; back++) {
      if (!isDone(await readDay($, routine, logDir, oldest - back * DAY_MS))) break
      older++
    }
  }
  await $.store.set('streakCache', { asOf, older })
  return older
}

const refreshHistory = async ($: $) => {
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

// The day starts at the person's first prompt; sets are spread from there.
const dayStart = async ($: $, date: string) => {
  const stored = (await $.store.get('dayStart')) as { date?: string; at?: number } | undefined
  return stored?.date === date && typeof stored.at === 'number' ? stored.at : undefined
}

// Prompts before this hour belong to the night before: they never start the
// day, or a 00:30 prompt would leave every set overdue by morning.
const DAY_BEGINS_HOUR = 5

const startDay = async ($: $) => {
  const now = await $.clock.now()
  if (new Date(now).getHours() < DAY_BEGINS_HOUR) return
  const date = dayKey(now)
  if ((await dayStart($, date)) === undefined) await $.store.set('dayStart', { date, at: now })
}

// Recomputes the pace and arms a timer for the next set coming due.
const refreshPace = async ($: $): Promise<Pace | null> => {
  dueTimer?.cancel()
  dueTimer = undefined
  // Re-read today: the date may have rolled over, or the shell script logged reps.
  const t = await refreshToday($)
  const at = t === null ? undefined : await dayStart($, t.date)
  const now = await $.clock.now()
  const next: Pace | null =
    t === null || t.isRest || at === undefined
      ? null
      : paceAt(t.goal, t.count, setSizeFor(t.goal, paceConfig.setSize), at, now, paceConfig.windowMs)
  await update($, pace, () => next)
  if (next?.nextDueAt != null && t !== null && t.count < t.goal) {
    dueTimer = $.clock.after(Math.max(1, next.nextDueAt - now), () => void setDue($))
  }
  return next
}

const setDue = async ($: $) => {
  const p = await refreshPace($)
  const t = await read($, today)
  if (p === null || t === null || p.behind <= 0) return
  toast($, `⏱ Set due: ${p.behind} ${t.exercise}. ${p.required}/${t.goal} by now.`)
}

// A Close button's press: a refused close says why instead of doing nothing.
const closePane = async ($: $, id: string) => {
  try {
    await $.ui.close({ id })
  } catch (err) {
    toast($, `Couldn't close the panel (${err instanceof Error ? err.message : String(err)}). Try Esc or /fit hide.`)
  }
}

const paceText = (p: Pace | null, isStrict: boolean) => {
  if (p === null) return ''
  if (p.behind > 0) return `  behind ${p.behind}${isStrict ? ' · prompts wait' : ''}`
  return p.nextDueAt === null ? '' : `  next set ${clockTime(p.nextDueAt)}`
}

const line = (t: Today) => {
  const isDone = t.goal > 0 && t.count >= t.goal
  return `${isDone ? '✅' : '💪'} ${bar(t.count, t.goal)} ${t.count}/${t.goal}${t.unit} ${t.exercise}`
}

const withStreak = (t: Today, days: readonly Day[], older = 0) => {
  const run = fullStreak(days, older)
  return run > 0 ? `${line(t)}  🔥${run}d` : line(t)
}

const logReps = async ($: $, change: (count: number) => number) => {
  const before = await refreshToday($)
  const count = Math.max(0, change(before.count))
  await $.fs.write(`${(await files($)).log}/${before.date}`, `${count}\n`)

  const after = { ...before, count }
  await update($, today, () => after)
  await update($, history, days =>
    days.map(day => (day.date === after.date ? { ...day, count } : day)),
  )

  await refreshPace($)
  if (after.goal > 0 && before.count < after.goal && count >= after.goal) {
    toast($, `✅ Done. ${count}/${after.goal}${after.unit} ${after.exercise}. That's the work.`)
  }
  return after
}

// Easy mode: a suggestion once a turn runs long.
const nudge = async ($: $, reps: number) => {
  const t = await read($, today)
  if (t === null || t.isRest || (t.goal > 0 && t.count >= t.goal)) return
  await update($, isWaiting, () => true)
  toast($, `Your agent's mid-set. You next: ${reps} ${t.exercise}.`)
}

const endRest = async ($: $) => {
  const t = await refreshToday($)
  if (!t.isRest) return { text: `Today isn't a rest day. ${line(t)}` }
  await $.fs.write(`${(await files($)).log}/${t.date}.skip`, 'off\n')
  const back = await refreshToday($)
  await refreshHistory($)
  await refreshPace($)
  return { text: `Rest day undone. Back to work. ${line(back)}` }
}

const markIntroduced = async ($: $) => {
  await $.store.set('introduced', true)
  await update($, isIntroduced, () => true)
}

const KEEP = 'Keep my current routine'
const DEFAULT_PROGRAM = 'Push · dip · squat rotation'

const openOnboarding = async ($: $) => {
  // Open first: a pane counts as asked for only while the press or command that
  // asked is still being answered. Opened after other awaits, the engine treats
  // it as unasked and leaves it undrawn below 144 columns.
  await update($, onboardStep, () => 0)
  const opened = await $.ui.open({ id: ONBOARD_PANE, title: 'TERMINAL GYM', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) toast($, 'Widen the terminal to see the walkthrough, or type /fit program.')
  // A seeded default counts as no routine of their own; only custom ones get "keep".
  const { routine: routinePath } = await files($)
  const hasRoutine =
    (await $.fs.exists(routinePath)) &&
    JSON.stringify(await loadRoutine($, routinePath)) !== JSON.stringify(DEFAULT_ROUTINE)
  await update($, onboardPick, () => ({
    program: hasRoutine ? KEEP : DEFAULT_PROGRAM,
    size: 'Standard',
    hasRoutine,
  }))
}

const pickedRoutine = (p: OnboardPick): Routine | undefined => {
  const preset = ROUTINES[p.program as keyof typeof ROUTINES] as Routine | undefined
  return preset === undefined ? undefined : scale(preset, SIZES[p.size as keyof typeof SIZES] ?? 1)
}

const finishOnboarding = async ($: $) => {
  const p = await read($, onboardPick)
  const { routine: routinePath } = await files($)
  const routine = pickedRoutine(p)
  if (routine !== undefined) {
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
const boot = async ($: $) => {
  const introduced = (await $.store.get('introduced')) === true
  await update($, isIntroduced, () => introduced)
  await refreshToday($)
  await refreshHistory($)
  // Re-arms the due timer, which a restart or reload drops.
  await refreshPace($)
  // Last, so a refused registration can't leave the band without its state.
  await $.command.register({
    name: 'fit',
    description: "Log reps toward today's goal",
    argumentHint: '[n | set n | reset | swap [exercise] | rest [off] | score | program | rules | strict | easy | start | hide]',
    immediate: true,
  })
}

export const register: Register = (on, options) => {
  const isStrict = options.strict === true
  const nudgeMs = Number(options.nudgeSeconds ?? 30) * 1000
  const nudgeReps = Number(options.nudgeReps ?? 10)
  paceConfig.setSize = Number(options.setSize ?? 0)
  paceConfig.windowMs = Math.max(1, Number(options.windowHours ?? 8)) * HOUR_MS
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
        return { text: `${line(t)}${paceText(await read($, pace), isStrict)}` }
      }
      case 'skip': {
        const t = await refreshToday($)
        if (t.isRest) return { text: 'Already a rest day. /fit rest off to train.' }
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
        return { text: `🔥 ${fullStreak(days, await read($, olderStreak))}-day streak · Esc or /fit score to close` }
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
      case 'program':
        await openOnboarding($)
        return { text: 'Pick your program.' }
      case 'intro':
        await $.store.delete('introduced')
        await update($, isIntroduced, () => false)
        return { text: 'Welcome is back above your prompt.' }
      case 'reset':
        return { text: `Reset. ${line(await logReps($, () => 0))}${paceText(await read($, pace), isStrict)}` }
      case 'help':
        await markIntroduced($)
        await $.ui.open({ id: HELP_PANE, title: 'HOUSE RULES' })
        return { text: 'House rules opened · /fit hide to close' }
      case 'strict': {
        const { deny } = await $.config.set({ key: 'terminal-gym.strict', value: cmd.isOn })
        if (deny !== undefined) return { text: `Couldn't change strict mode: ${deny}` }
        return {
          text: cmd.isOn
            ? `Coach is strict. Today's goal is spread into sets over ${paceConfig.windowMs / HOUR_MS}h from your first prompt; fall behind and prompts wait until you catch up.`
            : 'Coach is easy. Same schedule on the band, nudges only, nothing held.',
        }
      }
      case 'hide':
        await $.ui.close({ id: PANE })
        await $.ui.close({ id: HELP_PANE })
        return { text: 'Terminal Gym panels closed.' }
      case 'status': {
        const t = await refreshToday($)
        const shown = withStreak(t, await refreshHistory($), await read($, olderStreak))
        return { text: `${shown}${paceText(await refreshPace($), isStrict)}` }
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
    if (isStrict && p !== null && p.behind > 0) {
      void $.prompt.fill({ text: e.text })
      return {
        drop: `Behind pace: ${p.behind} ${t?.exercise ?? 'reps'} to catch up (${p.required}/${t?.goal ?? 0} due by now). /fit ${p.behind} to log. /fit rest skips the day (breaks streak).`,
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    timer?.cancel()
    if (!isStrict && options.nudges !== false) timer = $.clock.after(nudgeMs, () => void nudge($, nudgeReps))
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
    const BUTTONS_WIDTH = buttonsWidth(['Pick your training', 'House rules', 'Just train'])
    const HEADER_WIDTH = cells(WORDMARK) + 2 + cells(TAGLINE)

    if (!(await read($, isIntroduced))) {
      const buttons = (
        <Box key="buttons" flexDirection={cols >= BUTTONS_WIDTH ? 'row' : 'column'}>
          <Button key="setup" label="Pick your training" variant="primary" onPress={() => openOnboarding($)} />
          {cols >= BUTTONS_WIDTH && <Text> </Text>}
          <Button key="help" label="House rules" onPress={() => $.ui.open({ id: HELP_PANE, title: 'HOUSE RULES' })} />
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
    const progress = `${line(t)}${paceText(await read($, pace), isStrict)}`
    const run = fullStreak(days, await read($, olderStreak))
    const streakText = run > 0 ? `  🔥${run}d` : ''
    const LOG_LABEL = 'log reps: '
    const logWidth = cells(LOG_LABEL) + buttonsWidth(['+5', '+10', '+25']) + cells(streakText)

    return (
      <Box key="tracker" flexDirection={cols >= cells(progress) + 2 + logWidth ? 'row' : 'column'}>
        <Text color={color} dimColor={color === undefined} wrap="truncate-end">
          {progress}
          {'  '}
        </Text>
        <Box>
          <Text dimColor>{LOG_LABEL}</Text>
          <Button key="add5" label="+5" onPress={add(5)} />
          <Text> </Text>
          <Button key="add10" label="+10" onPress={add(10)} />
          <Text> </Text>
          <Button key="add25" label="+25" onPress={add(25)} />
          {streakText !== '' && <Text>{streakText}</Text>}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const days = await read($, history)
    const t = await read($, today)
    const run = fullStreak(days, await read($, olderStreak))
    const heat = heatCells(days)
    const week = days.slice(-7)

    const { Box, Text } = $.ui.resolve(e)
    // The bar needs a monospace grid of BARBELL.width cells: the terminal's.
    // Elsewhere, or too narrow, the name alone.
    const barbell =
      e.surface === 'terminal' && e.props.bodyColumns >= BARBELL.width ? (
        <Box flexDirection="column">
          <Text color="#d7af5f">{BARBELL.plates}</Text>
          <Box>
            <Text color="#d7af5f">{BARBELL.left}</Text>
            <Text bold>{BARBELL.name}</Text>
            <Text color="#d7af5f">{BARBELL.right}</Text>
          </Box>
          <Text color="#d7af5f">{BARBELL.plates}</Text>
          <Text> </Text>
        </Box>
      ) : (
        <Text bold>{BARBELL.name}</Text>
      )

    // Counts padded to one width so the exercise names line up.
    const counts = week.map(day => `${day.count}/${day.goal}`)
    const countWidth = Math.max(0, ...counts.map(count => count.length))
    const summary = week.map((day, i) => {
      const mark = day.isSkipped ? '–' : day.goal > 0 && day.count >= day.goal ? '✓' : '·'
      const isToday = i === week.length - 1
      return `${mark} ${day.date.slice(5)}  ${(counts[i] ?? '').padEnd(countWidth)}  ${day.exercise}${isToday ? '  ◀ today' : ''}`
    })

    if (e.surface === 'terminal') {
      const { Button, Raster } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {barbell}
          <Text bold>🔥 {run}-day streak</Text>
          {t !== null && <Text dimColor>{line(t)}</Text>}
          <Text> </Text>
          <Text dimColor>last {HISTORY_DAYS} days · ▒ today</Text>
          <Raster key="heat" {...heat} />
          <Text> </Text>
          {summary.map((row, i) => (
            <Text dimColor={i !== summary.length - 1} bold={i === summary.length - 1}>
              {row}
            </Text>
          ))}
          <Text> </Text>
          <Text dimColor>Esc or /fit score to close</Text>
          <Button key="close" label="Close" onPress={() => closePane($, PANE)} />
        </Box>
      )
    }

    const { Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {barbell}
        <Text bold>🔥 {run}-day streak</Text>
        {t !== null && <Text dimColor>{line(t)}</Text>}
        {summary.map(row => <Text dimColor>{row}</Text>)}
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
    const go = (to: number) => () => void update($, onboardStep, () => to)
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
          <Text dimColor>  or press +5 +10 +25 above your prompt</Text>
          <Text> </Text>
          {nav}
        </Box>
      )
    }

    if (step === 1) {
      const programs = [...(p.hasRoutine ? [KEEP] : []), ...Object.keys(ROUTINES)]
      const routine = pickedRoutine(p)
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
          {routine !== undefined && (
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
          <Text dimColor>{routine === undefined ? 'Your routine stays as it is.' : describeRoutine(routine)}</Text>
          <Text> </Text>
          {nav}
        </Box>
      )
    }

    const routine = pickedRoutine(p)
    const exercise = routine?.mon?.exercise ?? (await read($, today))?.exercise ?? 'pushups'
    const sample = withStreak(
      { date: '', exercise, goal: 100, unit: '', count: 60, isRest: false },
      // three finished days, today still in progress: 🔥3d
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
        <Text>Hit your goal and the streak grows.</Text>
        <Text>It sits at the end of your tracker:</Text>
        <Text color="#d7af5f">  {sample}</Text>
        <Text dimColor>Miss a day and it resets to zero.</Text>
        <Text> </Text>
        <Text>See every day as a grid:</Text>
        <Text dimColor>  type /fit score</Text>
        {preview}
        <Text> </Text>
        {nav}
      </Box>
    )
  })
}

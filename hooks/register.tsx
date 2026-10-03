import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Day, OnboardPick, Today } from '../types'
import {
  DEFAULT_ROUTINE,
  BARBELL,
  HELP,
  MINI_BARBELL,
  ROUTINES,
  SIZES,
  bar,
  buttonsWidth,
  cells,
  dayKey,
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
const GRACE_MS = 2 * 60_000
const TOAST_MS = 10_000

// Toasts stay up long enough to read mid-set.
const toast = ($: $, text: string) => $.ui.toast(text, { timeoutMs: TOAST_MS })

let breakTimer: { cancel: () => void } | undefined

const today = atom({ plugin: 'terminal-gym', key: 'today' } as const, null)
const debt = atom({ plugin: 'terminal-gym', key: 'debt' } as const, 0)
const isUnlocked = atom({ plugin: 'terminal-gym', key: 'isUnlocked' } as const, false)
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
  return days
}

const setDebt = async ($: $, n: number) => {
  await $.store.set('debt', n)
  // A pass only covers debt that's still owed; never carry one into the next debt.
  if (n === 0) await $.store.set('hasPass', false)
  await update($, debt, () => n)
  await syncUnlocked($)
}

// Whether paid reps currently let prompts through: an unused pass, or inside the break.
const syncUnlocked = async ($: $) => {
  const owed = await read($, debt)
  const paidAt = Number((await $.store.get('paidAt')) ?? 0)
  const hasPass = (await $.store.get('hasPass')) === true
  const isOpen = owed > 0 && (hasPass || (await $.clock.now()) - paidAt < GRACE_MS)
  await update($, isUnlocked, () => isOpen)
  return isOpen
}

const line = (t: Today) => {
  const isDone = t.goal > 0 && t.count >= t.goal
  return `${isDone ? '✅' : '💪'} ${bar(t.count, t.goal)} ${t.count}/${t.goal}${t.unit} ${t.exercise}`
}

// What a payment bought, for the /fit reply.
const paidNote = (owedBefore: number, owedAfter: number) => {
  if (owedAfter >= owedBefore) return ''
  if (owedAfter === 0) return ' · debt paid'
  return ` · debt ${owedAfter} left · next prompt + 2 min unlocked`
}

const withStreak = (t: Today, days: readonly Day[]) => {
  const run = streak(days)
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

  const added = count - before.count
  const owed = await read($, debt)
  if (added > 0) {
    breakTimer?.cancel()
    breakTimer = $.clock.after(GRACE_MS, () => void breakOver($))
  }
  if (added > 0 && owed > 0) {
    const left = Math.max(0, owed - added)
    await setDebt($, left)
    await $.store.set('paidAt', await $.clock.now())
    if (left > 0) await $.store.set('hasPass', true)
    await syncUnlocked($)
  }
  if (after.goal > 0 && before.count < after.goal && count >= after.goal) {
    toast($, `✅ Done. ${count}/${after.goal}${after.unit} ${after.exercise}. That's the work.`)
  }
  return after
}

// Fires two minutes after the last logged set.
const breakOver = async ($: $) => {
  breakTimer = undefined
  await syncUnlocked($)
  const t = await read($, today)
  if (t?.isRest === true) return
  const owed = await read($, debt)
  if (owed > 0) {
    toast($, `⏱ Break's over. Debt ${owed} ${t?.exercise ?? 'reps'} left; prompts wait for your next set.`)
  } else if (t !== null && t.goal > 0 && t.count < t.goal) {
    toast($, `⏱ Break's over. Next set? ${t.count}/${t.goal}${t.unit} ${t.exercise}.`)
  }
}

const nudge = async ($: $, reps: number, isStrict: boolean) => {
  const t = await read($, today)
  if (t === null || t.isRest || (t.goal > 0 && t.count >= t.goal)) return
  await update($, isWaiting, () => true)
  if (isStrict) {
    const owed = (await read($, debt)) + reps
    await setDebt($, owed)
    toast($, `Your agent's mid-set. +${reps} ${t.exercise} added · debt ${owed} left.`)
  } else {
    toast($, `Your agent's mid-set. You next: ${reps} ${t.exercise}.`)
  }
}

const endRest = async ($: $) => {
  const t = await refreshToday($)
  if (!t.isRest) return { text: `Today isn't a rest day. ${line(t)}` }
  await $.fs.write(`${(await files($)).log}/${t.date}.skip`, 'off\n')
  const back = await refreshToday($)
  await refreshHistory($)
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
const boot = async ($: $, isStrict: boolean) => {
  await $.command.register({
    name: 'fit',
    description: "Log reps toward today's goal",
    argumentHint: '[n | set n | reset | swap [exercise] | rest [off] | score | program | rules | strict | easy | start | hide]',
    immediate: true,
  })
  const stored = Number((await $.store.get('debt')) ?? 0)
  await update($, debt, () => (isStrict ? stored : 0))
  await syncUnlocked($)
  // A restart mid-break loses the timer: start one for whatever's left of it.
  const breakLeft = Number((await $.store.get('paidAt')) ?? 0) + GRACE_MS - (await $.clock.now())
  if (breakLeft > 0) {
    breakTimer?.cancel()
    breakTimer = $.clock.after(breakLeft, () => void breakOver($))
  }
  const introduced = (await $.store.get('introduced')) === true
  await update($, isIntroduced, () => introduced)
  await refreshToday($)
  await refreshHistory($)
}

export const register: Register = (on, options) => {
  const isStrict = options.strict === true
  const nudgeMs = Number(options.nudgeSeconds ?? 30) * 1000
  const nudgeReps = Number(options.nudgeReps ?? 10)
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await boot($, isStrict)
    return next(e)
  })

  // /clear starts a new conversation in the same process without another
  // session.start, so the setup above runs again here.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await boot($, isStrict)
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
        const owedBefore = await read($, debt)
        const n = cmd.n
        const t = await logReps($, count => (cmd.kind === 'add' ? count + n : n))
        return { text: `${line(t)}${paidNote(owedBefore, await read($, debt))}` }
      }
      case 'skip': {
        const t = await refreshToday($)
        if (t.isRest) return { text: 'Already a rest day. /fit rest off to train.' }
        await $.fs.write(`${(await files($)).log}/${t.date}.skip`, '')
        await setDebt($, 0)
        breakTimer?.cancel()
        breakTimer = undefined
        await refreshToday($)
        await refreshHistory($)
        return { text: `Rest day logged. Streak resets, debt cleared. Back at it tomorrow. (/fit rest off to undo)` }
      }
      case 'unskip':
        return endRest($)
      case 'week': {
        if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
          await $.ui.close({ id: PANE })
          return { text: 'Scoreboard closed.' }
        }
        const days = await refreshHistory($)
        await $.ui.open({ id: PANE, title: 'TERMINAL GYM' })
        return { text: `🔥 ${streak(days)}-day streak · /fit score again to close` }
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
        return { text: `Swapped to ${plan.exercise} today.${carried} ${line(await refreshToday($))}` }
      }
      case 'program':
        await openOnboarding($)
        return { text: 'Pick your program.' }
      case 'intro':
        await $.store.delete('introduced')
        await update($, isIntroduced, () => false)
        return { text: 'Welcome is back above your prompt.' }
      case 'reset':
        return { text: `Reset. ${line(await logReps($, () => 0))}` }
      case 'help':
        await markIntroduced($)
        await $.ui.open({ id: HELP_PANE, title: 'HOUSE RULES' })
        return { text: 'House rules opened · /fit hide to close' }
      case 'strict': {
        const { deny } = await $.config.set({ key: 'terminal-gym.strict', value: cmd.isOn })
        if (deny !== undefined) return { text: `Couldn't change strict mode: ${deny}` }
        return {
          text: cmd.isOn
            ? 'Coach is strict. Long turns now cost reps, and prompts wait until you pay.'
            : 'Coach is easy. Nudges only.',
        }
      }
      case 'hide':
        await $.ui.close({ id: PANE })
        await $.ui.close({ id: HELP_PANE })
        return { text: 'Terminal Gym panels closed.' }
      case 'status': {
        const t = await refreshToday($)
        const owed = await read($, debt)
        const shown = withStreak(t, await refreshHistory($))
        return { text: owed > 0 ? `${shown} · debt ${owed} left` : shown }
      }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const isGated = isStrict && e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/')
    const owed = isGated ? await read($, debt) : 0
    const t = await read($, today)
    // Rest days owe nothing; clear anything left from earlier in the day.
    if (owed > 0 && t?.isRest === true) {
      await setDebt($, 0)
      return next(e)
    }
    if (owed > 0) {
      // Any paid reps unlock the next prompt, plus every prompt for two minutes after.
      if (!(await syncUnlocked($))) {
        void $.prompt.fill({ text: e.text })
        return {
          drop: `Pay up first: ${owed} ${t?.exercise ?? 'reps'}. Log any reps (/fit 5) to unlock your next prompt + 2 min. /fit rest skips the day (breaks streak).`,
        }
      }
      await $.store.set('hasPass', false)
      await syncUnlocked($)
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    timer?.cancel()
    if (options.nudges === false) return next(e)
    timer = $.clock.after(nudgeMs, () => void nudge($, nudgeReps, isStrict))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      timer?.cancel()
      timer = undefined
      await update($, isWaiting, () => false)
      await refreshToday($)
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

    const owed = await read($, debt)
    const days = await read($, history)
    const color = progressColor(t.count, t.goal)
    const add = (n: number) => () => void logReps($, count => count + n)
    const debtText = owed > 0 ? `  debt ${owed} left · ${(await read($, isUnlocked)) ? 'prompts open' : 'pay to unlock'}` : ''
    const progress = `${line(t)}${debtText}`
    const run = streak(days)
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
    const run = streak(days)
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
      return `${mark} ${day.date.slice(5)}  ${(counts[i] ?? '').padEnd(countWidth)}  ${day.exercise}`
    })

    if (e.surface === 'terminal') {
      const { Button, Raster } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {barbell}
          <Text bold>🔥 {run}-day streak</Text>
          {t !== null && <Text dimColor>{line(t)}</Text>}
          <Text> </Text>
          <Text dimColor>last {HISTORY_DAYS} days</Text>
          <Raster key="heat" {...heat} />
          <Text> </Text>
          {summary.map(row => <Text dimColor>{row}</Text>)}
          <Text> </Text>
          <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
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
        <Button key="close" label="Close" onPress={() => $.ui.close({ id: PANE })} />
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
          <Button key="close" label="Close" onPress={() => $.ui.close({ id: HELP_PANE })} />
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

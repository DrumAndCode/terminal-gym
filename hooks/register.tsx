import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Day, OnboardPick, Today } from '../types'
import {
  DEFAULT_ROUTINE,
  HELP,
  ROUTINES,
  SIZES,
  bar,
  dayKey,
  describeRoutine,
  heatCells,
  lastDays,
  parseFit,
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

const today = atom({ plugin: 'terminal-gym', key: 'today' } as const, null)
const debt = atom({ plugin: 'terminal-gym', key: 'debt' } as const, 0)
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

const refreshToday = async ($: $): Promise<Today> => {
  const { routine, log: logDir } = await files($)
  const plan = (await loadRoutine($, routine))[weekdayKey(await $.clock.now())]
  const date = dayKey(await $.clock.now())
  const next: Today = {
    date,
    exercise: plan?.exercise ?? 'reps',
    goal: plan?.goal ?? 0,
    unit: plan?.unit ?? '',
    count: await readCount($, `${logDir}/${date}`),
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
      return {
        date,
        count: await readCount($, `${logDir}/${date}`),
        goal: routine[weekdayKey(ms)]?.goal ?? 0,
        isSkipped: await $.fs.exists(`${logDir}/${date}.skip`),
      }
    }),
  )
  await update($, history, () => days)
  return days
}

const setDebt = async ($: $, n: number) => {
  await $.store.set('debt', n)
  await update($, debt, () => n)
}

const line = (t: Today) => {
  const isDone = t.goal > 0 && t.count >= t.goal
  return `${isDone ? '✅' : '💪'} ${bar(t.count, t.goal)} ${t.count}/${t.goal}${t.unit} ${t.exercise}`
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
  if (added > 0) await setDebt($, Math.max(0, (await read($, debt)) - added))
  if (after.goal > 0 && before.count < after.goal && count >= after.goal) {
    $.ui.toast(`✅ ${after.exercise} done for today: ${count}/${after.goal}${after.unit}`)
  }
  return after
}

const nudge = async ($: $, reps: number, isStrict: boolean) => {
  const t = await read($, today)
  if (t === null || (t.goal > 0 && t.count >= t.goal)) return
  await update($, isWaiting, () => true)
  if (isStrict) {
    const owed = (await read($, debt)) + reps
    await setDebt($, owed)
    $.ui.toast(`Claude's under the bar. Your set: ${reps} ${t.exercise}. You owe ${owed}.`)
  } else {
    $.ui.toast(`Claude's under the bar. Your set: ${reps} ${t.exercise}.`)
  }
}

const markIntroduced = async ($: $) => {
  await $.store.set('introduced', true)
  await update($, isIntroduced, () => true)
}

const KEEP = 'Keep my current routine'
const DEFAULT_PROGRAM = 'Push · dip · squat rotation'

const openOnboarding = async ($: $) => {
  // A seeded default counts as no routine of their own; only custom ones get "keep".
  const { routine: routinePath } = await files($)
  const hasRoutine =
    (await $.fs.exists(routinePath)) &&
    JSON.stringify(await loadRoutine($, routinePath)) !== JSON.stringify(DEFAULT_ROUTINE)
  await update($, onboardStep, () => 0)
  await update($, onboardPick, () => ({
    program: hasRoutine ? KEEP : DEFAULT_PROGRAM,
    size: 'Standard',
    hasRoutine,
  }))
  await $.ui.open({ id: ONBOARD_PANE, title: 'Claude Gym', focus: true, closeOnEscape: true })
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
  $.ui.toast(`Training set: ${describeRoutine(plan)}. Go lift.`, { timeoutMs: 6000 })
}

// A made-up fortnight for the walkthrough's example grid.
const SAMPLE_DAYS: Day[] = [1, 1, 0.4, 1, 1, 0, 1, 1, 1, 0.6, 1, 1, 1, 0.3].map((share, i) => ({
  date: `sample-${i}`,
  count: Math.round(share * 100),
  goal: 100,
  isSkipped: false,
}))

export const register: Register = (on, options) => {
  const isStrict = options.strict === true
  const nudgeMs = Number(options.nudgeSeconds ?? 45) * 1000
  const nudgeReps = Number(options.nudgeReps ?? 10)
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fit',
      description: "Log reps toward today's goal",
      argumentHint: '[n | set n | reset | rest | score | program | rules | coach strict|easy | tour | hide]',
      immediate: true,
    })
    const stored = Number((await $.store.get('debt')) ?? 0)
    await update($, debt, () => (isStrict ? stored : 0))
    const introduced = (await $.store.get('introduced')) === true
    await update($, isIntroduced, () => introduced)
    await refreshToday($)
    await refreshHistory($)
    return next(e)
  })

  on('command.run', { command: 'fit' }, async ($, e) => {
    const cmd = parseFit(e.args)
    switch (cmd.kind) {
      case 'error':
        return { text: cmd.text }
      case 'add':
        return { text: line(await logReps($, count => count + cmd.n)) }
      case 'set':
        return { text: line(await logReps($, () => cmd.n)) }
      case 'skip': {
        const t = await refreshToday($)
        await $.fs.write(`${(await files($)).log}/${t.date}.skip`, '')
        await setDebt($, 0)
        await refreshHistory($)
        return { text: `Rest day. No ${t.exercise} today; streak resets, debt cleared.` }
      }
      case 'week': {
        if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
          await $.ui.close({ id: PANE })
          return { text: 'Scoreboard closed.' }
        }
        const days = await refreshHistory($)
        await $.ui.open({ id: PANE, title: 'Claude Gym' })
        return { text: `🔥 ${streak(days)}-day streak · /fit score again to close` }
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
        await $.ui.open({ id: HELP_PANE, title: 'House rules' })
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
        return { text: 'Claude Gym panels closed.' }
      case 'status': {
        const t = await refreshToday($)
        const owed = await read($, debt)
        const shown = withStreak(t, await refreshHistory($))
        return { text: owed > 0 ? `${shown} · owe ${owed}` : shown }
      }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const isGated = isStrict && e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/')
    const owed = isGated ? await read($, debt) : 0
    if (owed > 0) {
      const t = await read($, today)
      void $.prompt.fill({ text: e.text })
      return {
        drop: `Pay up first: ${owed} ${t?.exercise ?? 'reps'}. /fit ${owed} to log, /fit rest to bail (breaks streak).`,
      }
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

    if (!(await read($, isIntroduced))) {
      return (
        <Box>
          <Text bold>CLAUDE GYM </Text>
          <Text dimColor>New face. Claude's under the bar, you're up next. </Text>
          <Button key="setup" label="Pick your training" variant="primary" onPress={() => void openOnboarding($)} />
          <Text> </Text>
          <Button key="help" label="House rules" onPress={() => void $.ui.open({ id: HELP_PANE, title: 'House rules' })} />
          <Text> </Text>
          <Button key="dismiss" label="Just lift" onPress={() => void markIntroduced($)} />
        </Box>
      )
    }

    const owed = await read($, debt)
    const days = await read($, history)
    const color = progressColor(t.count, t.goal)
    const add = (n: number) => () => void logReps($, count => count + n)

    return (
      <Box>
        <Text color={color} dimColor={color === undefined}>{withStreak(t, days)} </Text>
        {owed > 0 && <Text bold>owe {owed} </Text>}
        <Text dimColor>log </Text>
        <Button key="add5" label="+5" onPress={add(5)} />
        <Text> </Text>
        <Button key="add10" label="+10" onPress={add(10)} />
        <Text> </Text>
        <Button key="add25" label="+25" onPress={add(25)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const days = await read($, history)
    const t = await read($, today)
    const run = streak(days)
    const heat = heatCells(days)
    const week = days.slice(-7)

    const summary = week.map(day => {
      const mark = day.isSkipped ? '–' : day.goal > 0 && day.count >= day.goal ? '✓' : '·'
      return `${mark} ${day.date.slice(5)}  ${day.count}/${day.goal}`
    })

    if (e.surface === 'terminal') {
      const { Box, Button, Text, Raster } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text bold>🔥 {run}-day streak</Text>
          {t !== null && <Text dimColor>{line(t)}</Text>}
          <Text> </Text>
          <Text dimColor>last {HISTORY_DAYS} days</Text>
          <Raster key="heat" {...heat} />
          <Text> </Text>
          {summary.map(row => <Text dimColor>{row}</Text>)}
          <Text> </Text>
          <Button key="close" label="Close" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text bold>🔥 {run}-day streak</Text>
        {t !== null && <Text dimColor>{line(t)}</Text>}
        {summary.map(row => <Text dimColor>{row}</Text>)}
        <Button key="close" label="Close" onPress={() => void $.ui.close({ id: PANE })} />
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
          <Button key="setup" label="Pick your training" variant="primary" onPress={() => void openOnboarding($)} />
          <Text> </Text>
          <Button key="close" label="Close" onPress={() => void $.ui.close({ id: HELP_PANE })} />
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
          <Button key="finish" label="Start lifting" variant="primary" onPress={() => void finishOnboarding($)} />
        )}
      </Box>
    )

    if (step === 0) {
      return (
        <Box flexDirection="column">
          {header('Claude lifts the code. You lift the weight.')}
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
      { date: '', exercise, goal: 100, unit: '', count: 60 },
      // three finished days, today still in progress: 🔥3d
      [
        ...Array.from({ length: 3 }, (_, i) => ({ date: `d${i}`, count: 100, goal: 100, isSkipped: false })),
        { date: 'today', count: 60, goal: 100, isSkipped: false },
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

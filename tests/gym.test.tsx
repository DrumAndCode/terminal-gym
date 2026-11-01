import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { amount, axisText, barCells, barSvg, bestStreak, bucketDays, bucketLabel, changeText, chartBars, chartWidth, commas, exerciseColors, exerciseTotals, faded, nextMilestone, rangeSummary, yearCells } from '../hooks/stats'
import { buttonsWidth, canProgress, cells, cheer, customRoutine, heatCells, moveGoal, nextGoal, paceAt, parseCustom, parseFit, pickSwap, progressColor, repSteps, scale, setSizeFor, stepFor, streak, untilText } from '../hooks/lib'

// The test runner has it; the engine's types leave it out.
declare const setTimeout: (run: () => void, ms: number) => unknown

const HOME = '/home/t'
const LOG = `${HOME}/.claude/fitness/log`
const MONDAY_9AM = new Date(2026, 9, 5, 9).getTime()

// The world beneath Terminal Gym: files in memory, a held clock, and the engine
// calls it makes answered quietly, toasts recorded.
const world = (
  on: On,
  files = new Map<string, string>(),
  { introduced = true, store = {} as Record<string, unknown>, now = MONDAY_9AM, storeDelayMs = 0 } = {},
) => {
  const clock = mock.clock(on, { now })
  // By hand, not mock.store, so a test can read back what the mod kept.
  const stored = new Map<string, unknown>(Object.entries({ ...(introduced ? { introduced: true } : {}), ...store }))
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', async ($, e) => {
    if (storeDelayMs > 0) await new Promise(resolve => setTimeout(resolve, storeDelayMs))
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    stored.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...stored.keys()] }))
  mock.env(on, { HOME })
  const toasts: string[] = []
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  // When each file was last written, the way a real disk would tell it.
  const mtimes = new Map<string, number>()
  const touch = (path: string, text: string) => {
    files.set(path, text)
    mtimes.set(path, clock.now())
  }
  on('fs.write', ($, e) => {
    touch(e.path, e.text)
    return { value: undefined }
  })
  const entry = (path: string) => ({
    kind: 'file' as const,
    size: files.get(path)?.length ?? 0,
    mtimeMs: mtimes.get(path) ?? 0,
    isLink: false,
  })
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => ({ name: path.slice(e.path.length + 1), ...entry(path) })),
  }))
  on('fs.stat', ($, e) => {
    if (files.has(e.path)) return { value: entry(e.path) }
    const isDir = [...files.keys()].some(path => path.startsWith(`${e.path}/`))
    if (!isDir) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
  })
  const calls: string[] = []
  on('fs.exists', ($, e) => {
    calls.push('fs.exists')
    const isDir = [...files.keys()].some(path => path.startsWith(`${e.path}/`))
    return { value: files.has(e.path) || isDir }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const registered: string[] = []
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  const config = new Map<string, unknown>()
  on('config.set', ($, e) => {
    config.set(e.key, e.value)
    return { value: e.value }
  })
  const open = new Set<string>()
  on('ui.open', ($, e) => {
    calls.push(`ui.open:${e.id}`)
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  // The prompt box: what fills write and what the mod reads back.
  const box = { text: '' }
  on('prompt.fill', ($, e) => {
    box.text = e.mode === 'append' ? box.text + e.text : e.text
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  // What sits beneath the mod: a settings hook may refuse the prompt.
  const below = { refuse: undefined as string | undefined }
  on('prompt.submit', ($, e) => (below.refuse === undefined ? { text: e.text } : { drop: below.refuse }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, files, touch, toasts, open, config, calls, registered, below, box, stored }
}

// A day's pace file, as the mod writes it beside the count.
const day = (state: { start?: number; window?: { from: number; ms: number; base: number }; breather?: number }) =>
  `${JSON.stringify(state)}\n`

const fit = ($: Engine, args: string) =>
  $.command.run({
    command: 'fit',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

// A prompt the person typed: in strict mode, the one thing that costs reps.
const send = ($: Engine, text = 'go') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const start = ($: Engine) =>
  $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })

describe('lib', () => {
  test('parses /fit arguments', async () => {
    expect(parseFit('')).toEqual({ kind: 'status' })
    expect(parseFit('20')).toEqual({ kind: 'add', n: 20 })
    expect(parseFit('-5')).toEqual({ kind: 'add', n: -5 })
    expect(parseFit('set 80')).toEqual({ kind: 'set', n: 80 })
    expect(parseFit('set x').kind).toBe('error')
    expect(parseFit('dance').kind).toBe('error')
    expect(parseFit('strict')).toEqual({ kind: 'strict', isOn: true })
    expect(parseFit('help')).toEqual({ kind: 'help' })
    expect(parseFit('rules')).toEqual({ kind: 'help' })
    expect(parseFit('strict off')).toEqual({ kind: 'strict', isOn: false })
    expect(parseFit('window 1240')).toEqual({ kind: 'window-until', hour: 12, minute: 40 })
    expect(parseFit('window 9:05')).toEqual({ kind: 'window-until', hour: 9, minute: 5 })
    expect(parseFit('window 940')).toEqual({ kind: 'window-until', hour: 9, minute: 40 })
    expect(parseFit('window 3')).toEqual({ kind: 'window', hours: 3 })
    expect(parseFit('window 2560').kind).toBe('error')
    expect(parseFit('window 0930')).toEqual({ kind: 'window-until', hour: 9, minute: 30 })
    expect(parseFit('window 100')).toEqual({ kind: 'window-until', hour: 1, minute: 0 })
    expect(parseFit('window 12')).toEqual({ kind: 'window', hours: 12 })
    expect(parseFit('easy')).toEqual({ kind: 'strict', isOn: false })
    expect(parseFit('snooze')).toEqual({ kind: 'snooze', minutes: 30 })
    expect(parseFit('snooze 45')).toEqual({ kind: 'snooze', minutes: 45 })
    expect(parseFit('snooze 20m')).toEqual({ kind: 'snooze', minutes: 20 })
    expect(parseFit('snooze 90').kind).toBe('error')
    expect(parseFit('snooze 0').kind).toBe('error')
    // The old name still works.
    expect(parseFit('later 20')).toEqual({ kind: 'snooze', minutes: 20 })
    expect(parseFit('reset')).toEqual({ kind: 'reset' })
    expect(parseFit('rest')).toEqual({ kind: 'skip' })
    expect(parseFit('rest off')).toEqual({ kind: 'unskip' })
    expect(parseFit('start')).toEqual({ kind: 'intro' })
    expect(parseFit('coach strict').kind).toBe('error')
  })

  test('streak counts days with any reps and forgives an empty today', async () => {
    const day = (count: number, isSkipped = false) => ({ date: 'd', count, goal: 100, exercise: 'dips', isSkipped })
    expect(streak([day(0), day(100), day(120), day(40)])).toBe(3)
    expect(streak([day(0), day(100), day(40), day(0)])).toBe(2)
    expect(streak([day(100), day(100, true), day(100)])).toBe(1)
    // A rest day taken today ends the run now, not tomorrow.
    expect(streak([day(100), day(40), day(0, true)])).toBe(0)
  })
})

describe('setup helpers', () => {
  test('custom routines, scaling and colors', async () => {
    expect(parseCustom('30 burpees')?.mon).toEqual({ exercise: 'burpees', goal: 30 })
    expect(parseCustom('burpees')).toBeUndefined()
    expect(scale({ mon: { exercise: 'dips', goal: 100 } }, 0.5).mon?.goal).toBe(50)
    expect(progressColor(0, 100)).toBeUndefined()
    expect(progressColor(1, 100)).toBe('#d7af5f')
    expect(progressColor(33, 100)).toBe('#d7af5f')
    expect(progressColor(79, 100)).toBe('#d7af5f')
    expect(progressColor(80, 100)).toBe('#87af87')
    expect(progressColor(100, 100)).toBe('#87af87')
    expect(progressColor(5, 0)).toBeUndefined()
  })
})

describe('logging', () => {
  test('/fit adds reps to the shared log file and seeds a routine', async ($, on) => {
    const { files, toasts } = world(on)
    await start($)
    const ran = await fit($, '60')
    expect(ran.text).toContain('60/100 pushups')
    expect(files.get(`${LOG}/2026-10-05`)).toBe('60\n')
    expect(files.has(`${HOME}/.claude/fitness/routine.json`)).toBe(true)
    expect(toasts.some(t => t.startsWith('💪 +60 pushups.') && t.endsWith('40 to go.'))).toBe(true)

    toasts.length = 0
    await fit($, '40')
    expect(files.get(`${LOG}/2026-10-05`)).toBe('100\n')
    expect(toasts.some(t => t.includes("That's the work"))).toBe(true)
    // The goal's own toast, not a cheer as well.
    expect(toasts.some(t => t.startsWith('💪'))).toBe(false)
  })

  test('a set short of the goal gets a cheer; a lowered count does not', async ($, on) => {
    const { toasts } = world(on)
    await start($)
    await fit($, '10')
    await fit($, '10')
    const cheers = toasts.filter(t => t.startsWith('💪 +10 pushups.'))
    expect(cheers.length).toBe(2)
    // The line turns with the set number.
    expect(cheers[0]).not.toBe(cheers[1])

    toasts.length = 0
    await fit($, '-5')
    await fit($, 'reset')
    expect(toasts.some(t => t.startsWith('💪'))).toBe(false)
  })

  test('back-to-back sets of any size get different lines', () => {
    // 30-rep sets: counts 30, 60, 90 are all multiples of the six lines.
    for (const size of [5, 10, 25, 30, 60]) {
      const lines = [1, 2, 3].map(set => cheer(size, set * size, 300, 'squats').split('. ')[1])
      expect(new Set(lines).size).toBe(3)
    }
  })

  test('/fit reads counts the shell script already wrote', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '30\n']]))
    await start($)
    const ran = await fit($, '')
    expect(ran.text).toContain('30/100 pushups')
  })
})

describe('two sessions', () => {
  test('reps logged in another session reach the band within a poll', async ($, on) => {
    const { clock, touch, calls } = world(on)
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: '0/100 pushups' })).toBeDefined()

    // A quiet log: polls look, but read nothing back in.
    calls.length = 0
    await clock.advance(10_000)
    expect(calls.filter(call => call === 'fs.exists').length).toBeLessThan(5)

    // Another session (or the shell script) writes today's count.
    await clock.advance(1_000)
    touch(`${LOG}/2026-10-05`, '40\n')
    await clock.advance(10_000)
    expect(await ui.find({ type: 'Text', text: '40/100 pushups' })).toBeDefined()
    await ui.unmount()
  })

  test('/fit reload reads the log now, without waiting for a poll', async ($, on) => {
    const { touch } = world(on)
    await start($)
    touch(`${LOG}/2026-10-05`, '25\n')
    const ran = await fit($, 'reload')
    expect(ran.text).toContain('Reloaded from disk. 💪')
    expect(ran.text).toContain('25/100 pushups')
    expect(parseFit('sync')).toEqual({ kind: 'reload' })
  })
})

describe('nudges', () => {
  test('a long turn nudges without blocking when strict is off', async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes("You next: 10 pushups."))).toBe(true)
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('/fit rest marks the day and holds nothing', { options: { strict: true } }, async ($, on) => {
    const { files } = world(on)
    await start($)
    await send($)
    await fit($, 'rest')
    expect(files.has(`${LOG}/2026-10-05.skip`)).toBe(true)
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('/fit rest refuses once reps are logged today', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-05`, '20\n']]))
    await start($)
    expect((await fit($, 'rest')).text).toContain("so it's a training day")
    expect(files.has(`${LOG}/2026-10-05.skip`)).toBe(false)
  })

  test('a nudge suggests the set that is due, and none right after one', async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.swap`, '{"exercise":"squats","goal":500}\n']]))
    await start($)
    await send($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes('You next: 50 squats.'))).toBe(true)
    await fit($, '50')
    toasts.length = 0
    await $.turn.start({ text: 'go', turnId: 't2' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes('You next'))).toBe(false)
  })

  test('no nudge once the goal is met', async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05`, '100\n']]))
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes("mid-set"))).toBe(false)
  })
})

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'gym-week',
  props: {
    title: 'TERMINAL GYM',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

describe('drawing', () => {
  test('the band shows progress and its buttons log reps', async ($, on) => {
    const { files } = world(on)
    await start($)
    let total = 0
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: `${total}/100 pushups` })).toBeDefined()
      await ui.press({ key: 'add10' })
      await ui.press({ key: 'add20' })
      total += 30
      expect(files.get(`${LOG}/2026-10-05`)).toBe(`${total}\n`)
      expect(await ui.find({ type: 'Text', text: `${total}/100 pushups` })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the week pane shows the streak on every surface', async ($, on) => {
    world(
      on,
      new Map([
        [`${LOG}/2026-10-03`, '300\n'],
        [`${LOG}/2026-10-04`, '100\n'],
      ]),
    )
    await start($)
    await fit($, 'streak')
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /2-day streak/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'TERMINAL GYM' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the spinner names the set during a long turn', async ($, on) => {
    const { clock } = world(on)
    on('ui.render', { component: 'Spinner' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{e.props.message ?? e.props.word}</Text>
    })
    await start($)
    const spinner = {
      component: 'Spinner',
      props: { word: 'Sauteing', message: null, suffix: '…', mode: 'responding' },
    } as const
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...spinner })
    expect(await ui.find({ type: 'Text', text: /10 pushups while Claude works/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('first run', () => {
  test('the band introduces Terminal Gym until set up or dismissed', async ($, on) => {
    world(on, new Map(), { introduced: false })
    await start($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /You next/ })).toBeDefined()
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ type: 'Text', text: /0\/100 pushups/ })).toBeDefined()
    await ui.unmount()
  })

  test('/fit help opens a help pane with its own close button', async ($, on) => {
    const { open } = world(on)
    await start($)
    await fit($, 'help')
    expect(open.has('gym-help')).toBe(true)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-help' })
    expect(await ui.find({ type: 'Markdown', text: /\/fit help/ })).toBeDefined()
    await ui.press({ key: 'close' })
    expect(open.has('gym-help')).toBe(false)
  })

  test('/fit streak toggles the pane', async ($, on) => {
    const { open } = world(on)
    await start($)
    await fit($, 'streak')
    expect(open.has('gym-week')).toBe(true)
    const again = await fit($, 'streak')
    expect((await fit($, 'score')).text).toContain('usage')
    expect(again.text).toContain('closed')
    expect(open.has('gym-week')).toBe(false)
  })
})

describe('strict command', () => {
  test('/fit strict flips the setting', async ($, on) => {
    const { config } = world(on)
    await start($)
    const ran = await fit($, 'strict')
    expect(ran.text).toContain('Coach is strict')
    expect(config.get('terminal-gym.strict')).toBe(true)
  })
})

const ONBOARD = {
  component: 'Pane',
  requestId: 'gym-onboard',
  props: { ...PANE.props, title: 'TERMINAL GYM' },
} as const

describe('walkthrough', () => {
  test('three steps, back and next, then a saved program and a streak', async ($, on) => {
    const { files, open } = world(
      on,
      new Map([
        [`${LOG}/2026-10-03`, '400\n'],
        [`${LOG}/2026-10-04`, '400\n'],
      ]),
      { introduced: false },
    )
    await start($)
    const band = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    await band.press({ key: 'setup' })
    expect(open.has('gym-onboard')).toBe(true)

    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    expect(await ui.find({ type: 'Text', text: /Step 1 of 3/ })).toBeDefined()
    expect(await ui.find({ key: 'back' })).toBeUndefined()
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /Pick your program/ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /Step 1 of 3/ })).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-2' })
    await ui.press({ key: 'size-Heavy' })
    expect(await ui.find({ type: 'Text', text: '400 squats' })).toBeDefined()
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /🔥4d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fit streak/ })).toBeDefined()
    await ui.press({ key: 'finish' })
    await ui.unmount()

    expect(JSON.parse(files.get(`${HOME}/.claude/fitness/routine.json`) ?? '{}').mon).toEqual({ exercise: 'squats', goal: 400 })
    expect(open.has('gym-onboard')).toBe(false)
    expect(await band.find({ type: 'Text', text: /0\/400 squats/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '🔥2d' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'log reps: ' })).toBeDefined()
    await band.unmount()
  })

  test('custom goals are typed per exercise and keep the days', async ($, on) => {
    const { files } = world(on)
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    expect(await ui.find({ key: 'goal-pushups' })).toBeUndefined()
    await ui.press({ key: 'program-3' })
    expect(await ui.find({ key: 'size-Heavy' })).toBeUndefined()
    await ui.input({ key: 'goal-pushups', text: '120', kind: 'change' })
    await ui.input({ key: 'goal-squats', text: 'lots' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /whole number above 0/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Pick your program/ })).toBeDefined()
    await ui.input({ key: 'goal-squats', text: '250' })
    expect(await ui.find({ type: 'Text', text: '120 pushups / 100 dips / 250 squats' })).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()

    const routine = JSON.parse(files.get(`${HOME}/.claude/fitness/routine.json`) ?? '{}')
    expect(routine.mon).toEqual({ exercise: 'pushups', goal: 120 })
    expect(routine.tue).toEqual({ exercise: 'dips', goal: 100 })
    expect(routine.sat).toEqual({ exercise: 'squats', goal: 250 })
  })

  test('the mobile walkthrough offers no custom goals', async ($, on) => {
    world(on)
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'mobile', ...ONBOARD })
    await ui.press({ key: 'next' })
    expect(await ui.find({ key: 'program-2' })).toBeDefined()
    expect(await ui.find({ key: 'program-3' })).toBeUndefined()
    await ui.unmount()
  })

  test('a new program leaves the days before it at the goals they had', async ($, on) => {
    // Sunday's 100 pushups were the goal then; a squats program mustn't rewrite it.
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-03.swap`, '{"exercise":"burpees","goal":20}\n']]))
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-2' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    expect(JSON.parse(files.get(`${LOG}/2026-10-04.swap`) ?? '{}')).toEqual({ exercise: 'pushups', goal: 100 })
    // A day already swapped keeps its own plan, and today takes the new one.
    expect(JSON.parse(files.get(`${LOG}/2026-10-03.swap`) ?? '{}')).toEqual({ exercise: 'burpees', goal: 20 })
    expect(files.has(`${LOG}/2026-10-05.swap`)).toBe(false)
  })

  test('custom goals left as filled keep days that differ', async () => {
    const base = { mon: { exercise: 'pushups', goal: 100 }, thu: { exercise: 'pushups', goal: 50 }, tue: { exercise: 'dips', goal: 80 } }
    expect(customRoutine(base, { pushups: '100', dips: '80' })).toEqual(base)
    expect(customRoutine(base, { pushups: '120', dips: '80' })?.thu?.goal).toBe(120)
    expect(customRoutine(base, { pushups: '', dips: '80' })).toBeUndefined()
  })

  test('re-picking the same program writes no history', async ($, on) => {
    const { files } = world(on)
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...ONBOARD })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    expect([...files.keys()].some(path => path.endsWith('.swap'))).toBe(false)
  })

  test('/fit reset puts today back to zero', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-05`, '70\n']]))
    await start($)
    const ran = await fit($, 'reset')
    expect(ran.text).toContain('0/100 pushups')
    expect(files.get(`${LOG}/2026-10-05`)).toBe('0\n')
  })
})

test('/fit start brings the welcome band back', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'start')
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /You next/ })).toBeDefined()
  await ui.unmount()
})

test('/fit program opens the walkthrough', async ($, on) => {
  const { open } = world(on)
  await start($)
  const ran = await fit($, 'program')
  expect(ran.text).toContain('Pick your program')
  expect(open.has('gym-onboard')).toBe(true)
})

describe('swap', () => {
  test('pickSwap cycles or picks by name', async () => {
    const routine = {
      mon: { exercise: 'pushups', goal: 100 },
      tue: { exercise: 'dips', goal: 100 },
      wed: { exercise: 'squats', goal: 300 },
    }
    expect(pickSwap(routine, 'pushups')?.exercise).toBe('dips')
    expect(pickSwap(routine, 'squats')?.exercise).toBe('pushups')
    expect(pickSwap(routine, 'pushups', 'squats')).toEqual({ exercise: 'squats', goal: 300 })
    expect(pickSwap(routine, 'pushups', 'burpees')).toBeUndefined()
  })

  test('/fit swap changes today and sticks for the day', async ($, on) => {
    const { files } = world(on)
    await start($)
    const ran = await fit($, 'swap squats')
    expect(ran.text).toContain('0/300 squats')
    expect(files.has(`${LOG}/2026-10-05.swap`)).toBe(true)
    expect((await fit($, '')).text).toContain('squats')
    expect((await fit($, 'swap')).text).toContain('pushups')
    expect((await fit($, 'swap burpees')).text).toContain('No burpees')
  })
})

describe('swap edge cases', () => {
  test('multi-word names, empty routines and same-exercise swaps', async ($, on) => {
    expect(parseFit('swap jumping jacks')).toEqual({ kind: 'swap', exercise: 'jumping jacks' })
    expect(parseFit('swap Jumping   Jacks')).toEqual({ kind: 'swap', exercise: 'jumping jacks' })
    expect(pickSwap({}, 'pushups')).toBeUndefined()
    const { files } = world(on, new Map([[`${HOME}/.claude/fitness/routine.json`, JSON.stringify({ mon: { exercise: 'jumping jacks', goal: 50 }, tue: { exercise: 'dips', goal: 100 } })]]))
    await start($)
    expect((await fit($, 'swap jumping jacks')).text).toContain('Already on jumping jacks')
    expect((await fit($, 'swap dips')).text).toContain('0/100 dips')
    files.set(`${HOME}/.claude/fitness/routine.json`, '{}')
    expect((await fit($, 'swap')).text).toContain('no exercises')
  })

  test('a damaged swap file falls back to the routine', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05.swap`, '{oops']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/100 pushups')
  })

  test('reps carry over and the reply says so', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '40\n']]))
    await start($)
    expect((await fit($, 'swap squats')).text).toContain('Your 40 reps carry over')
  })
})

test('the scoreboard draws the barbell when it fits and the name alone when narrow', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'streak')
  const wide = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
  expect(await wide.find({ type: 'Text', text: '▐█▌▐█▌━━━' })).toBeDefined()
  await wide.unmount()
  const narrow = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 24 } })
  expect(await narrow.find({ type: 'Text', text: '▐█▌' })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: 'TERMINAL GYM' })).toBeDefined()
  await narrow.unmount()
})

test('the barbell is terminal-only; other surfaces show the name', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'streak')
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: '▐█▌' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'TERMINAL GYM' })).toBeDefined()
    await ui.unmount()
  }
})

test('the bands stack instead of squeezing on narrow terminals', async ($, on) => {
  const { files } = world(on, new Map(), { introduced: false })
  await start($)
  for (const bodyColumns of [140, 70, 40]) {
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns } })
    expect(await ui.find({ type: 'Text', text: 'Your agent put in the reps. You next.' })).toBeDefined()
    expect(await ui.find({ key: 'setup' })).toBeDefined()
    expect(await ui.find({ key: 'dismiss' })).toBeDefined()
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 40 } })
  await narrow.press({ key: 'dismiss' })
  await narrow.press({ key: 'add10' })
  expect(files.get(`${LOG}/2026-10-05`)).toBe('10\n')
  await narrow.unmount()
})

test('time left reads in minutes, then hours', () => {
  expect(untilText(1)).toBe('1m')
  expect(untilText(22.5 * 60_000)).toBe('23m')
  expect(untilText(60 * 60_000)).toBe('1h')
  expect(untilText(65 * 60_000)).toBe('1h 5m')
})

test('band widths follow the labels', async () => {
  expect(buttonsWidth(['Pick your training', 'Help', 'Just train'])).toBe(46)
  expect(buttonsWidth(['+5', '+10', '+25'])).toBe(22)
  expect(cells('✅ 💪 🔥')).toBe(8)
})

test('rep buttons scale with the set, the last one the set exactly', async () => {
  expect(repSteps(30)).toEqual([10, 20, 30])
  expect(repSteps(15)).toEqual([5, 10, 15])
  expect(repSteps(10)).toEqual([5, 10, 20])
  expect(repSteps(5)).toEqual([3, 5, 10])
  expect(repSteps(60)).toEqual([20, 40, 60])
  expect(repSteps(65)).toEqual([20, 40, 65])
  expect(repSteps(13)).toEqual([5, 10, 13])
  expect(repSteps(2)).toEqual([1, 2, 4])
  // Never two buttons with the same key.
  expect(repSteps(1)).toEqual([1, 2])
  expect(repSteps(0)).toEqual([5, 10, 25])
})

test('a 300 goal gets +10 +20 +30', async ($, on) => {
  const { files } = world(on, new Map([[`${LOG}/2026-10-05.swap`, '{"exercise":"squats","goal":300}\n']]))
  await start($)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'add5' })).toBeUndefined()
  await ui.press({ key: 'add30' })
  expect(files.get(`${LOG}/2026-10-05`)).toBe('30\n')
  await ui.unmount()
})

test('the welcome band changes layout with width', async ($, on) => {
  world(on, new Map(), { introduced: false })
  await start($)
  const layout = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns } })
    const dirs = await Promise.all(['band', 'header', 'buttons'].map(async key => (await ui.find({ key }))?.props.flexDirection))
    await ui.unmount()
    return dirs
  }
  expect(await layout(104)).toEqual(['row', 'row', 'row'])
  expect(await layout(103)).toEqual(['column', 'row', 'row'])
  expect(await layout(57)).toEqual(['column', 'row', 'row'])
  expect(await layout(56)).toEqual(['column', 'column', 'row'])
  expect(await layout(45)).toEqual(['column', 'column', 'column'])
})

test('the band wordmark is a mini barbell', async ($, on) => {
  world(on, new Map(), { introduced: false })
  await start($)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '█═' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'TERMINAL-GYM' })).toBeDefined()
  await ui.unmount()
})

test('below the wordmark width the band shows the bare name', async ($, on) => {
  world(on, new Map(), { introduced: false })
  await start($)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 16 } })
  expect(await ui.find({ type: 'Text', text: '█═' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'TERMINAL-GYM' })).toBeDefined()
  await ui.unmount()
})

test('a rest day hides the rep buttons and offers a way back', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'rest')
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Rest day · pushups back tomorrow/ })).toBeDefined()
  expect(await ui.find({ key: 'add5' })).toBeUndefined()
  await ui.press({ key: 'train' })
  await ui.unmount()

  const back = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await back.find({ key: 'add5' })).toBeDefined()
  await back.unmount()
})

describe('rest days', () => {
  test('/fit rest off undoes the rest day and reps count again', async ($, on) => {
    const { files } = world(on)
    await start($)
    await fit($, 'rest')
    expect((await fit($, '10')).text).toContain("Today's a rest day")
    expect(files.get(`${LOG}/2026-10-05`)).toBeUndefined()

    expect((await fit($, 'rest off')).text).toContain('Rest day undone')
    expect((await fit($, '10')).text).toContain('10/100 pushups')
    expect((await fit($, 'rest off')).text).toContain("Today isn't a rest day")
  })

  test('no nudges or held prompts on a rest day', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await fit($, 'rest')
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes('mid-set'))).toBe(false)
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('a rest day marked by hand holds nothing, even when behind', { options: { strict: true } }, async ($, on) => {
    const { files } = world(on)
    await start($)
    await send($)
    // A rest day marked outside /fit rest, after falling behind.
    files.set(`${LOG}/2026-10-05.skip`, '')
    await fit($, '')
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('/fit rest twice says it already is one', async ($, on) => {
    world(on)
    await start($)
    await fit($, 'rest')
    expect((await fit($, 'rest')).text).toContain('Already a rest day')
  })
})

test('Pick your training opens the walkthrough before any other work', async ($, on) => {
  // The engine only counts an open as asked for while the press is still being
  // answered; opening after file reads left the pane undrawn on narrow terminals.
  const { calls } = world(on, new Map(), { introduced: false })
  await start($)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  calls.length = 0
  await ui.press({ key: 'setup' })
  expect(calls[0]).toBe('ui.open:gym-onboard')
  await ui.unmount()
})

test('score rows name each day\'s exercise', async ($, on) => {
  world(on, new Map([[`${LOG}/2026-10-03`, '300\n'], [`${LOG}/2026-10-05`, '15\n']]))
  await start($)
  await fit($, 'streak')
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /300\/300  squats/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /15\/100   pushups/ })).toBeDefined()
  // Each day carries its own bar; today's progress isn't repeated above.
  expect(await ui.find({ type: 'Text', text: '━━━━━━━━━━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '━' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '─────────' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /💪/ })).toBeUndefined()
  await ui.unmount()
})

test('the grid leaves a blank row between weeks', async () => {
  const day = { date: 'd', count: 0, goal: 100, exercise: 'dips', isSkipped: false }
  expect(heatCells(Array.from({ length: 28 }, () => day)).rows).toBe(7)
  expect(heatCells(Array.from({ length: 7 }, () => day)).rows).toBe(1)
})

test('/clear and /resume run the setup again', async ($, on) => {
  on('classic.SessionStart', () => ({}))
  const { registered } = world(on)
  await start($)
  expect(registered).toEqual(['fit'])
  await $.classic.SessionStart({ source: 'clear' })
  expect(registered).toEqual(['fit', 'fit'])
  await $.classic.SessionStart({ source: 'resume' })
  expect(registered).toEqual(['fit', 'fit', 'fit'])
  await $.classic.SessionStart({ source: 'compact' })
  expect(registered).toEqual(['fit', 'fit', 'fit'])
})

test('easy mode still waits for a long turn before nudging', async ($, on) => {
  const { clock, toasts } = world(on)
  await start($)
  await $.turn.start({ text: 'quick one', turnId: 't1' })
  expect(toasts.some(t => t.includes('mid-set'))).toBe(false)
  await clock.advance(31_000)
  expect(toasts.some(t => t.includes('You next: 10 pushups'))).toBe(true)
})

describe('pace', () => {
  const HOUR = 60 * 60_000
  const GAP = (8 * HOUR) / 9 // 100 pushups in sets of 10: ten sets, nine gaps

  test('sets are spread evenly from the first prompt', async () => {
    expect(setSizeFor(100, 0)).toBe(10)
    expect(setSizeFor(300, 0)).toBe(30)
    expect(setSizeFor(12, 0)).toBe(5)
    expect(setSizeFor(3, 0)).toBe(3)
    expect(setSizeFor(100, 15)).toBe(15)
    expect(paceAt(100, 0, 10, 0, 0, 8 * HOUR)).toEqual({ required: 10, behind: 10, setSize: 10, nextDueAt: GAP, restUntil: null })
    expect(paceAt(100, 10, 10, 0, GAP - 1, 8 * HOUR).behind).toBe(0)
    expect(paceAt(100, 10, 10, 0, GAP, 8 * HOUR).behind).toBe(10)
    expect(paceAt(100, 40, 10, 0, 8 * HOUR, 8 * HOUR)).toEqual({ required: 100, behind: 60, setSize: 10, nextDueAt: null, restUntil: null })
    expect(paceAt(0, 0, 0, 0, 0, 8 * HOUR).behind).toBe(0)
  })

  test('strict: the first prompt of the day needs the opening set', { options: { strict: true } }, async ($, on) => {
    world(on)
    await start($)
    const first = await send($)
    expect(first.drop).toContain('Start the day with a set: 10 pushups')
    await fit($, '10')
    expect((await send($)).drop).toBeUndefined()
  })

  // Claude Code restores a dropped prompt; a fill of the mod's own doubled it.
  test('strict: a held prompt is left to Claude Code to restore', { options: { strict: true } }, async ($, on) => {
    const { box } = world(on)
    await start($)
    expect((await send($, 'a long prompt')).drop).toContain('Start the day with a set')
    expect(box.text).toBe('')
  })

  test('/fit goal changes today only, and the pace follows', async ($, on) => {
    const { files } = world(on)
    await start($)
    expect(parseFit('goal 60')).toEqual({ kind: 'goal', n: 60 })
    expect(parseFit('goal').kind).toBe('error')
    expect(parseFit('goal 0').kind).toBe('error')
    const ran = await fit($, 'goal 60')
    expect(ran.text).toContain("Today's goal is 60 pushups")
    expect(JSON.parse(files.get(`${LOG}/2026-10-05.swap`) ?? '{}')).toEqual({ exercise: 'pushups', goal: 60 })
    expect((await fit($, '')).text).toContain('0/60 pushups')
    expect((await fit($, '60')).text).toContain('60/60 pushups')
  })

  test('strict: /fit window spreads what is left over the hours named', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    expect(parseFit('window 3')).toEqual({ kind: 'window', hours: 3 })
    expect(parseFit('window 1.5h')).toEqual({ kind: 'window', hours: 1.5 })
    expect(parseFit('window off')).toEqual({ kind: 'window', hours: null })
    expect(parseFit('window').kind).toBe('error')
    expect(parseFit('window 30').kind).toBe('error')
    await start($)
    await send($)
    await fit($, '10')
    await clock.advance(HOUR)
    // 90 left in sets of 10 over 3h: the first due now, then every 22.5 minutes.
    const ran = await fit($, 'window 3')
    expect(ran.text).toContain('90 pushups left, spread over the next 3h (done by 13:00)')
    expect((await send($)).drop).toContain('(20/100 by now)')
    expect((await fit($, '10')).text).toContain('next set in 23m')
    await clock.advance(23 * 60_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups. 30/100 by now.'))).toBe(true)
    // Off: back to 8h from the 9:00 start, where 20 done covers 10:23.
    expect((await fit($, 'window off')).text).toContain('Back to 8h')
    expect((await send($)).drop).toBeUndefined()
  })

  test('a late window ends at midnight, and a day with no goal gets none', async ($, on) => {
    const { clock } = world(on, new Map(), { now: new Date(2026, 9, 5, 23, 0).getTime() })
    await start($)
    expect((await fit($, 'window 3')).text).toContain('100 pushups left, spread between now and midnight')
    // The last of the ten sets comes due before midnight, not on it.
    await fit($, '90')
    await clock.set(new Date(2026, 9, 5, 23, 59).getTime())
    expect((await fit($, '')).text).toContain('10 due now')
    await fit($, 'goal 1')
    await fit($, '1')
    expect((await fit($, 'window 3')).text).toContain("Today's goal is done")
  })

  test('/fit window 1240 ends the window at that time today', async ($, on) => {
    world(on)
    await start($)
    expect((await fit($, 'window 1240')).text).toContain('100 pushups left, spread between now and 12:40')
    expect((await fit($, 'window 0830')).text).toContain('08:30 has already passed today')
  })

  test('strict: a mid-day hold points to /fit easy, never a refused /fit rest', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '10\n'], [`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    const held = (await send($)).drop ?? ''
    expect(held).toContain('10 pushups due now')
    expect(held).toContain('/fit easy')
    expect(held).not.toContain('/fit rest')
  })

  test('a reset under a mid-day window is not the day\'s opener', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '30\n']]))
    await start($)
    await fit($, 'window 3')
    await fit($, 'reset')
    expect((await send($)).drop).not.toContain('Start the day')
  })

  test('a window is only for today', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-04.day`, day({ window: { from: MONDAY_9AM - 20 * HOUR, ms: HOUR, base: 0 } })]]))
    await start($)
    expect((await send($)).drop).toContain('Start the day with a set: 10 pushups')
  })

  test('a day started in the plugin store before 0.1.5 still counts, until its file is written', { options: { strict: true } }, async ($, on) => {
    const { files } = world(on, new Map(), {
      store: {
        dayStart: { date: '2026-10-05', at: MONDAY_9AM - GAP },
        window: { date: '2026-10-04', from: MONDAY_9AM - 20 * HOUR, ms: HOUR, base: 0 },
      },
    })
    await start($)
    expect((await send($)).drop).toContain('20 pushups due now')
    // The first write moves the day to its file, yesterday's window left behind.
    await fit($, '10')
    expect(JSON.parse(files.get(`${LOG}/2026-10-05.day`) ?? '{}')).toEqual({ start: MONDAY_9AM - GAP, breather: MONDAY_9AM + GAP / 2 })
  })

  test('strict: the next set comes due on schedule, with a toast', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await send($)
    await fit($, '10')
    await clock.advance(GAP - 1_000)
    expect((await send($)).drop).toBeUndefined()
    await clock.advance(2_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups. 20/100 by now.'))).toBe(true)
    expect((await send($)).drop).toContain('10 pushups due now')
    await fit($, '10')
    expect((await send($)).drop).toBeUndefined()
  })

  test('a met goal shows no next set', async ($, on) => {
    world(on)
    await start($)
    await send($)
    expect((await fit($, '100')).text).not.toContain('next set')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /100\/100 pushups/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /next set/ })).toBeUndefined()
    await ui.unmount()
  })

  test('easy: same schedule on the band, nothing held', async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    expect((await send($)).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /first set: 10 to start the day/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /keep prompting/ })).toBeUndefined()
    await ui.press({ key: 'add10' })
    expect(await ui.find({ type: 'Text', text: /next set in 54m/ })).toBeDefined()
    // The band counts down each minute.
    await clock.advance(60_000)
    expect(await ui.find({ type: 'Text', text: /next set in 53m/ })).toBeDefined()
    await ui.unmount()
    await clock.advance(GAP)
    expect(toasts.some(t => t.includes('Set due'))).toBe(true)
    expect((await send($)).drop).toBeUndefined()
  })

  test('strict: the band says to log the due set to keep prompting', { options: { strict: true } }, async ($, on) => {
    world(on)
    await start($)
    await send($)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /first set: 10 to start the day/ })).toBeDefined()
    await ui.unmount()
  })

  test('strict: turns you did not start never start the day or get held', { options: { strict: true } }, async ($, on) => {
    world(on)
    await start($)
    const bg = await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
    expect(bg.drop).toBeUndefined()
    expect((await send($, '/fit streak')).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /behind/ })).toBeUndefined()
    await ui.unmount()
  })

  test('strict: a rest day holds nothing', { options: { strict: true } }, async ($, on) => {
    world(on)
    await start($)
    await fit($, 'rest')
    expect((await send($)).drop).toBeUndefined()
  })

  test('the day start survives a restart and the due timer comes back', async ($, on) => {
    const { clock, toasts } = world(
      on,
      new Map([[`${LOG}/2026-10-05`, '10\n'], [`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - 60_000 })]]),
    )
    await start($)
    await clock.advance(GAP - 60_000 + 1_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups'))).toBe(true)
  })

  test('strict: a set logged while two behind earns a breather, then the rest is due', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await send($)).drop).toContain('20 pushups due now')
    expect((await fit($, '10')).text).toContain('10 due · rest for 27m')
    expect((await send($)).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /rest for 27m/ })).toBeDefined()
    await ui.unmount()
    await clock.advance(GAP / 2 - 1_000)
    expect((await send($)).drop).toBeUndefined()
    expect(toasts.some(t => t.includes('Set due'))).toBe(false)
    await clock.advance(2_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups. 20/100 by now.'))).toBe(true)
    expect((await send($)).drop).toContain('10 pushups due now')
    await fit($, '10')
    expect((await send($)).drop).toBeUndefined()
  })

  test('strict: fewer reps than the smallest button earn a shorter breather', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    // 2 of the 5-rep button: two fifths of the 27m breather, about 11m.
    expect((await fit($, '2')).text).toContain('18 due · rest for 11m')
    expect((await send($)).drop).toBeUndefined()
    // One more rep never cuts the breather short.
    expect((await fit($, '1')).text).toContain('17 due · rest for 11m')
    await clock.advance((GAP / 2) * (2 / 5) + 1_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 17 pushups'))).toBe(true)
    expect((await send($)).drop).toContain('17 pushups due now')
  })

  test('strict: clearing the debt earns no breather', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    await fit($, '20')
    expect((await send($)).drop).toBeUndefined()
    expect((await fit($, '')).text).not.toContain('rest for')
  })

  test('strict: a short set still earns a breather, the rest stays owed', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05.swap`, '{"exercise":"squats","goal":500}\n']]))
    await start($)
    expect((await send($)).drop).toContain('Start the day with a set: 50 squats')
    // 20 of a 50-rep set: short, but a real set.
    expect((await fit($, '20')).text).toContain('30 due · rest for 27m')
    expect((await send($)).drop).toBeUndefined()
  })

  test('strict: clearing the debt or resetting ends the breather, so the next set is not hidden', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - 2 * GAP + 60_000 })]]))
    await start($)
    expect((await fit($, '10')).text).toContain('rest for')
    await fit($, '10')
    await clock.advance(61_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 10 pushups. 30/100 by now.'))).toBe(true)
    expect((await send($)).drop).toContain('10 pushups due now')
    expect((await fit($, '10')).text).not.toContain('rest for')
    await fit($, '10')
    expect((await send($)).drop).toBeUndefined()
    await fit($, 'reset')
    expect((await send($)).drop).toContain('30 pushups due now')
  })

  test('a breather is only for today', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-04.day`, day({ breather: MONDAY_9AM + HOUR })]]))
    await start($)
    expect((await send($)).drop).toContain('Start the day with a set: 10 pushups')
  })

  test('yesterday\'s start does not count today', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-04.day`, day({ start: MONDAY_9AM - 20 * HOUR })]]))
    await start($)
    expect((await send($)).drop).toContain('Start the day with a set: 10 pushups')
  })

  test('strict: /fit snooze puts the due set off, once per set and twice a day', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await send($)).drop).toContain('/fit snooze 30 puts it off')
    expect((await fit($, 'snooze')).text).toContain('20 pushups put off until 09:30. 💪')
    // Prompts go through; the band says when the set is back; nothing is logged.
    expect((await send($)).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /0\/100 pushups  20 due · back at 09:30/ })).toBeDefined()
    await ui.unmount()
    // The same set can't be put off again, now or after the time is up.
    expect((await fit($, 'snooze 10')).text).toContain('Already put off until 09:30')
    await clock.advance(30 * 60_000 + 1_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 20 pushups'))).toBe(true)
    expect((await send($)).drop).toContain('20 pushups due now')
    expect((await fit($, 'snooze')).text).toContain('already put off once')
    // A short set earns its breather as before; the next set due can be put off once more.
    expect((await fit($, '5')).text).toContain('rest for')
    await clock.advance(GAP)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'snooze 15')).text).toContain('put off until')
    expect((await send($)).drop).toBeUndefined()
    // Twice a day is the limit.
    await clock.advance(15 * 60_000 + GAP)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'snooze')).text).toContain("That's 2 put off today already")
  })

  test('strict: a rep or two during /fit snooze keeps the put-off', { options: { strict: true } }, async ($, on) => {
    const { clock } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    await fit($, 'snooze 30')
    // 1 rep earns about 5m, short of the 30m put-off: the put-off stands, still marked.
    expect((await fit($, '1')).text).toContain('19 due · back at 09:30')
    await clock.advance(30 * 60_000 + 1_000)
    expect((await fit($, 'snooze')).text).toContain('already put off once')
  })

  test('strict: a full set during a longer /fit snooze keeps the hold but clears the put-off', { options: { strict: true } }, async ($, on) => {
    const { clock } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    await fit($, 'snooze 30')
    // 5 reps earn the full 27m breather; the 30m hold stands, now as rest.
    expect((await fit($, '5')).text).toContain('15 due · rest for 30m')
    await clock.advance(30 * 60_000 + 1_000)
    // The set put off was logged, so the one due now can be put off.
    expect((await fit($, 'snooze 10')).text).toContain('put off until')
  })

  test('/fit snooze needs a set that is due', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '10\n'], [`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - 60_000 })]]))
    await start($)
    expect((await fit($, 'snooze')).text).toContain('Nothing is due until')
    await fit($, 'set 100')
    expect((await fit($, 'snooze')).text).toContain("Today's goal is done")
  })

  test('/fit goal and /fit window keep a put-off; clearing the debt forgets it', { options: { strict: true } }, async ($, on) => {
    const { clock, files } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await fit($, 'snooze')).text).toContain('20 pushups put off until 09:30')
    // The goal changes which set is due, not the time asked for: the band still says so.
    expect((await fit($, 'goal 60')).text).toContain('due · back at 09:30')
    expect((await send($)).drop).toBeUndefined()
    expect((await fit($, 'snooze')).text).toContain('Already put off until 09:30')
    // When the time is up, it's the new set that was put off, so it can't be put off again.
    await clock.advance(30 * 60_000 + 1_000)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'snooze')).text).toContain('already put off once')
    // Clearing the debt forgets the set that was put off.
    await fit($, 'set 30')
    expect(JSON.parse(files.get(`${LOG}/2026-10-05.day`) ?? '{}')).not.toHaveProperty('putOff')
    // A fresh window's first set is due now, and is a set of its own: it can be put off.
    expect((await fit($, 'window 2')).text).toContain('due now')
    expect((await fit($, 'snooze 10')).text).toContain('put off until')
    // Without a put-off, a window change still ends an ordinary breather: two
    // sets in, a short set leaves reps owed and earns one.
    await clock.advance(34 * 60_000 + 1_000)
    expect((await fit($, '5')).text).toContain('rest for')
    expect((await fit($, 'window 1')).text).toContain('due now')
    expect((await send($)).drop).toContain('pushups due now')
  })

  test('a half-written day file is left alone until it is whole again', { options: { strict: true } }, async ($, on) => {
    const { clock, files, touch } = world(on, new Map([[`${LOG}/2026-10-05.day`, '{"start": 17']]))
    await start($)
    // Another session is mid-write: this one neither starts the day over nor holds the prompt.
    expect((await send($)).drop).toBeUndefined()
    expect(files.get(`${LOG}/2026-10-05.day`)).toBe('{"start": 17')
    // Nor does a set logged now write over it.
    await fit($, '10')
    expect(files.get(`${LOG}/2026-10-05.day`)).toBe('{"start": 17')
    // Whole again, the next poll reads it: the day started a gap ago, so a set is due.
    touch(`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP }))
    await clock.advance(10_000)
    expect((await send($)).drop).toContain('10 pushups due now')
  })

  test('strict: a breather earned in another session holds nothing here', { options: { strict: true } }, async ($, on) => {
    const { clock, touch } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await send($)).drop).toContain('20 pushups due now')
    // The other session logs a set and earns its breather; this one sees both at its next poll.
    await clock.advance(1_000)
    touch(`${LOG}/2026-10-05`, '10\n')
    touch(`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP, breather: MONDAY_9AM + GAP / 2 }))
    await clock.advance(10_000)
    expect((await send($)).drop).toBeUndefined()
    expect((await fit($, '')).text).toContain('10 due · rest for')
  })
})

test('a 00:30 prompt never starts the day, so 9am is not a wall of overdue sets', { options: { strict: true } }, async ($, on) => {
  const { clock } = world(on, new Map(), { now: new Date(2026, 9, 5, 0, 30).getTime() })
  await start($)
  expect((await send($)).drop).toBeUndefined()
  await clock.set(new Date(2026, 9, 5, 9, 0).getTime())
  expect((await send($)).drop).toContain('Start the day with a set: 10 pushups')
})

test('the shell script catching you up is seen by the gate', { options: { strict: true } }, async ($, on) => {
  const { files } = world(on)
  await start($)
  expect((await send($)).drop).toContain('Start the day with a set')
  files.set(`${LOG}/2026-10-05`, '10\n')
  expect((await send($)).drop).toBeUndefined()
})

describe('streaks and today', () => {
  const daysBefore = (n: number) => {
    const files = new Map<string, string>([
      [`${HOME}/.claude/fitness/routine.json`, JSON.stringify(Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, { exercise: 'pushups', goal: 10 }])))],
    ])
    for (let i = 1; i <= n; i++) {
      const d = new Date(2026, 9, 5 - i, 12)
      files.set(`${LOG}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, '10\n')
    }
    return files
  }

  test('a streak longer than the 28-day grid keeps counting', async ($, on) => {
    world(on, daysBefore(40))
    await start($)
    expect((await fit($, '')).text).toContain('🔥40d')
    await fit($, '10')
    expect((await fit($, '')).text).toContain('🔥41d')
  })

  test('a partial day keeps the streak', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-04`, '60\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('🔥1d')
  })

  test('a missed day ends the streak', async ($, on) => {
    const files = daysBefore(40)
    files.delete(`${LOG}/2026-10-01`)
    world(on, files)
    await start($)
    expect((await fit($, '')).text).toContain('🔥3d')
  })

  test('the scoreboard marks today', async ($, on) => {
    world(on)
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /pushups  ◀ today/ })).toBeDefined()
    await ui.unmount()
  })

  test('the scoreboard opens closable with Esc, and Close closes it', async ($, on) => {
    const { open, calls } = world(on)
    await start($)
    await fit($, 'streak')
    expect(open.has('gym-week')).toBe(true)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
    await ui.press({ key: 'close' })
    expect(open.has('gym-week')).toBe(false)
    await ui.unmount()
    expect(calls).toContain('ui.open:gym-week')
  })
})

test('a long streak is cached, so later refreshes skip the walk back', async ($, on) => {
  const routine = JSON.stringify(Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, { exercise: 'pushups', goal: 10 }])))
  const files = new Map<string, string>([[`${HOME}/.claude/fitness/routine.json`, routine]])
  for (let i = 1; i <= 40; i++) {
    const d = new Date(2026, 9, 5 - i, 12)
    files.set(`${LOG}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, '10\n')
  }
  const { calls } = world(on, files)
  await start($)
  calls.length = 0
  expect((await fit($, '')).text).toContain('🔥40d')
  // The window's 28 days are re-read (three files each), plus today's own few;
  // nothing older is, which would be another 120.
  expect(calls.filter(c => c === 'fs.exists').length).toBeLessThan(28 * 3 + 12)
})

describe('progressive goals', () => {
  const ROUTINE = `${HOME}/.claude/fitness/routine.json`
  const routineOf = (files: Map<string, string>) => JSON.parse(files.get(ROUTINE) ?? '{}')
  const session = (count: number, goal = 100, isSkipped = false) => ({ date: 'd', count, goal, exercise: 'pushups', isSkipped })

  test('a hit steps up 5% in fives; two short sessions step back', async () => {
    expect(stepFor(100)).toBe(5)
    expect(stepFor(145)).toBe(5)
    expect(stepFor(150)).toBe(10)
    expect(stepFor(300)).toBe(15)
    expect(stepFor(20)).toBe(5)
    expect(nextGoal(100, [session(100)])).toBe(105)
    expect(nextGoal(100, [session(80)])).toBeUndefined()
    expect(nextGoal(100, [session(80), session(90)])).toBe(95)
    // Rest days and empty days are passed over, never counted as misses.
    expect(nextGoal(100, [session(0, 100, true), session(0), session(100)])).toBe(105)
    expect(nextGoal(100, [session(0), session(0)])).toBeUndefined()
    // A session at another goal (`/fit goal`, or one already counted) moves nothing.
    expect(nextGoal(100, [session(60, 60)])).toBeUndefined()
    expect(nextGoal(105, [session(100, 100)])).toBeUndefined()
    expect(nextGoal(110, [session(80, 110), session(90, 105)])).toBeUndefined()
    // At the floor, or under it from a custom goal, a step back never moves up.
    expect(nextGoal(5, [session(1, 5), session(2, 5)])).toBeUndefined()
    expect(nextGoal(3, [session(1, 3), session(2, 3)])).toBeUndefined()
    expect(nextGoal(10, [session(1, 10), session(2, 10)])).toBe(5)
    expect(parseFit('progress')).toEqual({ kind: 'progress', isOn: true })
    expect(parseFit('progress off')).toEqual({ kind: 'progress', isOn: false })
  })

  test('moving a goal leaves days a custom program set apart', async () => {
    const routine = { mon: { exercise: 'pushups', goal: 100 }, thu: { exercise: 'pushups', goal: 50 }, tue: { exercise: 'dips', goal: 100 } }
    expect(moveGoal(routine, 'pushups', 100, 105)).toEqual({ ...routine, mon: { exercise: 'pushups', goal: 105 } })
  })

  test('an exercise with two goals in one routine stays put, and promises nothing', { options: { progress: true } }, async ($, on) => {
    const routine = { mon: { exercise: 'pushups', goal: 100 }, thu: { exercise: 'pushups', goal: 50 }, sun: { exercise: 'pushups', goal: 100 } }
    expect(canProgress(routine, 'pushups')).toBe(false)
    expect(canProgress({ mon: routine.mon, sun: routine.sun }, 'pushups')).toBe(true)
    const { files, toasts } = world(on, new Map([[ROUTINE, JSON.stringify(routine)], [`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    expect(routineOf(files).mon.goal).toBe(100)
    await fit($, '100')
    expect(toasts.some(t => t.includes('Next pushups day'))).toBe(false)
  })

  test('off by default: a hit changes nothing', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/100 pushups')
    expect(files.has(`${LOG}/2026-10-04.swap`)).toBe(false)
  })

  test('the last session hit: today goes up, the days before keep theirs', { options: { progress: true } }, async ($, on) => {
    // Sunday 2026-10-04 was the last pushups day; Saturday's squats stay out of it.
    const { files, toasts } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-03`, '300\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/105 pushups')
    const routine = routineOf(files)
    expect([routine.mon.goal, routine.thu.goal, routine.sun.goal]).toEqual([105, 105, 105])
    expect(routine.sat).toEqual({ exercise: 'squats', goal: 300 })
    expect(JSON.parse(files.get(`${LOG}/2026-10-04.swap`) ?? '{}')).toEqual({ exercise: 'pushups', goal: 100 })
    expect(files.has(`${LOG}/2026-10-05.swap`)).toBe(false)
    expect(toasts.some(t => t.includes('pushups up to 105'))).toBe(true)
  })

  test('a second session the same day moves nothing again', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n']]))
    await start($)
    await start($)
    expect(routineOf(files).mon.goal).toBe(105)
    expect((await fit($, '')).text).toContain('0/105 pushups')
  })

  test('a rest day is passed over; the session before it counts', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04.skip`, ''], [`${LOG}/2026-10-01`, '100\n']]))
    await start($)
    expect(routineOf(files).mon.goal).toBe(105)
  })

  test('a day with its own goal moves nothing', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '60\n'], [`${LOG}/2026-10-04.swap`, '{"exercise":"pushups","goal":60}\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/100 pushups')
    expect(routineOf(files).mon.goal).toBe(100)
  })

  test('two short sessions in a row step back', { options: { progress: true } }, async ($, on) => {
    const { files, toasts } = world(on, new Map([[`${LOG}/2026-10-04`, '80\n'], [`${LOG}/2026-10-01`, '90\n']]))
    await start($)
    expect((await fit($, '')).text).toContain('0/95 pushups')
    expect(routineOf(files).thu.goal).toBe(95)
    expect(toasts.some(t => t.includes('back to 95'))).toBe(true)
  })

  test('days never trained are not misses', { options: { progress: true } }, async ($, on) => {
    world(on)
    await start($)
    expect((await fit($, '')).text).toContain('0/100 pushups')
  })

  test('a day swapped by hand keeps its plan', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-05.swap`, '{"exercise":"dips","goal":100}\n']]))
    await start($)
    expect(routineOf(files).mon.goal).toBe(100)
  })

  test('hitting the goal says where the next session goes', { options: { progress: true } }, async ($, on) => {
    const { toasts } = world(on)
    await start($)
    await fit($, '100')
    expect(toasts.some(t => t.includes('Next pushups day: 105.'))).toBe(true)
  })

  test('a swap day promises the next session; a goal of its own does not', { options: { progress: true } }, async ($, on) => {
    const { toasts } = world(on)
    await start($)
    await fit($, 'swap dips')
    await fit($, '100')
    expect(toasts.some(t => t.includes('Next dips day: 105.'))).toBe(true)
    await fit($, 'goal 120')
    await fit($, '20')
    expect(toasts.some(t => t.includes('Next dips day: 125'))).toBe(false)
  })

  test('a /fit goal day at the routine goal counts like any other', { options: { progress: true } }, async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-04`, '100\n'], [`${LOG}/2026-10-04.swap`, '{"exercise":"pushups","goal":100}\n']]))
    await start($)
    expect(routineOf(files).mon.goal).toBe(105)
  })

  test('/fit progress flips the setting', async ($, on) => {
    const { config } = world(on)
    await start($)
    expect((await fit($, 'progress')).text).toContain('Progressive goals on')
    expect(config.get('terminal-gym.progress')).toBe(true)
    await fit($, 'progress off')
    expect(config.get('terminal-gym.progress')).toBe(false)
  })
})

// A Raster's cells back as words: [codePoint, foreground, background] triplets.
const words = (cells: string) => new Uint32Array(Uint8Array.from(atob(cells), c => c.charCodeAt(0)).buffer)
const glyphRow = (grid: { columns: number; cells: string }, row: number) => {
  const all = words(grid.cells)
  return Array.from({ length: grid.columns }, (_, col) => String.fromCodePoint(all[(row * grid.columns + col) * 3] ?? 0x20)).join('')
}

const [GOLD, BLUE, PINK] = [0xb88a20, 0x2f9bdc, 0xd4608f]

const logged = (date: string, count: number, exercise = 'pushups', goal = 100, unit?: string) => ({
  date,
  count,
  goal,
  exercise,
  isSkipped: false,
  ...(unit === undefined ? {} : { unit }),
})

describe('scoreboard numbers', () => {
  test('totals add up each exercise, most reps first, and keep the best day', () => {
    const rows = exerciseTotals([
      logged('2026-09-01', 100),
      logged('2026-09-02', 300, 'squats', 300),
      logged('2026-09-04', 120),
      logged('2026-09-07', 120),
      logged('2026-09-08', 90, 'plank', 60, 's'),
    ])
    expect(rows.map(row => row.exercise)).toEqual(['pushups', 'squats', 'plank'])
    expect(rows[0]).toEqual({ exercise: 'pushups', unit: '', total: 340, days: 3, goalsHit: 3, best: 120, bestDate: '2026-09-04' })
    expect(rows[2]?.unit).toBe('s')
  })

  test('milestones are the next round number, past the ladder too', () => {
    expect(nextMilestone(0)).toBe(100)
    expect(nextMilestone(100)).toBe(250)
    expect(nextMilestone(9_999)).toBe(10_000)
    expect(nextMilestone(1_000_000)).toBe(2_000_000)
    expect(nextMilestone(2_345_678)).toBe(3_000_000)
  })

  test('numbers read with commas and their unit', () => {
    expect(commas(999)).toBe('999')
    expect(commas(1234567)).toBe('1,234,567')
    expect(amount(1200)).toBe('1,200 reps')
    expect(amount(1200, 's')).toBe('1,200s')
  })

  test('the best streak is the longest run, across months and rest days', () => {
    expect(bestStreak([])).toBe(0)
    expect(bestStreak([
      logged('2026-08-30', 5),
      logged('2026-08-31', 5),
      logged('2026-09-01', 5),
      logged('2026-09-03', 5),
    ])).toBe(3)
    expect(bestStreak([logged('2026-09-01', 5), { ...logged('2026-09-02', 5), isSkipped: true }, logged('2026-09-03', 5)])).toBe(1)
  })

  test('a range compares with the same span before it', () => {
    const ledger = [logged('2026-09-25', 100), logged('2026-09-28', 100), logged('2026-10-03', 150), logged('2026-10-05', 150, 'squats'), logged('2026-10-05', 80)]
    expect(rangeSummary(ledger, 'pushups', MONDAY_9AM, 7)).toEqual({ total: 230, sessions: 2, change: 15 })
    expect(rangeSummary(ledger, 'squats', MONDAY_9AM, 7).change).toBeUndefined()
    expect(changeText(15)).toBe('▲ 15%')
    expect(changeText(-8)).toBe('▼ 8%')
    expect(changeText(0)).toBe('= same')
    expect(changeText(undefined)).toBe('')
  })

  test('a bar a day while they fit, else whole weeks ending today', () => {
    expect(bucketDays(30, 40)).toBe(1)
    expect(bucketDays(90, 40)).toBe(7)
    expect(bucketDays(365, 40)).toBe(14)
    expect(bucketLabel(1)).toBe('a bar a day')
    expect(bucketLabel(7)).toBe('a bar a week')
    expect(bucketLabel(14)).toBe('a bar per 2 weeks')
  })

  test('exercises take colours by first day logged, and later ones share grey', () => {
    const colors = exerciseColors([
      logged('2026-09-01', 5, 'pushups'),
      logged('2026-09-02', 5, 'dips'),
      logged('2026-09-03', 5, 'pushups'),
      logged('2026-09-04', 5, 'squats'),
      logged('2026-09-05', 5, 'burpees'),
      logged('2026-09-06', 5, 'lunges'),
    ])
    expect(colors.get('pushups')).toBe(GOLD)
    expect(colors.get('dips')).toBe(BLUE)
    expect(colors.get('squats')).toBe(PINK)
    expect(colors.get('burpees')).toBe(colors.get('lunges'))
  })

  test('one chart: a bar holds its day, bright for a goal and faded when short', () => {
    const ledger = [logged('2026-10-03', 100, 'pushups'), logged('2026-10-04', 60, 'dips')]
    const bars = chartBars(ledger, exerciseColors(ledger), MONDAY_9AM, 3, 40)
    expect(bars).toEqual([
      { segments: [{ reps: 100, color: GOLD }] },
      { segments: [{ reps: 60, color: faded(BLUE) }] },
      { segments: [] },
    ])
  })

  test('a week bar stacks each exercise, split by goal hit and short', () => {
    const ledger = [logged('2026-10-05', 40, 'dips'), logged('2026-10-04', 100, 'pushups'), logged('2026-10-03', 100, 'dips'), logged('2026-09-28', 20, 'dips')]
    const colors = exerciseColors([...ledger].reverse())
    const bars = chartBars(ledger, colors, MONDAY_9AM, 14, 7)
    expect(bars.length).toBe(2)
    expect(bars[0]?.segments).toEqual([{ reps: 20, color: faded(GOLD) }])
    const stack = bars[1]?.segments ?? []
    // One exercise's parts stay together: dips, goal then short, then pushups.
    expect(stack).toEqual([{ reps: 100, color: GOLD }, { reps: 40, color: faded(GOLD) }, { reps: 100, color: BLUE }])
  })

  test('bars scale to the tallest, on five rows of eighths', () => {
    const grid = barCells([{ segments: [] }, { segments: [{ reps: 50, color: GOLD }] }, { segments: [{ reps: 100, color: BLUE }] }], 6)
    expect(grid.columns).toBe(5)
    expect(grid.rows).toBe(5)
    expect(glyphRow(grid, 0)).toBe('    █')
    expect(glyphRow(grid, 2)).toBe('  ▄ █')
    expect(glyphRow(grid, 4)).toBe('▁ █ █')
    // The empty day's tick is the dim one; the bar next to it wears its colour.
    expect(words(grid.cells)[(4 * 5 + 0) * 3 + 1]).toBe(0x343434)
    expect(words(grid.cells)[(4 * 5 + 2) * 3 + 1]).toBe(GOLD)
  })

  test('a stack meeting inside a cell draws one colour over the other', () => {
    const grid = barCells([{ segments: [{ reps: 3, color: GOLD }, { reps: 37, color: BLUE }] }], 1)
    expect([...words(grid.cells).subarray(4 * 3, 5 * 3)]).toEqual([0x2583, GOLD, BLUE])
    expect(glyphRow(grid, 0)).toBe('█')
  })

  test('a stack ending inside a cell stands as tall as one color would', () => {
    const lone = barCells([{ segments: [{ reps: 5, color: GOLD }] }, { segments: [{ reps: 40, color: GOLD }] }], 4)
    const stack = barCells([{ segments: [{ reps: 2, color: GOLD }, { reps: 3, color: BLUE }] }, { segments: [{ reps: 40, color: GOLD }] }], 4)
    expect(glyphRow(stack, 4)[0]).toBe(glyphRow(lone, 4)[0])
    const top = words(stack.cells).subarray(4 * stack.columns * 3, 4 * stack.columns * 3 + 3)
    expect([...top]).toEqual([0x2585, BLUE, 0x01000000])
  })

  test('where three colors meet in a cell, the lowest keeps its height', () => {
    const grid = barCells([{ segments: [{ reps: 12, color: GOLD }, { reps: 1, color: BLUE }, { reps: 9, color: PINK }, { reps: 18, color: GOLD }] }], 1)
    const row3 = words(grid.cells).subarray(3 * 3, 4 * 3)
    expect([...row3]).toEqual([0x2584, GOLD, PINK])
  })

  test('a tiny segment still shows beside a huge one', () => {
    const grid = barCells([{ segments: [{ reps: 1, color: GOLD }, { reps: 10000, color: BLUE }] }], 1)
    expect(words(grid.cells)[4 * 3 + 1]).toBe(GOLD)
  })

  test('bars touch when they only just fit, and the chart stays inside its width', () => {
    const bars = Array.from({ length: 30 }, () => ({ segments: [{ reps: 5, color: GOLD }] }))
    expect(chartWidth(30, 40)).toBe(30)
    expect(chartWidth(7, 40)).toBeLessThanOrEqual(40)
    expect(barCells(bars, 40).columns).toBe(30)
  })

  test('other surfaces get the same stacks as SVG', () => {
    const svg = barSvg([{ segments: [] }, { segments: [{ reps: 100, color: GOLD }] }])
    expect(svg).toContain('viewBox="0 0 20 80"')
    expect(svg).toContain('fill="#b88a20"')
  })

  test('the axis names the first day and today, or today alone when tight', () => {
    expect(axisText(7, MONDAY_9AM, 20)).toBe('09-29          today')
    expect(axisText(7, MONDAY_9AM, 8)).toBe('today')
  })

  test('the year grid ends this week and leaves later days blank', () => {
    // A Monday: Sunday and today are drawn, Tuesday on are blank.
    const ledger = [logged('2026-10-04', 100)]
    const grid = yearCells(ledger, exerciseColors(ledger), MONDAY_9AM, 40)
    expect(grid.columns).toBe(40)
    expect(grid.rows).toBe(4)
    const all = words(grid.cells)
    const lastColumn = (row: number) => all.subarray((row * 40 + 39) * 3, (row * 40 + 40) * 3)
    expect([...lastColumn(0)]).toEqual([0x2580, GOLD, 0x87af87])
    expect([...lastColumn(1)]).toEqual([0x20, 0x01000000, 0x01000000])
    expect(grid.months).toContain('Oct')
    expect(yearCells([], new Map(), MONDAY_9AM, 200).columns).toBe(53)
  })
})

describe('the scoreboard pane', () => {
  // A day each for three exercises, more than the 28-day grid reaches.
  const season = () => new Map([
    [`${HOME}/.claude/fitness/routine.json`, `${JSON.stringify({ mon: { exercise: 'pushups', goal: 100 }, tue: { exercise: 'plank', goal: 60, unit: 's' }, sat: { exercise: 'squats', goal: 300 } })}\n`],
    [`${LOG}/2026-01-05`, '1200\n'],
    [`${LOG}/2026-01-05.swap`, `${JSON.stringify({ exercise: 'squats', goal: 300 })}\n`],
    [`${LOG}/2026-10-03`, '300\n'],
    [`${LOG}/2026-10-05`, '40\n'],
    [`${LOG}/2026-10-05.day`, '{}\n'],
    [`${LOG}/2026-10-05.skip`, 'off\n'],
    [`${LOG}/2026-09-29`, '90\n'],
    [`${LOG}/not-a-day`, '9999\n'],
  ])
  const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 70 } }

  test('all-time totals reach past the grid, with the next milestone and best day', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    // The plank's seconds stay out of the reps, and the stray file out of both.
    expect(await ui.find({ type: 'Text', text: /1,540 reps · 4 days trained · 3 goals hit/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1,500' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→ 2,500/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /best 1,200/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '90s' })).toBeDefined()
    await ui.unmount()
  })

  test('one chart holds every exercise, and the range buttons change it and stick', async ($, on) => {
    const { stored } = world(on, season())
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    expect(await ui.find({ type: 'Text', text: /LAST 30 DAYS · a bar a day · peak 300/ })).toBeDefined()
    for (const key of ['chart', 'year']) expect(await ui.find({ type: 'Raster', key })).toBeDefined()
    for (const line of [/^300 reps · 1 session$/, /^40 reps · 1 session$/, /^90s · 1 session$/]) {
      expect(await ui.find({ type: 'Text', text: line })).toBeDefined()
    }
    await ui.press({ key: 'range-90' })
    expect(await ui.find({ type: 'Text', text: /LAST 90 DAYS · a bar a week/ })).toBeDefined()
    expect(stored.get('chartDays')).toBe(90)
    await ui.unmount()
  })

  test('a range press has changed and kept the range by the time it returns', async ($, on) => {
    const { stored } = world(on, season(), { storeDelayMs: 40 })
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    await ui.press({ key: 'range-90' })
    expect(stored.get('chartDays')).toBe(90)
    expect(await ui.find({ type: 'Text', text: /LAST 90 DAYS/ })).toBeDefined()
    await ui.unmount()
  })

  test('a new session opens on the range kept from the last', async ($, on) => {
    world(on, season(), { store: { chartDays: 90 } })
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    expect(await ui.find({ type: 'Text', text: /LAST 90 DAYS/ })).toBeDefined()
    await ui.unmount()
  })

  test('/fit streak 90 opens a closed scoreboard on that range', async ($, on) => {
    const { open, calls } = world(on, season())
    await start($)
    await fit($, 'streak 90')
    expect(open.has('gym-week')).toBe(true)
    expect(calls).toContain('ui.open:gym-week')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    expect(await ui.find({ type: 'Text', text: /LAST 90 DAYS/ })).toBeDefined()
    await ui.unmount()
  })

  test('a pane past the widest Raster keeps the chart and its axis inside it', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak 90')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 630 } })
    const chart = await ui.find({ type: 'Raster', key: 'chart' })
    expect(chart?.props.columns).toBe(449)
    // The axis spans the chart, not the pane.
    expect(await ui.find({ type: 'Text', text: /^.{444}today$/ })).toBeDefined()
    await ui.unmount()
  })

  test('/fit streak 90 picks the range and an open pane stays open', async ($, on) => {
    const { open } = world(on, season())
    await start($)
    await fit($, 'streak')
    const text = (await fit($, 'streak 90')).text
    expect(text).toContain('last 90 days')
    expect(open.has('gym-week')).toBe(true)
    expect((await fit($, 'streak nope')).text).toContain('2 to 365')
    expect((await fit($, 'streak 1')).text).toContain('2 to 365')
    expect(parseFit('streak 45d')).toEqual({ kind: 'week', days: 45 })
  })

  test('a range with no reps says so instead of drawing empty charts', async ($, on) => {
    world(on, new Map([[`${LOG}/2026-01-05`, '100\n']]))
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    expect(await ui.find({ type: 'Text', text: 'No reps in the last 30 days.' })).toBeDefined()
    await ui.unmount()
  })

  test('with nothing logged it points at the first set', async ($, on) => {
    world(on)
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /fit 10 logs your first set/ })).toBeDefined()
    await ui.unmount()
  })

  test('a set logged while it is open moves the totals', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...WIDE })
    await fit($, '10')
    expect(await ui.find({ type: 'Text', text: /1,550 reps/ })).toBeDefined()
    await ui.unmount()
  })

  test('remote surfaces get SVG charts and no year grid', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak')
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ plugin: 'terminal-gym', surface, ...WIDE })
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /THE PAST YEAR/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a narrow pane drops the meter and keeps the total', async ($, on) => {
    world(on, season())
    await start($)
    await fit($, 'streak')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 24 } })
    expect(await ui.find({ type: 'Text', text: '1,500' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /→/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a new program freezes logged days past the grid, so totals keep their exercise', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-01-06`, '50\n']]))
    await start($)
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-onboard' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-1' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
    // A Tuesday under the default rotation.
    expect(files.get(`${LOG}/2026-01-06.swap`)).toBe(`${JSON.stringify({ exercise: 'dips', goal: 100 })}\n`)
  })
  // Walks the walkthrough to the first preset program.
  const pickProgram = async ($: Engine) => {
    await fit($, 'program')
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-onboard' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'program-1' })
    await ui.press({ key: 'next' })
    await ui.press({ key: 'finish' })
    await ui.unmount()
  }

  test('a new program leaves today alone, so today follows it', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-05`, '40\n']]))
    await start($)
    await pickProgram($)
    expect(files.has(`${LOG}/2026-10-05.swap`)).toBe(false)
  })

  test('a logged day the old routine left out keeps reading as it did', async ($, on) => {
    const { files } = world(on, new Map([
      [`${HOME}/.claude/fitness/routine.json`, `${JSON.stringify({ mon: { exercise: 'dips', goal: 50 } })}\n`],
      // Sundays, one outside the grid and one in it, with no plan in that routine.
      [`${LOG}/2026-01-04`, '50\n'],
      [`${LOG}/2026-10-04`, '60\n'],
    ]))
    await start($)
    await pickProgram($)
    for (const date of ['2026-01-04', '2026-10-04']) {
      expect(files.get(`${LOG}/${date}.swap`)).toBe(`${JSON.stringify({ exercise: 'reps', goal: 0 })}\n`)
    }
    // An unlogged day in the grid stays unwritten, as before.
    expect(files.has(`${LOG}/2026-10-03.swap`)).toBe(false)
  })
})

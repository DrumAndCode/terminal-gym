import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buttonsWidth, cells, customRoutine, heatCells, paceAt, parseCustom, parseFit, pickSwap, progressColor, repSteps, scale, setSizeFor, streak } from '../hooks/lib'

const HOME = '/home/t'
const LOG = `${HOME}/.claude/fitness/log`
const MONDAY_9AM = new Date(2026, 9, 5, 9).getTime()

// The world beneath Terminal Gym: files in memory, a held clock, and the engine
// calls it makes answered quietly, toasts recorded.
const world = (
  on: On,
  files = new Map<string, string>(),
  { introduced = true, store = {} as Record<string, unknown>, now = MONDAY_9AM } = {},
) => {
  const clock = mock.clock(on, { now })
  mock.store(on, { ...(introduced ? { introduced: true } : {}), ...store })
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
  return { clock, files, touch, toasts, open, config, calls, registered, below, box }
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
    expect(parseFit('later')).toEqual({ kind: 'later', minutes: 30 })
    expect(parseFit('later 45')).toEqual({ kind: 'later', minutes: 45 })
    expect(parseFit('later 20m')).toEqual({ kind: 'later', minutes: 20 })
    expect(parseFit('later 90').kind).toBe('error')
    expect(parseFit('later 0').kind).toBe('error')
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

    await fit($, '40')
    expect(files.get(`${LOG}/2026-10-05`)).toBe('100\n')
    expect(toasts.some(t => t.includes("That's the work"))).toBe(true)
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

  test('/fit rules opens a help pane with its own close button', async ($, on) => {
    const { open } = world(on)
    await start($)
    await fit($, 'rules')
    expect(open.has('gym-help')).toBe(true)
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...PANE, requestId: 'gym-help' })
    expect(await ui.find({ type: 'Markdown', text: /House rules/ })).toBeDefined()
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

test('band widths follow the labels', async () => {
  expect(buttonsWidth(['Pick your training', 'House rules', 'Just train'])).toBe(53)
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
  expect(await layout(111)).toEqual(['row', 'row', 'row'])
  expect(await layout(110)).toEqual(['column', 'row', 'row'])
  expect(await layout(57)).toEqual(['column', 'row', 'row'])
  expect(await layout(56)).toEqual(['column', 'column', 'row'])
  expect(await layout(52)).toEqual(['column', 'column', 'column'])
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
    expect((await fit($, '10')).text).toContain('next set 10:22')
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

  test('easy: same schedule on the band, nothing held', async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    expect((await send($)).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /first set: 10 to start the day/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /keep prompting/ })).toBeUndefined()
    await ui.press({ key: 'add10' })
    expect(await ui.find({ type: 'Text', text: /next set 09:53/ })).toBeDefined()
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

  test('strict: less than the smallest button, or clearing the debt, earns no breather', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    await fit($, '4')
    expect((await send($)).drop).toContain('16 pushups due now')
    await fit($, '16')
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

  test('strict: /fit later puts the due set off, once per set and twice a day', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await send($)).drop).toContain('/fit later 30 puts it off')
    expect((await fit($, 'later')).text).toContain('20 pushups put off until 09:30. 💪')
    // Prompts go through; the band says when the set is back; nothing is logged.
    expect((await send($)).drop).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
    expect(await ui.find({ type: 'Text', text: /0\/100 pushups  20 due · back at 09:30/ })).toBeDefined()
    await ui.unmount()
    // The same set can't be put off again, now or after the time is up.
    expect((await fit($, 'later 10')).text).toContain('Already put off until 09:30')
    await clock.advance(30 * 60_000 + 1_000)
    expect(toasts.some(t => t.includes('⏱ Set due: 20 pushups'))).toBe(true)
    expect((await send($)).drop).toContain('20 pushups due now')
    expect((await fit($, 'later')).text).toContain('already put off once')
    // A short set earns its breather as before; the next set due can be put off once more.
    expect((await fit($, '5')).text).toContain('rest for')
    await clock.advance(GAP)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'later 15')).text).toContain('put off until')
    expect((await send($)).drop).toBeUndefined()
    // Twice a day is the limit.
    await clock.advance(15 * 60_000 + GAP)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'later')).text).toContain("That's 2 put off today already")
  })

  test('/fit later needs a set that is due', { options: { strict: true } }, async ($, on) => {
    world(on, new Map([[`${LOG}/2026-10-05`, '10\n'], [`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - 60_000 })]]))
    await start($)
    expect((await fit($, 'later')).text).toContain('Nothing is due until')
    await fit($, 'set 100')
    expect((await fit($, 'later')).text).toContain("Today's goal is done")
  })

  test('/fit goal and /fit window keep a put-off; clearing the debt forgets it', { options: { strict: true } }, async ($, on) => {
    const { clock, files } = world(on, new Map([[`${LOG}/2026-10-05.day`, day({ start: MONDAY_9AM - GAP })]]))
    await start($)
    expect((await fit($, 'later')).text).toContain('20 pushups put off until 09:30')
    // The goal changes which set is due, not the time asked for: the band still says so.
    expect((await fit($, 'goal 60')).text).toContain('due · back at 09:30')
    expect((await send($)).drop).toBeUndefined()
    expect((await fit($, 'later')).text).toContain('Already put off until 09:30')
    // When the time is up, it's the new set that was put off, so it can't be put off again.
    await clock.advance(30 * 60_000 + 1_000)
    expect((await send($)).drop).toContain('pushups due now')
    expect((await fit($, 'later')).text).toContain('already put off once')
    // Clearing the debt forgets the set that was put off.
    await fit($, 'set 30')
    expect(JSON.parse(files.get(`${LOG}/2026-10-05.day`) ?? '{}')).not.toHaveProperty('putOff')
    // A fresh window's first set is due now, and is a set of its own: it can be put off.
    expect((await fit($, 'window 2')).text).toContain('due now')
    expect((await fit($, 'later 10')).text).toContain('put off until')
    // Without a put-off, a window change still ends an ordinary breather: two
    // sets in, a short set leaves reps owed and earns one.
    await clock.advance(34 * 60_000 + 1_000)
    expect((await fit($, '5')).text).toContain('rest for')
    expect((await fit($, 'window 1')).text).toContain('due now')
    expect((await send($)).drop).toContain('pushups due now')
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
    expect(await ui.find({ type: 'Text', text: /▒ today/ })).toBeDefined()
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

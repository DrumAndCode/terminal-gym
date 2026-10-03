import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buttonsWidth, cells, parseCustom, parseFit, pickSwap, progressColor, scale, streak } from '../hooks/lib'

const HOME = '/home/t'
const LOG = `${HOME}/.claude/fitness/log`
const MONDAY_9AM = new Date(2026, 9, 5, 9).getTime()

// The world beneath Terminal Gym: files in memory, a held clock, and the engine
// calls it makes answered quietly, toasts recorded.
const world = (
  on: On,
  files = new Map<string, string>(),
  { introduced = true, store = {} as Record<string, unknown> } = {},
) => {
  const clock = mock.clock(on, { now: MONDAY_9AM })
  mock.store(on, { ...(introduced ? { introduced: true } : {}), ...store })
  mock.env(on, { HOME })
  const toasts: string[] = []
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const config = new Map<string, unknown>()
  on('config.set', ($, e) => {
    config.set(e.key, e.value)
    return { value: e.value }
  })
  const open = new Set<string>()
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, files, toasts, open, config }
}

const fit = ($: Engine, args: string) =>
  $.command.run({
    command: 'fit',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

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
    expect(parseFit('easy')).toEqual({ kind: 'strict', isOn: false })
    expect(parseFit('reset')).toEqual({ kind: 'reset' })
    expect(parseFit('rest')).toEqual({ kind: 'skip' })
    expect(parseFit('rest off')).toEqual({ kind: 'unskip' })
    expect(parseFit('tour')).toEqual({ kind: 'intro' })
    expect(parseFit('coach strict').kind).toBe('error')
  })

  test('streak counts finished days and forgives an unfinished today', async () => {
    const day = (count: number, isSkipped = false) => ({ date: 'd', count, goal: 100, isSkipped })
    expect(streak([day(0), day(100), day(120), day(40)])).toBe(2)
    expect(streak([day(100), day(100, true), day(100)])).toBe(1)
  })
})

describe('setup helpers', () => {
  test('custom routines, scaling and colors', async () => {
    expect(parseCustom('30 burpees')?.mon).toEqual({ exercise: 'burpees', goal: 30 })
    expect(parseCustom('burpees')).toBeUndefined()
    expect(scale({ mon: { exercise: 'dips', goal: 100 } }, 0.5).mon?.goal).toBe(50)
    expect(progressColor(0, 100)).toBeUndefined()
    expect(progressColor(1, 100)).toBe('#d75f5f')
    expect(progressColor(33, 100)).toBe('#d75f5f')
    expect(progressColor(34, 100)).toBe('#d7af5f')
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

  test('strict mode holds prompts until the debt is paid', { options: { strict: true } }, async ($, on) => {
    const { clock, files } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)

    const held = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(held.drop).toContain('Pay up first: 10 pushups')

    await fit($, '10')
    const let_through = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(let_through.drop).toBeUndefined()
    expect(files.get(`${LOG}/2026-10-05`)).toBe('10\n')
  })

  test('any payment buys two minutes of prompts, then the rest is due', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    await $.turn.start({ text: 'go', turnId: 't2' })
    await clock.advance(31_000)
    expect(toasts).toContain("Your agent's mid-set. +10 pushups added · debt 20 left.")

    const reply = await fit($, '5')
    expect(reply.text).toContain('debt 15 left · next prompt + 2 min unlocked')
    const paid = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(paid.drop).toBeUndefined()

    await clock.advance(119_000)
    const still = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(still.drop).toBeUndefined()

    await clock.advance(2_000)
    const due = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(due.drop).toContain('Pay up first: 15 pushups')
  })

  test('a payment always unlocks the next prompt, even after the break', { options: { strict: true } }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)

    await fit($, '3')
    await clock.advance(5 * 60_000)
    const late = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(late.drop).toBeUndefined()

    const again = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(again.drop).toContain('Pay up first: 7 pushups')
  })

  test('paying it all off leaves no pass for the next debt', { options: { strict: true } }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect((await fit($, '10')).text).toContain('debt paid')

    await clock.advance(3 * 60_000)
    await $.turn.start({ text: 'go', turnId: 't2' })
    await clock.advance(31_000)
    const held = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(held.drop).toContain('Pay up first: 10 pushups')
  })

  test('a toast says when the break after a set is over', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    await fit($, '4')
    await clock.advance(119_000)
    expect(toasts.some(t => t.includes("Break's over"))).toBe(false)
    await clock.advance(2_000)
    expect(toasts.some(t => t.includes("Break's over. Debt 6 pushups left"))).toBe(true)
  })

  test('without debt, the break toast asks for the next set', async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await fit($, '20')
    await fit($, '20')
    await clock.advance(121_000)
    expect(toasts.filter(t => t.includes("Break's over. Next set? 40/100 pushups"))).toHaveLength(1)
  })

  test('/fit rest clears the debt and marks the day', { options: { strict: true } }, async ($, on) => {
    const { clock, files } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    await fit($, 'rest')
    expect(files.has(`${LOG}/2026-10-05.skip`)).toBe(true)
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
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
      await ui.press({ key: 'add25' })
      total += 35
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
    await fit($, 'score')
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

  test('/fit score toggles the pane', async ($, on) => {
    const { open } = world(on)
    await start($)
    await fit($, 'score')
    expect(open.has('gym-week')).toBe(true)
    const again = await fit($, 'score')
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
    expect(await ui.find({ type: 'Text', text: /🔥3d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fit score/ })).toBeDefined()
    await ui.press({ key: 'finish' })
    await ui.unmount()

    expect(JSON.parse(files.get(`${HOME}/.claude/fitness/routine.json`) ?? '{}').mon).toEqual({ exercise: 'squats', goal: 400 })
    expect(open.has('gym-onboard')).toBe(false)
    expect(await band.find({ type: 'Text', text: /0\/400 squats/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '🔥2d' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'log reps: ' })).toBeDefined()
    await band.unmount()
  })

  test('/fit reset puts today back to zero', async ($, on) => {
    const { files } = world(on, new Map([[`${LOG}/2026-10-05`, '70\n']]))
    await start($)
    const ran = await fit($, 'reset')
    expect(ran.text).toContain('0/100 pushups')
    expect(files.get(`${LOG}/2026-10-05`)).toBe('0\n')
  })
})

test('/fit tour brings the welcome band back', async ($, on) => {
  world(on)
  await start($)
  await fit($, 'tour')
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
  await fit($, 'score')
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
  await fit($, 'score')
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

test('the band labels debt as what is left and says if prompts are open', { options: { strict: true } }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(31_000)
  const ui = await $.ui.mount({ plugin: 'terminal-gym', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /debt 10 left · pay to unlock/ })).toBeDefined()
  await ui.press({ key: 'add5' })
  expect(await ui.find({ type: 'Text', text: /debt 5 left · prompts open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /owe/ })).toBeUndefined()
  await ui.unmount()
})

test('a rest day hides the rep buttons and offers a way back', async ($, on) => {
  world(on)
  await start($)
  await fit($, '20')
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

  test('no nudges or debt on a rest day', { options: { strict: true } }, async ($, on) => {
    const { clock, toasts } = world(on)
    await start($)
    await fit($, 'rest')
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    expect(toasts.some(t => t.includes('mid-set'))).toBe(false)
    const submitted = await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(submitted.drop).toBeUndefined()
  })

  test('debt left from earlier never holds prompts on a rest day', { options: { strict: true } }, async ($, on) => {
    const { clock, files } = world(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await clock.advance(31_000)
    // A rest day marked outside /fit rest (or before rest days cleared debt).
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

test('a restart mid-break still ends the break on time', { options: { strict: true } }, async ($, on) => {
  const { clock, toasts } = world(on, new Map(), { store: { debt: 10, paidAt: MONDAY_9AM - 60_000 } })
  await start($)
  await clock.advance(59_000)
  expect(toasts.some(t => t.includes("Break's over"))).toBe(false)
  await clock.advance(2_000)
  expect(toasts.some(t => t.includes("Break's over. Debt 10"))).toBe(true)
})

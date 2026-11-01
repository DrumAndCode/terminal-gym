import type { Day } from '../types'
import { DEFAULT, EMPTY, GRID_COLORS, dayKey, encodeCells, isDone, keepsStreak, lastDays, noonOf } from './lib'

// The scoreboard's numbers and charts, worked out from the ledger: every day
// with reps, oldest first. Pure, so a drawing only has to read them.

const DAY_MS = 86_400_000
// Today on the year grid: the band's green, which no exercise wears.
const TODAY = 0x87af87
export const TODAY_COLOR = `#${TODAY.toString(16)}`

// Three hues that stay apart under colour blindness, on a dark terminal. A fourth
// fails that check, so later exercises share a grey and rely on their labels.
const EXERCISE_HUES = [0xb88a20, 0x2f9bdc, 0xd4608f]
const OTHER_HUE = 0x9a9890
const SHORT_MIX = 0.42
const TERMINAL_GROUND = 0x1a1a19

export const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

// A short day is the same hue faded toward the ground, so hue keeps naming the
// exercise and brightness says whether the goal was hit.
export const faded = (color: number) => {
  const channel = (shift: number) =>
    Math.round(((color >> shift) & 255) * SHORT_MIX + ((TERMINAL_GROUND >> shift) & 255) * (1 - SHORT_MIX))
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

export type ExerciseColors = ReadonlyMap<string, number>

// By first day logged, which never changes, so an exercise keeps its colour.
export const exerciseColors = (ledger: readonly Day[]): ExerciseColors => {
  const colors = new Map<string, number>()
  for (const day of ledger) {
    if (!colors.has(day.exercise)) colors.set(day.exercise, EXERCISE_HUES[colors.size] ?? OTHER_HUE)
  }
  return colors
}

const colorOf = (colors: ExerciseColors, exercise: string) => colors.get(exercise) ?? OTHER_HUE

export const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
] as const

export const DEFAULT_RANGE = 30

// 12345 → "12,345".
export const commas = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ',')

export const amount = (n: number, unit = '') => (unit === '' ? `${commas(n)} reps` : `${commas(n)}${unit}`)

// Date keys sort as text, so a span is two string comparisons.
const within = (ledger: readonly Day[], from: string, to: string) => ledger.filter(day => day.date >= from && day.date <= to)

const sum = (days: readonly Day[]) => days.reduce((total, day) => total + day.count, 0)

export type ExerciseTotal = {
  exercise: string
  unit: string
  total: number
  days: number
  goalsHit: number
  best: number
  bestDate: string
}

// One row an exercise, the most reps first.
export const exerciseTotals = (ledger: readonly Day[]): ExerciseTotal[] => {
  const totals = new Map<string, ExerciseTotal>()
  for (const day of ledger) {
    const row = totals.get(day.exercise) ?? { exercise: day.exercise, unit: day.unit ?? '', total: 0, days: 0, goalsHit: 0, best: 0, bestDate: '' }
    row.total += day.count
    row.days += 1
    if (isDone(day)) row.goalsHit += 1
    // An equal day keeps the earlier date: the day the record was set.
    if (day.count > row.best) {
      row.best = day.count
      row.bestDate = day.date
    }
    totals.set(day.exercise, row)
  }
  return [...totals.values()].sort((a, b) => b.total - a.total)
}

const LADDER = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000]

// The next round number past a total. Past the ladder, the next million.
export const nextMilestone = (total: number) =>
  LADDER.find(mark => mark > total) ?? (Math.floor(total / 1_000_000) + 1) * 1_000_000

// The longest run of days with reps the ledger holds.
export const bestStreak = (ledger: readonly Day[]) => {
  let best = 0
  let run = 0
  let last: number | undefined
  for (const day of ledger.filter(keepsStreak)) {
    const noon = noonOf(day.date)
    run = last !== undefined && Math.round((noon - last) / DAY_MS) === 1 ? run + 1 : 1
    best = Math.max(best, run)
    last = noon
  }
  return best
}

// Reps in the last `days` days, and the change from the `days` before them.
// No change to show when the earlier span holds nothing to compare with.
export const rangeSummary = (ledger: readonly Day[], exercise: string, now: number, days: number) => {
  const span = lastDays(now, days * 2)
  const [priorFrom, priorTo, from, to] = [span[0], span[days - 1], span[days], span[days * 2 - 1]].map(ms => dayKey(ms ?? now)) as [string, string, string, string]
  const own = ledger.filter(day => day.exercise === exercise)
  const inRange = within(own, from, to)
  const total = sum(inRange)
  const prior = sum(within(own, priorFrom, priorTo))
  return {
    total,
    sessions: inRange.length,
    change: prior > 0 ? Math.round(((total - prior) / prior) * 100) : undefined,
  }
}

export const changeText = (change: number | undefined) =>
  change === undefined ? '' : change === 0 ? '= same' : `${change > 0 ? '▲' : '▼'} ${Math.abs(change)}%`

// One exercise's share of a bar: its hue, faded unless every session hit its goal.
export type Segment = { reps: number; color: number }
export type Bar = { segments: Segment[] }

export const barReps = (bar: Bar) => bar.segments.reduce((total, segment) => total + segment.reps, 0)

// A bar a day while the days fit across, else a bar per one or more whole weeks.
export const bucketDays = (days: number, columns: number) =>
  days <= columns ? 1 : 7 * Math.ceil(days / 7 / Math.max(1, columns))

export const bucketLabel = (bucket: number) =>
  bucket === 1 ? 'a bar a day' : bucket === 7 ? 'a bar a week' : `a bar per ${bucket / 7} weeks`

// Every exercise on one timeline, oldest first. Buckets count back from today, so
// only the oldest can be short. A day holds one exercise, so a stack needs a bucket.
export const chartBars = (ledger: readonly Day[], colors: ExerciseColors, now: number, days: number, columns: number): Bar[] => {
  const byDate = new Map(ledger.map(day => [day.date, day]))
  const span = lastDays(now, days).map(dayKey)
  const bucket = bucketDays(days, columns)
  const bars: Bar[] = []
  for (let end = span.length; end > 0; end -= bucket) {
    const sessions = span.slice(Math.max(0, end - bucket), end).flatMap(date => byDate.get(date) ?? [])
    // Stacked in colour order, so a hue sits low or high the same way in every bar.
    const segments = [...colors].flatMap(([exercise, hue]) => {
      const own = sessions.filter(day => day.exercise === exercise)
      return [
        { reps: sum(own.filter(isDone)), color: hue },
        { reps: sum(own.filter(day => !isDone(day))), color: faded(hue) },
      ].filter(segment => segment.reps > 0)
    })
    bars.unshift({ segments })
  }
  return bars
}

// Bars with a gap between them when there's room, wider on a short range.
const barShape = (count: number, columns: number) => {
  const step = Math.floor(columns / Math.max(1, count))
  return step < 2 ? { width: 1, gap: 0 } : { width: Math.min(6, step - 1), gap: 1 }
}

export const chartWidth = (count: number, columns: number) => {
  const { width, gap } = barShape(count, columns)
  return count * (width + gap) - gap
}

// Five rows of eighth blocks, so a bar has 40 heights. An empty day leaves a dim
// tick, so the row reads as a timeline.
const CHART_ROWS = 5
const EIGHTHS = CHART_ROWS * 8

// A bar as one color per eighth of its height, bottom first.
const barEighths = (bar: Bar, peak: number) => {
  if (bar.segments.length === 0) return [EMPTY]
  return bar.segments
    .flatMap(({ reps, color }) => Array.from({ length: Math.max(1, Math.round((reps / peak) * EIGHTHS)) }, () => color))
    .slice(0, EIGHTHS)
}

const mostOf = (colors: readonly number[]) =>
  [...new Set(colors)].reduce((best, color) =>
    colors.filter(c => c === color).length > colors.filter(c => c === best).length ? color : best)

// A cell draws two colors at most: a block over the background. The top of a bar
// needs that background empty to keep its height, so it takes one color. A full
// cell where three segments meet gives the smallest upper one to its neighbor.
const cellParts = (cell: readonly number[]): [glyph: number, below: number, above: number] => {
  if (cell.length < 8) return [0x2580 + cell.length, mostOf(cell), DEFAULT]
  const below = cell[0] ?? DEFAULT
  const rest = cell.filter(color => color !== below)
  return rest.length === 0 ? [0x2588, below, DEFAULT] : [0x2580 + 8 - rest.length, below, mostOf(rest)]
}

export const barCells = (bars: readonly Bar[], columns: number) => {
  const { width, gap } = barShape(bars.length, columns)
  const wide = chartWidth(bars.length, columns)
  const peak = Math.max(1, ...bars.map(barReps))
  const words = new Uint32Array(wide * CHART_ROWS * 3)
  for (let at = 0; at < words.length; at += 3) words.set([0x20, DEFAULT, DEFAULT], at)
  bars.forEach((bar, i) => {
    const eighths = barEighths(bar, peak)
    for (let row = 0; row < CHART_ROWS; row++) {
      const cell = eighths.slice((CHART_ROWS - 1 - row) * 8, (CHART_ROWS - row) * 8)
      if (cell.length === 0) continue
      const [glyph, below, above] = cellParts(cell)
      for (let col = 0; col < width; col++) {
        words.set([glyph, below, above], (row * wide + i * (width + gap) + col) * 3)
      }
    }
  })
  return { columns: wide, rows: CHART_ROWS, cells: encodeCells(words) }
}

// The same bars for the surfaces with no cell grid.
export const barSvg = (bars: readonly Bar[]) => {
  const [slot, height] = [10, 80]
  const peak = Math.max(1, ...bars.map(barReps))
  const rects = bars.flatMap((bar, i) => {
    if (bar.segments.length === 0) return [`<rect x="${i * slot}" y="${height - 2}" width="${slot - 2}" height="2" fill="${GRID_COLORS.none}"/>`]
    let top = height
    return bar.segments.map(({ reps, color }) => {
      const tall = Math.max(2, Math.round((reps / peak) * height))
      top -= tall
      return `<rect x="${i * slot}" y="${top}" width="${slot - 2}" height="${tall}" fill="${hex(color)}"/>`
    })
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${bars.length * slot} ${height}">${rects.join('')}</svg>`
}

// The first and last day of the chart, under its bars.
export const axisText = (days: number, now: number, width: number) => {
  const first = dayKey(lastDays(now, days)[0] ?? now).slice(5)
  const last = 'today'
  return width < first.length + last.length + 1 ? last : `${first}${last.padStart(width - first.length)}`
}

const YEAR_WEEKS = 53
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// The months over the year grid, each at the week it starts.
const monthRow = (weeks: readonly number[]) => {
  let row = ''
  weeks.forEach((sunday, col) => {
    const date = new Date(sunday)
    const startsMonth = date.getDate() <= 7
    if (startsMonth && col >= row.length) row = `${row.padEnd(col)}${MONTHS[date.getMonth()] ?? ''} `
  })
  return row.trimEnd()
}

// The past year on four rows, a column a week from Sunday, a day half a cell
// tall: each `▀` paints one day above and the next below it, in its foreground
// and background. Stops at today, so the current week's later days stay blank.
export const yearCells = (ledger: readonly Day[], colors: ExerciseColors, now: number, columns: number) => {
  const weeks = Math.max(1, Math.min(YEAR_WEEKS, columns))
  const today = lastDays(now, 1)[0] ?? now
  const thisSunday = today - new Date(today).getDay() * DAY_MS
  const sundays = Array.from({ length: weeks }, (_, i) => thisSunday - (weeks - 1 - i) * 7 * DAY_MS)
  const byDate = new Map(ledger.map(day => [day.date, day]))
  const colorOn = (sunday: number, weekday: number) => {
    const ms = sunday + weekday * DAY_MS
    // Noon anchors can drift an hour across DST: compare days, not times.
    const date = dayKey(ms)
    const todayKey = dayKey(today)
    if (date > todayKey || weekday > 6) return DEFAULT
    if (date === todayKey) return TODAY
    const day = byDate.get(date)
    if (day === undefined) return EMPTY
    return isDone(day) ? colorOf(colors, day.exercise) : faded(colorOf(colors, day.exercise))
  }
  const rows = 4
  const words = new Uint32Array(weeks * rows * 3)
  sundays.forEach((sunday, col) => {
    for (let row = 0; row < rows; row++) {
      const [top, bottom] = [colorOn(sunday, row * 2), colorOn(sunday, row * 2 + 1)]
      // A blank half can't be a foreground: the default there is a white block.
      words.set(
        top !== DEFAULT ? [0x2580, top, bottom] : bottom !== DEFAULT ? [0x2584, bottom, DEFAULT] : [0x20, DEFAULT, DEFAULT],
        (row * weeks + col) * 3,
      )
    }
  })
  return { months: monthRow(sundays), columns: weeks, rows, cells: encodeCells(words) }
}

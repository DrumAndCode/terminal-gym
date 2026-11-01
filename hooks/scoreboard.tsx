import type { Elements } from 'claude-code'

import type { Day } from '../types'
import { BARBELL, GRID_COLORS, buttonsWidth, fullStreak, progressColor } from './lib'
import {
  RANGES,
  TODAY_COLOR,
  amount,
  axisText,
  barCells,
  barReps,
  barSvg,
  bestStreak,
  bucketDays,
  bucketLabel,
  changeText,
  chartBars,
  chartWidth,
  commas,
  exerciseColors,
  exerciseTotals,
  faded,
  hex,
  nextMilestone,
  rangeSummary,
  yearCells,
} from './stats'

type Surface = keyof Elements

type Data = {
  // The last four weeks, oldest first, and the run of days older than them.
  days: readonly Day[]
  older: number
  // Every day with reps; null while the log is still being read.
  ledger: readonly Day[] | null
  range: number
  now: number
  onRange: (days: number) => Promise<void>
  onClose: () => void
}

const METER = 10
// A Raster's widest.
const MAX_CHART_COLUMNS = 512
const SWATCH = '█ '
// The legend's goal and short marks: the page's ink, since hue names the exercise.
const INK = 0xe8e6e0

export const drawScoreboard = (
  e: { surface: Surface; props: { bodyColumns: number } },
  elements: Elements[Surface],
  { days, older, ledger, range, now, onRange, onClose }: Data,
) => {
  const { Box, Button, Text } = elements
  // The cell grid draws on the terminal alone (elsewhere a fragment), and vector art off it.
  const Raster = e.surface === 'terminal' && 'Raster' in elements ? elements.Raster : undefined
  const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
  const cols = e.props.bodyColumns
  const logged = ledger ?? []
  const totals = exerciseTotals(logged)
  const colors = exerciseColors(logged)
  const hue = (exercise: string) => hex(colors.get(exercise) ?? 0)
  const run = fullStreak(days, older)
  const best = Math.max(run, bestStreak(logged))

  // The bar needs a monospace grid of BARBELL.width cells: the terminal's.
  // Elsewhere, or too narrow, the name alone.
  const barbell =
    e.surface === 'terminal' && cols >= BARBELL.width ? (
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

  // Seconds and reps don't add up, so the headline counts reps alone.
  const lifetime = totals.filter(row => row.unit === '').reduce((all, row) => all + row.total, 0)
  const goalsHit = totals.reduce((all, row) => all + row.goalsHit, 0)
  const trained = logged.length
  const headline = (
    <Box flexDirection="column">
      <Text bold>🔥 {run}-day streak{best > run ? ` · best ${best}` : ''}</Text>
      {trained > 0 && (
        <Text dimColor wrap="truncate-end">
          {`${commas(lifetime)} reps · ${trained} ${trained === 1 ? 'day' : 'days'} trained · ${goalsHit} ${goalsHit === 1 ? 'goal' : 'goals'} hit`}
        </Text>
      )}
    </Box>
  )

  // One row an exercise. The meter runs to the next milestone; the columns that
  // don't fit a narrow pane drop off the right, so the total always shows.
  const nameWidth = Math.max(0, ...totals.map(row => row.exercise.length))
  const totalTexts = totals.map(row => `${commas(row.total)}${row.unit}`)
  const totalWidth = Math.max(0, ...totalTexts.map(text => text.length))
  const allTime = totals.map((row, i) => {
    const mark = nextMilestone(row.total)
    const filled = Math.min(METER, Math.floor((row.total / mark) * METER))
    const next = `→ ${commas(mark)}`
    const bestText = `best ${commas(row.best)}${row.unit}`
    const hasMeter = cols >= SWATCH.length + nameWidth + totalWidth + METER + next.length + 6
    const hasBest = hasMeter && cols >= SWATCH.length + nameWidth + totalWidth + METER + next.length + bestText.length + 8
    return (
      <Box key={`total-${row.exercise}`}>
        <Text color={hue(row.exercise)}>{SWATCH}</Text>
        <Text>{`${row.exercise.padEnd(nameWidth)}  `}</Text>
        <Text bold>{(totalTexts[i] ?? '').padStart(totalWidth)}</Text>
        {hasMeter && <Text>  </Text>}
        {hasMeter && <Text color={hue(row.exercise)}>{'━'.repeat(filled)}</Text>}
        {hasMeter && <Text dimColor>{'─'.repeat(METER - filled)}</Text>}
        {hasMeter && <Text dimColor>{`  ${next}`}</Text>}
        {hasBest && <Text dimColor>{`  ${bestText}`}</Text>}
      </Box>
    )
  })

  const chartColumns = Math.min(cols, MAX_CHART_COLUMNS)
  const bars = chartBars(logged, colors, now, range, chartColumns)
  const peak = Math.max(0, ...bars.map(barReps))
  const rangeRows = totals.flatMap(row => {
    const { total, sessions, change } = rangeSummary(logged, row.exercise, now, range)
    if (total === 0) return []
    const changed = changeText(change)
    return [
      <Box key={`range-row-${row.exercise}`}>
        <Text color={hue(row.exercise)}>{SWATCH}</Text>
        <Text>{`${row.exercise.padEnd(nameWidth)}  `}</Text>
        <Text dimColor wrap="truncate-end">
          {`${amount(total, row.unit)} · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}${changed === '' ? '' : `  ${changed}`}`}
        </Text>
      </Box>,
    ]
  })
  const alt = `Reps per ${bucketDays(range, chartColumns) === 1 ? 'day' : 'period'}, last ${range} days, peak ${commas(peak)}`
  const chart =
    Raster !== undefined ? (
      <Raster key="chart" {...barCells(bars, chartColumns)} />
    ) : Svg !== undefined ? (
      <Svg source={barSvg(bars)} alt={alt} width={bars.length * 10} height={80} />
    ) : null

  const rangeTitle = `LAST ${range} DAYS · ${bucketLabel(bucketDays(range, chartColumns))} · peak ${commas(peak)}`
  const rangeButtons = (
    <Box>
      {RANGES.map(({ days: span, label }, i) => (
        <Box key={`span-${span}`}>
          {i > 0 && <Text> </Text>}
          <Button key={`range-${span}`} label={label} variant={span === range ? 'primary' : undefined} onPress={() => onRange(span)} />
        </Box>
      ))}
    </Box>
  )
  const isOneLine = cols >= rangeTitle.length + 2 + buttonsWidth(RANGES.map(({ label }) => label))
  const charts = (
    <Box flexDirection="column">
      <Box flexDirection={isOneLine ? 'row' : 'column'}>
        <Text bold>{rangeTitle}</Text>
        {isOneLine && <Text>  </Text>}
        {rangeButtons}
      </Box>
      <Text> </Text>
      {rangeRows.length > 0 ? (
        <Box flexDirection="column">
          {chart}
          <Text dimColor>{axisText(range, now, chartWidth(bars.length, chartColumns))}</Text>
          {rangeRows}
        </Box>
      ) : (
        <Text dimColor>{`No reps in the last ${range} days.`}</Text>
      )}
    </Box>
  )

  const legend = (
    <Box>
      <Text color={hex(INK)}>{SWATCH}</Text>
      <Text dimColor>goal hit  </Text>
      <Text color={hex(faded(INK))}>{SWATCH}</Text>
      <Text dimColor>short of it  </Text>
      <Text color={GRID_COLORS.none}>{SWATCH}</Text>
      <Text dimColor>none</Text>
    </Box>
  )

  const year = yearCells(logged, colors, now, cols)
  const yearGrid = Raster !== undefined && (
    <Box flexDirection="column">
      <Box>
        <Text bold>THE PAST YEAR  </Text>
        <Text color={TODAY_COLOR}>█ </Text>
        <Text dimColor>today</Text>
      </Box>
      <Text dimColor>{year.months}</Text>
      <Raster key="year" columns={year.columns} rows={year.rows} cells={year.cells} />
      <Text> </Text>
    </Box>
  )

  // One row a day: date, its progress bar in the band's colors, then the count.
  // Counts padded to one width so the exercise names line up.
  const week = days.slice(-7)
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

  const body =
    ledger === null ? (
      <Text dimColor>Adding up your reps…</Text>
    ) : trained === 0 ? (
      <Text dimColor>No reps yet. /fit 10 logs your first set.</Text>
    ) : (
      <Box flexDirection="column">
        <Text bold>ALL TIME</Text>
        {allTime}
        <Text> </Text>
        {charts}
        {legend}
        <Text> </Text>
        {yearGrid}
      </Box>
    )

  return (
    <Box flexDirection="column">
      {barbell}
      {headline}
      <Text> </Text>
      {body}
      <Text> </Text>
      <Text bold>LAST 7 DAYS</Text>
      {summary}
      <Text> </Text>
      <Text dimColor>Esc or /fit streak to close</Text>
      <Button key="close" label="Close" onPress={onClose} />
    </Box>
  )
}

import { add, zone } from '../../src/lib.js'
import { activeTarget, mealTypes } from './legacy.js'
import { dayState, defaultDay } from './store.js'

const round = (value, digits = 1) => Number(value.toFixed(digits))
const sum = values => values.reduce((total, value) => total + value, 0)
const avg = (values, digits) => values.length ? round(sum(values) / values.length, digits) : null
const measurementFields = { weightKg: 'weight', bodyFatPct: 'bodyFat', waistCm: 'waist' }
export const trendUnits = { intakeKcal: 'kcal', weightKg: 'kg', bodyFatPct: '%', waistCm: 'cm', steps: 'steps', activeKcal: 'kcal', totalKcal: 'kcal', workoutMinutes: 'min' }

function byLatestMeasurement(a, b) {
 return Number(Boolean(b.time)) - Number(Boolean(a.time)) || (b.time ?? '').localeCompare(a.time ?? '') || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
}

function measurements(rows) {
 const ordered = [...rows].sort(byLatestMeasurement)
 const summary = {}
 for (const [metric, prefix] of Object.entries(measurementFields)) {
  const row = ordered.find(item => item[metric] != null)
  summary[metric] = row?.[metric] ?? null
  summary[prefix + 'MeasurementId'] = row?.id ?? null
  summary[prefix + 'SelectionBasis'] = row ? (row.time ? 'time' : 'created_at') : null
 }
 return summary
}

function buildSummary(date, state, meals, activity, measured, target) {
 const recorded = meals.filter(meal => meal.status === 'recorded')
 const mealSubtotalKcal = round(sum(recorded.map(meal => meal.nutrition.kcal)))
 const intakeKcal = state.intakeMode === 'total' ? state.dailyTotalKcal : recorded.length ? mealSubtotalKcal : null
 const targetKcal = target?.intakeKcal ?? 1900
 const mealTypeSummaries = mealTypes.map(mealType => {
  const entries = recorded.filter(meal => meal.mealType === mealType)
  return { mealType, kcal: entries.length ? round(sum(entries.map(meal => meal.nutrition.kcal))) : null,
   recordedCount: entries.length, draftCount: meals.filter(meal => meal.mealType === mealType && meal.status === 'draft').length }
 })
 return {
  date, intakeMode: state.intakeMode, intakeKcal, mealSubtotalKcal, recordedMealCount: recorded.length,
  draftMealCount: meals.length - recorded.length, recordingStatus: state.recordingStatus, isRestDay: state.isRestDay,
  containsEstimates: state.intakeMode === 'total' ? state.totalIsEstimate : recorded.some(meal => meal.nutrition.isEstimate),
  targetKcal, targetHistoryKnown: target?.provenance === 'user',
  remainingToTargetKcal: intakeKcal === null ? null : round(Math.max(0, targetKcal - intakeKcal)),
  overTargetKcal: intakeKcal === null ? null : round(Math.max(0, intakeKcal - targetKcal)),
  activity: activity ?? null, measurement: measurements(measured), mealTypeSummaries
 }
}

export function dailySummary(repo, date) {
 return buildSummary(date, dayState(repo, date), repo.list('meal', date, date), repo.get('activity', date)?.value,
  repo.list('measurement', date, date), activeTarget(repo.list('target'), date))
}

function collect(repo, from, to) {
 const days = new Map()
 for (let date = from;; date = add(date, 1)) {
  days.set(date, { meals: [], measurements: [], workouts: [] })
  if (date === to) break
 }
 for (const [kind, list] of [['meal', 'meals'], ['workout', 'workouts'], ['measurement', 'measurements']]) {
  for (const row of repo.list(kind, from, to)) days.get(row.date)[list].push(row)
 }
 for (const state of repo.list('day', from, to)) days.get(state.date).state = state
 for (const activity of repo.list('activity', from, to)) days.get(activity.date).activity = activity
 const targets = repo.list('target').sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
 let targetIndex = -1
 return [...days.entries()].map(([date, day]) => {
  while (targets[targetIndex + 1]?.effectiveFrom <= date) targetIndex++
  return { ...buildSummary(date, day.state ?? defaultDay(date), day.meals, day.activity, day.measurements, targets[targetIndex]),
   workoutMinutes: day.workouts.length ? sum(day.workouts.map(w => w.durationMinutes)) : null }
 })
}

function buckets(days, groupBy) {
 const groups = new Map()
 for (const row of days) {
  const date = row.date
  const key = groupBy === 'day' ? date : groupBy === 'month' ? date.slice(0, 7) : add(date, -((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7))
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(row)
 }
 return [...groups.values()]
}

function intakeTotals(days) {
 const recorded = days.filter(day => day.intakeKcal !== null)
 const complete = recorded.filter(day => day.recordingStatus === 'complete')
 return { calendarDays: days.length, recordedDays: recorded.length, completeDays: complete.length, missingDays: days.length - recorded.length,
  draftMealCount: sum(days.map(day => day.draftMealCount)), recordedIntakeKcal: round(sum(recorded.map(day => day.intakeKcal))),
  averageRecordedIntakeKcal: avg(recorded.map(day => day.intakeKcal), 1), averageCompleteIntakeKcal: avg(complete.map(day => day.intakeKcal), 1),
  containsEstimates: recorded.some(day => day.containsEstimates) }
}

export function summaries(repo, from, to, groupBy) {
 const days = collect(repo, from, to)
 return { from, to, timezone: zone, groupBy, totals: intakeTotals(days),
  buckets: buckets(days, groupBy).map(rows => ({ from: rows[0].date, to: rows.at(-1).date, ...intakeTotals(rows) })) }
}

function trendValue(row, metric) {
 if (Object.hasOwn(measurementFields, metric)) return { value: row.measurement[metric], partial: false }
 if (metric === 'intakeKcal') return { value: row.intakeKcal, partial: row.recordingStatus !== 'complete' }
 if (metric === 'workoutMinutes') return { value: row.workoutMinutes, partial: false }
 return { value: row.activity?.[metric] ?? null, partial: row.activity?.isPartial ?? false }
}

export function trends(repo, from, to, groupBy, metric) {
 const days = collect(repo, from, to)
 const measured = Object.hasOwn(measurementFields, metric)
 return { from, to, timezone: zone, groupBy, metric, unit: trendUnits[metric], buckets: buckets(days, groupBy).map(rows => {
  const entries = rows.map(row => trendValue(row, metric)).filter(entry => entry.value !== null)
  const values = entries.map(entry => entry.value)
  return { from: rows[0].date, to: rows.at(-1).date, count: values.length, missingDays: rows.length - values.length,
   partialDays: entries.filter(entry => entry.partial).length, sum: !measured && values.length ? round(sum(values), 2) : null,
   average: avg(values, 2), last: measured && values.length ? round(values.at(-1), 2) : null }
 }) }
}

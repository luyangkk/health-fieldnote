import { validDate, zone } from '../../src/lib.js'
import { fail, validateSchema } from '../v1/protocol.js'
import { canonical, digest } from '../v1/store.js'

export const importLimit = 35_000_000
const maxPoints = 150_000
const quantity = 'HKQuantityTypeIdentifier'
const metrics = new Map([
 ['BodyMass', 'weightKg'], ['BodyFatPercentage', 'bodyFatPct'],
 ['StepCount', 'steps'], ['ActiveEnergyBurned', 'activeKcal'],
 ['BasalEnergyBurned', 'basalKcal'], ['AppleExerciseTime', 'durationMinutes']
].map(([id, key]) => [quantity + id, key]))
const dailyKeys = ['steps', 'activeKcal', 'basalKcal', 'durationMinutes']
const dateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const round = (value, decimals = 2) => Math.round((value + Number.EPSILON) * 10 ** decimals) / 10 ** decimals
const bad = (pointer, message = 'Invalid Health Data Export data.') => fail(422, 'INVALID_HEALTH_EXPORT', message, { errors: [{ pointer, code: 'INVALID_VALUE' }] })

function list(value, pointer) {
 if (value === undefined) return []
 if (!Array.isArray(value)) bad(pointer, 'Expected an array.')
 return value
}
function timestamp(value, pointer) {
 if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
     value.startsWith('0000-') || !validDate(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59 ||
     !Number.isFinite(Date.parse(value))) bad(pointer, 'Expected an ISO 8601 timestamp with a timezone.')
 return Date.parse(value)
}
function number(value, pointer) {
 if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) bad(pointer, 'Expected a non-negative finite number.')
 return value
}
function identifier(value, pointer) {
 if (typeof value !== 'string' || !value.trim() || value.length > 220) bad(pointer, 'Invalid sample identifier.')
 return value
}
function sourceKey(source, pointer) {
 if (!object(source)) bad(pointer, 'A source is required for stable sample identification.')
 const name = source.bundle_identifier || source.name
 if (typeof name !== 'string' || !name.trim() || name.length > 500 ||
     (source.device !== undefined && (typeof source.device !== 'string' || source.device.length > 1000))) bad(pointer)
 return digest(canonical([name, source.device ?? '']))
}
function sampleTimes(point, pointer, exportedAt) {
 const start = timestamp(point.start_date ?? point.timestamp, pointer + '/start_date')
 const end = timestamp(point.end_date ?? point.start_date ?? point.timestamp, pointer + '/end_date')
 if (end < start || end > exportedAt + 300_000) bad(pointer, 'Sample times are invalid or later than the export.')
 return [start, end]
}
function converted(value, unit, key, pointer) {
 const factors = key === 'weightKg' ? { kg: 1, g: .001, lb: .45359237, lbs: .45359237, st: 6.35029318 }
  : key === 'bodyFatPct' ? { '%': 1 }
   : key === 'steps' ? { count: 1 } : key === 'durationMinutes' ? { min: 1, s: 1 / 60, sec: 1 / 60 }
    : { kcal: 1, kJ: 1 / 4.184, J: 1 / 4184 }
 if (!Object.hasOwn(factors, unit)) bad(pointer + '/unit', 'Unsupported unit for this metric.')
 let result = number(value, pointer + '/value') * factors[unit]
 // Health Data Export 1.4 raw exports label HealthKit fractions as "%".
 if (key === 'bodyFatPct' && result > 0 && result < 1) result *= 100
 return result
}
const dayOf = value => dateFormatter.format(new Date(value))
const timeOf = value => timeFormatter.format(new Date(value))
const bounds = day => [Date.parse(day + 'T00:00:00+08:00'), Date.parse(day + 'T00:00:00+08:00') + 86400_000]

function ranges(start, end) {
 const result = []
 if (start === end) return [[dayOf(start), 1, start, end]]
 for (let cursor = start; cursor < end;) {
  const day = dayOf(cursor), stop = Math.min(end, bounds(day)[1])
  result.push([day, (stop - cursor) / (end - start), cursor, stop])
  cursor = stop
 }
 return result
}

export function parseHealthExport(input, client, now) {
 if (!object(input)) bad('', 'Expected a JSON object.')
 const arrays = ['metrics', 'category_metrics', 'sleep_summaries', 'workouts']
 for (const key of arrays) if (input[key] !== undefined) list(input[key], '/' + key)
 const test = input.test === true || input.is_test === true || input.type === 'test'
 if (test && arrays.every(key => !input[key]?.length)) return { test: true, records: [], ignored: 0, warnings: [], duplicates: 0 }
 if (test) bad('', 'A test request must not contain health records.')
 if (!arrays.some(key => Array.isArray(input[key]))) bad('', 'Expected Health Data Export arrays.')
 const exportTime = timestamp(input.export_date, '/export_date')
 if (exportTime > now + 300_000) bad('/export_date', 'The export timestamp is too far in the future.')
 const exportedAt = new Date(exportTime).toISOString()
 if (input.metadata !== undefined && !object(input.metadata)) bad('/metadata')
 if (input.metadata?.aggregation_level !== undefined && input.metadata.aggregation_level !== 'raw') bad('/metadata/aggregation_level', 'Use Raw aggregation in Health Data Export.')
 let range
 if (input.date_range !== undefined) {
  if (!object(input.date_range)) bad('/date_range')
  range = [timestamp(input.date_range.start, '/date_range/start'), timestamp(input.date_range.end, '/date_range/end')]
  if (range[1] < range[0] || range[1] > exportTime + 300_000) bad('/date_range', 'The export date range is invalid.')
 }
 const records = new Map(), daily = new Map(), warnings = new Set()
 let ignored = 0, duplicates = 0, pointCount = 0
 const add = row => {
  const previous = records.get(row.sampleKey)
  if (previous && canonical(previous.input) !== canonical(row.input)) bad('', 'Conflicting copies of a sample occur in this export.')
  if (previous) duplicates++
  else records.set(row.sampleKey, row)
 }
 const source = externalId => ({ client, externalId })
 const collection = list(input.metrics, '/metrics')
 if (collection.length > 250 || (input.workouts?.length ?? 0) > 10_000) bad('', 'Too many metric groups or workouts.')
 const groups = new Set()
 for (const [index, metric] of collection.entries()) {
  const pointer = '/metrics/' + index
  if (!object(metric)) bad(pointer)
  const points = list(metric.data_points, pointer + '/data_points')
  pointCount += points.length
  if (pointCount > maxPoints) fail(413, 'TOO_MANY_SAMPLES', 'Export fewer days or metrics per request.')
  const key = metrics.get(metric.id)
  if (!key) { ignored += points.length; continue }
  if (groups.has(metric.id)) bad(pointer, 'A supported metric must occur only once per export.')
  groups.add(metric.id)
  if (metric.aggregation_level !== undefined && metric.aggregation_level !== 'raw') bad(pointer + '/aggregation_level', 'Use Raw aggregation.')
  const seen = new Map()
  for (const [i, point] of points.entries()) {
   const at = pointer + '/data_points/' + i
   if (!object(point)) bad(at)
   const [start, end] = sampleTimes(point, at, exportTime)
   const value = converted(point.value, point.unit ?? metric.unit, key, at)
   const origin = sourceKey(point.source, at + '/source')
   const id = point.id === undefined ? digest(canonical([origin, start, end])) : identifier(point.id, at + '/id')
   const sampleKey = 'hde:' + key + ':' + digest(id)
   if (!dailyKeys.includes(key)) {
    const input = { date: dayOf(start), time: timeOf(start), [key]: round(value), source: source(sampleKey) }
    validateSchema('MeasurementInput', input)
    add({ sampleKey, kind: 'measurement', input })
    continue
   }
   if (end - start > 2 * 86400_000) bad(at, 'Activity samples must be at most two days long.')
   const identity = canonical([origin, start, end])
   if (seen.has(identity)) {
    if (seen.get(identity) !== value) bad(at, 'Conflicting activity samples have the same source and interval.')
    duplicates++
    continue
   }
   seen.set(identity, value)
   for (const [day, portion, from, to] of ranges(start, end)) {
    if (!range || range[0] > bounds(day)[0] || range[1] < to || from < range[0]) {
     warnings.add('INCOMPLETE_ACTIVITY_RANGE'); continue
    }
    if (!daily.has(day)) daily.set(day, new Map())
    const dayMetrics = daily.get(day)
    if (!dayMetrics.has(key)) dayMetrics.set(key, new Map())
    const sources = dayMetrics.get(key)
    if (!sources.has(origin)) sources.set(origin, [])
    sources.get(origin).push({ value: value * portion, start: from, end: to })
   }
  }
 }
 for (const [index, workout] of list(input.workouts, '/workouts').entries()) {
  const at = '/workouts/' + index
  if (!object(workout)) bad(at)
  const [start, end] = sampleTimes(workout, at, exportTime)
  const duration = number(workout.duration, at + '/duration')
  const id = identifier(workout.id, at + '/id')
  const sampleKey = 'hde:workout:' + digest(id)
  const names = { cycling: '骑行', walking: '步行', running: '跑步', strength_training: '力量训练', swimming: '游泳' }
  const type = names[workout.type] ?? workout.display_name ?? workout.type
  const minutes = round(duration / 60)
  const energy = workout.energy == null ? null : round(converted(workout.energy, workout.energy_unit, 'activeKcal', at), 1)
  const reviewRequired = Math.abs(duration - (end - start) / 1000) > Math.max(60, (end - start) / 1000 * .05) || (String(type).includes('力量') && minutes > 100)
  const input = { date: dayOf(start), time: timeOf(start), type, durationMinutes: minutes, activeKcal: energy, reviewRequired, source: source(sampleKey) }
  validateSchema('WorkoutInput', input)
  if (reviewRequired) warnings.add('WORKOUT_DURATION_REVIEW')
  add({ sampleKey, kind: 'workout', input })
 }
 for (const [day, dayMetrics] of [...daily].sort(([a], [b]) => a.localeCompare(b))) {
  const totals = {}
  let overlap = false
  for (const [key, sources] of dayMetrics) {
   if (sources.size > 1) warnings.add('MULTIPLE_ACTIVITY_SOURCES')
   const candidates = []
   for (const [origin, points] of sources) {
    points.sort((a, b) => a.start - b.start || a.end - b.end)
    let coverage = 0, previousEnd = -Infinity
    for (const point of points) {
     if (point.start < previousEnd) overlap = true
     coverage += Math.max(0, point.end - Math.max(point.start, previousEnd))
     previousEnd = Math.max(previousEnd, point.end)
    }
    candidates.push({ origin, coverage, points })
   }
   // Never add iPhone and Watch totals together. Prefer the most-covered source,
   // with a stable hash tie-break; report that this isn't HealthKit's merged total.
   candidates.sort((a, b) => b.coverage - a.coverage || a.origin.localeCompare(b.origin))
   totals[key] = candidates[0].points.reduce((sum, point) => sum + point.value, 0)
  }
  if (overlap) { warnings.add('OVERLAPPING_ACTIVITY_SAMPLES'); continue }
  if (['steps', 'activeKcal', 'basalKcal'].some(key => totals[key] === undefined)) {
   warnings.add('MISSING_ACTIVITY_METRICS'); continue
  }
  const end = Math.min(range[1], exportTime, bounds(day)[1] - 1)
  const sampleKey = 'hde:activity:' + day
  const input = { asOf: timeOf(end), steps: Math.round(totals.steps), activeKcal: round(totals.activeKcal, 1),
   totalKcal: round(totals.activeKcal + totals.basalKcal, 1), durationMinutes: totals.durationMinutes === undefined ? null : round(totals.durationMinutes, 1), source: source(sampleKey) }
  validateSchema('ActivityInput', input)
  if (input.durationMinutes === null) warnings.add('MISSING_EXERCISE_TIME')
  add({ sampleKey, kind: 'activity', date: day, input })
 }
 ignored += list(input.category_metrics, '/category_metrics').length + list(input.sleep_summaries, '/sleep_summaries').length
 return { test: false, exportedAt, records: [...records.values()], ignored, duplicates, warnings: [...warnings].sort() }
}

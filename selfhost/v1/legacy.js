import { fresh, meals, today, validate } from '../../src/lib.js'
import { BASELINE, canonical, dayState, newRecord, reopenDays, repository, transact } from './store.js'

export const mealTypes = ['breakfast', 'lunch', 'dinner', 'snack']
const types = { meals: 'meal', workouts: 'workout', metrics: 'measurement', activity: 'activity' }
const time = value => value?.length === 5 ? value + ':00' : value ?? null

function convert(kind, row, now, previous, client) {
 const base = { ...newRecord(kind, now, previous), id: previous?.id ?? row.id, date: row.date,
  source: previous?.source ?? { client, externalId: kind === 'activity' ? 'activity:' + row.date : row.id } }
 if (kind === 'meal') {
  const nutrition = { carbsGrams: null, fatGrams: null, kcalRange: null, ...previous?.nutrition,
   kcal: row.kcal, proteinGrams: row.protein, isEstimate: row.estimate }
  if (nutrition.kcalRange && (!nutrition.isEstimate || nutrition.kcal < nutrition.kcalRange.min || nutrition.kcal > nutrition.kcalRange.max)) nutrition.kcalRange = null
  const nutritionBasis = previous?.nutritionBasis === 'photo_estimate' && !nutrition.isEstimate ? 'user_provided' : previous?.nutritionBasis ?? 'user_provided'
  return { ...previous, ...base, mealType: mealTypes[meals.indexOf(row.type)], description: row.name, status: 'recorded', nutrition, nutritionBasis,
   time: previous?.time ?? null, note: previous?.note ?? null, items: previous?.items ?? [], mediaIds: previous?.mediaIds ?? [] }
 }
 if (kind === 'workout') return { ...previous, ...base, time: time(row.time), type: row.type, durationMinutes: row.minutes, activeKcal: row.kcal,
  origin: previous?.origin ?? (row.source === 'CMF' ? 'nothing' : row.source === 'Apple 健康' ? 'health-data-export' : client === 'legacy' ? 'legacy' : 'manual'), reviewRequired: row.flag, note: previous?.note ?? null }
 if (kind === 'measurement') return { ...previous, ...base, time: Object.hasOwn(row, 'time') ? time(row.time) : previous?.time ?? null, weightKg: row.weight, waistCm: row.waist,
  bodyFatPct: Object.hasOwn(row, 'bodyFatPct') ? row.bodyFatPct : previous?.bodyFatPct ?? null, note: previous?.note ?? null }
 return { ...base, asOf: time(row.asOf), steps: row.steps, activeKcal: row.kcal, totalKcal: row.total, durationMinutes: row.minutes,
  isPartial: !row.asOf.startsWith('23:59'), completenessBasis: 'timestamp_heuristic' }
}

export function project(kind, row) {
 const { id, date } = row
 if (kind === 'meal') return { id, date, type: meals[mealTypes.indexOf(row.mealType)], name: row.description, kcal: row.nutrition.kcal, protein: row.nutrition.proteinGrams, estimate: row.nutrition.isEstimate }
 if (kind === 'workout') return { id, date, type: row.type, time: row.time, minutes: row.durationMinutes, kcal: row.activeKcal, source: row.origin === 'nothing' ? 'CMF' : row.origin === 'health-data-export' ? 'Apple 健康' : '手动', flag: row.reviewRequired }
 if (kind === 'measurement') return { id, date, time: row.time, weight: row.weightKg, waist: row.waistCm, bodyFatPct: row.bodyFatPct }
 return { id: 'activity:' + date, date, asOf: row.asOf, steps: row.steps, total: row.totalKcal, kcal: row.activeKcal, minutes: row.durationMinutes, partial: row.isPartial }
}

const keyOf = (kind, row) => kind === 'activity' ? row.date : row.id
const isVisible = (kind, row) => kind !== 'meal' || row.status === 'recorded'

function assignRows(repo, kind, incoming, now, migrating, webVersion) {
 const existing = new Map(repo.list(kind).map(row => [keyOf(kind, row), row]))
 const seen = new Set()
 const changedDates = []
 for (const row of incoming) {
  const key = keyOf(kind, row)
  if (seen.has(key)) throw Error('Duplicate legacy record')
  seen.add(key)
  const previous = existing.get(key)
  // The compatibility projection omits drafts. A legacy replacement cannot overwrite one.
  if (previous && !isVisible(kind, previous)) throw Object.assign(Error('这条餐食草稿只能通过 dot 接口修改。'), {status:409})
  const old = previous ?? repo.get(kind, key, true)?.value
  const client = row.source === 'CMF' || kind === 'activity' ? 'nothing' : migrating ? 'legacy' : 'web'
  const converted = convert(kind, row, now, old, client)
  if (previous && canonical(project(kind, previous)) === canonical(project(kind, converted))) continue
  repo.put(kind, key, converted)
  changedDates.push(row.date, previous?.date)
 }
 const counts = new Map()
 if (kind === 'measurement' && !webVersion) for (const row of existing.values()) counts.set(row.date, (counts.get(row.date) ?? 0) + 1)
 for (const [key, row] of existing) {
  if (seen.has(key) || !isVisible(kind, row)) continue
  if ((counts.get(row.date) ?? 0) > 1) throw Object.assign(Error('当天有多条身体测量，请更新网页后再修改。'), {status:409})
  repo.remove(kind, key, row, now)
  changedDates.push(row.date)
 }
 return changedDates
}

export function activeTarget(targets, date) {
 return targets.filter(row => row.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
}

export function legacySnapshot(repo) {
 const { revision, updatedAt } = repo.state()
 if (!revision) return undefined
 const data = fresh()
 for (const [legacy, kind] of Object.entries(types)) {
  const rows = repo.list(kind).filter(row => isVisible(kind, row))
  if (kind === 'measurement') rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  data[legacy] = rows.map(row => project(kind, row))
 }
 const states = repo.list('day')
 data.completed = states.filter(row => row.recordingStatus === 'complete').map(row => row.date)
 data.rest = states.filter(row => row.isRestDay).map(row => row.date)
 data.dailyTotals = states.filter(row => row.intakeMode === 'total').map(row => ({ date: row.date, kcal: row.dailyTotalKcal, estimate: row.totalIsEstimate }))
 const targets = repo.list('target')
 data.target = activeTarget(targets, today())?.intakeKcal ?? 1900
 data.targetSchedule = targets.map(row => ({ date: row.effectiveFrom, kcal: row.intakeKcal }))
 return { revision, payload: JSON.stringify(data), updated_at: updatedAt }
}

export function writeLegacy(repo, revision, data, now, migrating = false, webVersion = false) {
 const oldRevision = repo.state().revision
 if (!migrating && oldRevision !== revision) return false
 const next = { ...fresh(), ...validate(data) }
 const target = activeTarget(repo.list('target'), today())
 if (migrating || next.target !== (target?.intakeKcal ?? 1900)) {
  const date = migrating ? BASELINE : today()
  const previous = repo.get('target', date, true)?.value
  repo.put('target', date, { ...newRecord('target', now, previous), effectiveFrom: date, intakeKcal: next.target, note: null,
   provenance: migrating ? 'legacy_unknown_start' : 'user' })
 }
 const changedMeals = []
 for (const [legacy, kind] of Object.entries(types)) {
  const changed = assignRows(repo, kind, next[legacy], now, migrating, webVersion)
  if (kind === 'meal') changedMeals.push(...changed)
 }
 const completed = new Set(next.completed), rest = new Set(next.rest)
 const states = repo.list('day')
 const knownDates = new Set([...states.map(row => row.date), ...completed, ...rest])
 const reopened = new Set(changedMeals)
 for (const date of knownDates) {
  const prior = dayState(repo, date)
  const requested = completed.has(date) ? 'complete' : 'open'
  if (!migrating && requested === 'complete' && prior.recordingStatus !== 'complete' && repo.list('meal', date, date).some(row => row.status === 'draft')) {
   throw Object.assign(Error('请先处理当天的餐食草稿，再标记为记完。'), {status:422})
  }
  const recordingStatus = !migrating && reopened.has(date) ? 'open' : requested
  if (prior.recordingStatus !== recordingStatus || prior.isRestDay !== rest.has(date)) {
   repo.put('day', date, { ...prior, recordingStatus, isRestDay: rest.has(date), version: prior.version + 1, updatedAt: now })
   reopened.delete(date)
  }
 }
 if (!migrating) reopenDays(repo, [...reopened], now)
 repo.setState(migrating ? revision : revision + 1, now)
 return true
}

export function migrateLegacy(db) {
 for (const row of db.prepare('SELECT * FROM health_logs').all()) {
  writeLegacy(repository(db, row.owner_id), row.revision, JSON.parse(row.payload), row.updated_at, true)
 }
}

export function legacyStorage(db) {
 const repo = repository(db)
 return {
  load: () => transact(db, () => legacySnapshot(repo), false),
  save: (revision, data, now, webVersion) => transact(db, () => {
   if (!writeLegacy(repo, revision, data, now, false, webVersion)) return null
   return { revision: revision + 1, updatedAt: now, data: JSON.parse(legacySnapshot(repo).payload) }
  }),
  mergeNothing: (data, dryRun, now) => transact(db, () => {
   const before = repo.state()
   const counts = { added: 0, updated: 0, skipped: 0 }
   for (const [legacy, kind] of [['workouts', 'workout'], ['activity', 'activity']]) {
    const seen = new Set()
    for (const row of data[legacy]) {
     const key = keyOf(kind, row), existing = repo.get(kind, key, true)
     if (seen.has(key) || existing?.deletedAt || (existing && (kind === 'workout' || time(row.asOf) <= existing.value.asOf))) {
      counts.skipped++
      continue
     }
     seen.add(key)
     counts[existing ? 'updated' : 'added']++
     if (!dryRun) repo.put(kind, key, convert(kind, row, now, existing?.value, 'nothing'))
    }
   }
   if (dryRun || !(counts.added || counts.updated)) return { ...counts, ...before }
   return { ...counts, revision: repo.setState(before.revision + 1, now), updatedAt: now }
  }, !dryRun)
 }
}

import { add, today } from '../../src/lib.js'
import { activeTarget } from './legacy.js'
import { fail, mergePatch, validateSchema } from './protocol.js'
import { BASELINE, canonical, dayState, digest, newRecord, reopenDays } from './store.js'
import { dailySummary, summaries, trends } from './summary.js'
import { loadImage, saveImage } from './media.js'

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const dateOf = row => row.date ?? row.effectiveFrom
const detail = data => ({ body: { data } })
const rangeDefault = to => to < '0001-01-30' ? '0001-01-01' : add(to, -29)
export function dateRange(query, maxDays = 366) {
 const to = query.to ?? today(), from = query.from ?? rangeDefault(to)
 const size = (Date.parse(to) - Date.parse(from)) / 86400_000 + 1
 if (size < 1 || size > maxDays || from < '0001-01-01') fail(400, 'INVALID_DATE_RANGE', `Use a date range of at most ${maxDays} days.`)
 return [from, to]
}

function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function listPage(rows, kind, query) {
 const { limit = 50, cursor, ...filters } = query
 const hash = digest(canonical({ kind, filters }))
 const key = row => [dateOf(row), row.createdAt, row.id]
 const order = (a, b) => compare(b[0], a[0]) || compare(b[1], a[1]) || compare(b[2], a[2])
 let last
 if (cursor !== undefined) {
  try {
   const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
   if (encodeCursor(decoded) !== cursor || decoded.hash !== hash || !Array.isArray(decoded.last) || decoded.last.length !== 3 || decoded.last.some(value => typeof value !== 'string')) throw Error()
   last = decoded.last
  } catch { fail(400, 'INVALID_CURSOR', 'The cursor is invalid or belongs to different filters.') }
 }
 const results = rows.sort((a, b) => order(key(a), key(b))).filter(row => !last || order(key(row), last) > 0).slice(0, limit + 1)
 const hasMore = results.length > limit
 const data = results.slice(0, limit)
 return { body: { data, page: { hasMore, nextCursor: hasMore ? encodeCursor({ hash, last: key(data.at(-1)) }) : null } } }
}

function linkedMeals(repo, id) {
 return repo.list('meal').filter(row => row.mediaIds.includes(id)).map(row => row.id).sort()
}
function mediaView(repo, row) {
 return { ...row, linkedMealIds: linkedMeals(repo, row.id) }
}
export function etag(kind, record) {
 const related = kind === 'media' ? ':' + digest(canonical(record.linkedMealIds)).slice(0, 16) : ''
 return `"${kind}:${encodeURIComponent(record.id ?? record.date)}:v${record.version}${related}"`
}
function resource(kind, data, status = 200, location) {
 return { ...detail(data), status, headers: { ETag: etag(kind, data), ...(location ? { Location: location } : {}) } }
}
function checkMatch(request, kind, value, create = false) {
 const ifMatch = request.headers.get('if-match'), ifNoneMatch = request.headers.get('if-none-match')
 if (!ifMatch && !ifNoneMatch) fail(428, 'PRECONDITION_REQUIRED', 'Supply the current If-Match ETag or the applicable creation condition.')
 if (ifMatch && ifNoneMatch) fail(400, 'INVALID_PRECONDITION', 'Send only one conditional header.')
 if (create && ifNoneMatch === '*' && !value) return
 if (!ifMatch || !value || ifMatch !== etag(kind, value)) fail(412, 'VERSION_CONFLICT', 'The record version or existence has changed.')
}
function find(repo, kind, key) {
 const value = repo.get(kind, key)?.value
 if (!value) fail(404, 'NOT_FOUND', 'The requested record does not exist.')
 return kind === 'media' ? mediaView(repo, value) : value
}
function requireSource(input, clientId) {
 if (input.source.client !== clientId) fail(403, 'SOURCE_CLIENT_MISMATCH', 'source.client must match the authenticated clientId.')
}
function checkMedia(repo, previous, value, scopes) {
 for (const id of value.mediaIds) {
  if (previous?.mediaIds.includes(id)) continue
  if (!scopes.includes('media:read')) fail(403, 'INSUFFICIENT_SCOPE', 'Linking images requires media:read.')
  find(repo, 'media', id)
 }
}

function normalize(kind, input) {
 const value = { ...input }
 if (kind === 'meal') {
  value.time ??= null
  value.note ??= null
  value.items = (value.items ?? []).map(item => ({ ...item, quantityText: item.quantityText ?? null }))
  value.mediaIds ??= []
  value.nutrition = { kcal: null, proteinGrams: null, carbsGrams: null, fatGrams: null, kcalRange: null, ...value.nutrition }
  const { kcal, isEstimate, kcalRange } = value.nutrition
  if (kcalRange && (!isEstimate || kcal === null || kcal < kcalRange.min || kcal > kcalRange.max)) fail(422, 'VALIDATION_FAILED', 'The estimate range must contain the recorded calories.', { errors: [{ pointer: '/nutrition/kcalRange', code: 'INVALID_RANGE' }] })
 } else if (kind === 'measurement') {
  for (const key of ['time', 'weightKg', 'bodyFatPct', 'waistCm', 'note']) value[key] ??= null
 } else if (kind === 'workout') {
  value.activeKcal ??= null
  value.reviewRequired ??= false
  value.note ??= null
 } else if (kind === 'media') {
  value.capturedAt ??= null
  value.caption ??= null
 }
 return value
}
const inputSchema = { meal: 'MealInput', measurement: 'MeasurementInput', workout: 'WorkoutInput' }
function mealReceipt(repo, row, previousDate, status, location) {
 const previousDateSummary = previousDate && previousDate !== row.date ? dailySummary(repo, previousDate) : null
 return { ...detail({ meal: row, mealEtag: etag('meal', row), daySummary: dailySummary(repo, row.date), previousDateSummary }), status,
  headers: location ? { Location: location } : {} }
}
function receipt(repo, kind, row, status, location, previousDate) {
 if (kind === 'meal') return mealReceipt(repo, row, previousDate, status, location)
 return resource(kind, kind === 'media' ? mediaView(repo, row) : row, status, location)
}

function create(repo, kind, body, now, auth, image) {
 requireSource(body, auth.clientId)
 const input = normalize(kind, body)
 const fingerprint = digest(canonical({ input, image: image?.inputDigest ?? null }))
 const source = repo.source(kind, input.source)
 if (source?.deleted_at) fail(410, 'SOURCE_RECORD_DELETED', 'This source record was deleted.')
 if (source) {
  if (source.fingerprint !== fingerprint) fail(409, 'EXTERNAL_ID_CONFLICT', 'This source id was previously used with different data.')
  return receipt(repo, kind, find(repo, kind, source.record_key), 200)
 }
 const base = newRecord(kind, now)
 const row = { ...base, ...input }
 if (kind === 'workout') row.origin = 'manual'
 if (kind === 'meal') checkMedia(repo, null, row, auth.scopes)
 if (kind === 'media') {
  saveImage(repo, image)
  Object.assign(row, image.properties, { contentUrl: `/api/v1/media/${row.id}/content` })
 }
 repo.put(kind, row.id, row)
 repo.addSource(kind, row.source, row.id, fingerprint)
 if (kind === 'meal') reopenDays(repo, [row.date], now)
 const collections = { meal: 'meals', media: 'media', workout: 'workouts', measurement: 'measurements' }
 return { ...receipt(repo, kind, row, 201, `/api/v1/${collections[kind]}/${row.id}`), changed: true }
}

function editableInput(kind, row) {
 if (kind === 'media') {
  const { date, purpose, capturedAt, caption } = row
  return { date, purpose, capturedAt, caption }
 }
 const { id, version, createdAt, updatedAt, origin, ...input } = row
 return input
}

function patch(repo, kind, key, body, now, request, auth) {
 const previous = find(repo, kind, key)
 checkMatch(request, kind, previous)
 const input = normalize(kind, mergePatch(editableInput(kind, previous), body))
 if (kind !== 'media') validateSchema(inputSchema[kind], input, true)
 if (kind === 'meal') checkMedia(repo, previous, input, auth.scopes)
 const { linkedMealIds, ...stored } = previous
 const row = { ...stored, ...input }
 if (canonical(row) === canonical(stored)) return receipt(repo, kind, stored, 200)
 Object.assign(row, newRecord(kind, now, previous))
 repo.put(kind, key, row)
 if (kind === 'meal') reopenDays(repo, [previous.date, row.date], now)
 return { ...receipt(repo, kind, row, 200, undefined, previous.date), changed: true }
}

function remove(repo, kind, key, now, request) {
 const row = find(repo, kind, key)
 checkMatch(request, kind, row)
 if (kind === 'media' && row.linkedMealIds.length) {
  fail(409, 'MEDIA_IN_USE', 'This image is still linked to meals.', { linkedMealIds: row.linkedMealIds })
 }
 if (kind === 'target' && row.provenance === 'legacy_unknown_start') fail(409, 'IMMUTABLE_BASELINE', 'The migrated target baseline is immutable.')
 const removed = repo.remove(kind, key, row, now)
 const data = { id: removed.id, version: removed.version, deleted: true }
 if (kind === 'meal') {
  reopenDays(repo, [row.date], now)
  data.affectedDates = [row.date]
  data.daySummaries = [dailySummary(repo, row.date)]
 }
 if (kind === 'target') {
  const next = repo.list('target').filter(target => target.effectiveFrom > key).sort((a, b) => compare(a.effectiveFrom, b.effectiveFrom))[0]
  data.affectedRange = { from: key, to: next ? add(next.effectiveFrom, -1) : null }
 }
 return { ...detail(data), changed: true }
}

function listRecords(repo, kind, query) {
 if (Boolean(query.sourceClient) !== Boolean(query.externalId) || query.sourceClient === '' || query.externalId === '') fail(400, 'INVALID_QUERY', 'Supply both sourceClient and externalId.')
 const unrestricted = query.sourceClient && !query.from && !query.to
 const [from, to] = unrestricted ? [null, null] : dateRange(query)
 let rows = repo.list(kind, from, to)
 if (query.sourceClient) rows = rows.filter(row => row.source.client === query.sourceClient && row.source.externalId === query.externalId)
 if (kind === 'meal') {
  const term = query.q?.toLowerCase()
  rows = rows.filter(row => (query.status === 'all' || row.status === query.status) && (!query.mealType || row.mealType === query.mealType)
   && (query.hasMedia === undefined || Boolean(row.mediaIds.length) === query.hasMedia)
   && (!term || [row.description, row.note, ...row.items.map(item => item.name)].some(text => text?.toLowerCase().includes(term))))
 }
 if (kind === 'measurement' && query.metric) rows = rows.filter(row => row[query.metric] != null)
 if (kind === 'media') {
  const links = new Map()
  for (const row of repo.list('meal')) for (const id of row.mediaIds) {
   if (!links.has(id)) links.set(id, [])
   links.get(id).push(row.id)
  }
  rows = rows.filter(row => !query.purpose || row.purpose === query.purpose).map(row => ({ ...row, linkedMealIds: (links.get(row.id) ?? []).sort() }))
  if (query.linked !== undefined) rows = rows.filter(row => Boolean(row.linkedMealIds.length) === query.linked)
 }
 if (kind === 'target') {
  const baseline = activeTarget(repo.list('target'), from)
  if (baseline && !rows.some(row => row.id === baseline.id)) rows.push(baseline)
 }
 return listPage(rows, kind, { ...query, from, to })
}

function getDay(repo, date) {
 const state = dayState(repo, date)
 return detail({ state, stateEtag: etag('day', state), summary: dailySummary(repo, date) })
}
function putDay(repo, date, now, body, request) {
 const state = dayState(repo, date)
 checkMatch(request, 'day', state)
 if (body.recordingStatus === 'complete') {
  const summary = dailySummary(repo, date)
  if (summary.draftMealCount) fail(422, 'UNRESOLVED_DRAFTS', 'Resolve meal drafts before completing the day.')
  if (body.intakeMode === 'meals' && !summary.recordedMealCount) fail(422, 'VALIDATION_FAILED', 'Record a meal or an explicit daily total first.')
 }
 repo.put('day', date, { ...state, ...body, note: body.note ?? null, isRestDay: body.isRestDay ?? false, version: state.version + 1, updatedAt: now })
 return { ...getDay(repo, date), changed: true }
}

function putDated(repo, kind, key, body, now, request, auth) {
 const previous = repo.get(kind, key)?.value
 checkMatch(request, kind, previous, true)
 const base = newRecord(kind, now, previous ?? repo.get(kind, key, true)?.value)
 let row
 if (kind === 'target') {
  if (key === BASELINE) fail(409, 'IMMUTABLE_BASELINE', 'The baseline date is reserved.')
  row = { ...base, ...body, effectiveFrom: key, note: body.note ?? null, provenance: 'user' }
 } else {
  requireSource(body, auth.clientId)
  row = { ...base, ...body, date: key, isPartial: !body.asOf.startsWith('23:59'), completenessBasis: 'timestamp_heuristic' }
 }
 repo.put(kind, key, row)
 const collection = kind === 'activity' ? 'activity' : 'targets'
 return { ...resource(kind, row, previous ? 200 : 201, previous ? undefined : `/api/v1/${collection}/${key}`), changed: true }
}

export const collections = { meals: 'meal', media: 'media', workouts: 'workout', measurements: 'measurement', activity: 'activity', targets: 'target' }
export function recordOperation(ctx) {
 const { repo, kind, key, method, now, body, request, auth, query, image, segment, tail } = ctx
 if (segment === 'days') {
  if (method === 'PUT') return putDay(repo, key, now, body, request)
  return tail === 'state' ? resource('day', dayState(repo, key)) : getDay(repo, key)
 }
 if (segment === 'summaries') return detail(summaries(repo, ...dateRange(query), query.groupBy))
 if (segment === 'trends') return detail(trends(repo, ...dateRange(query, 1827), query.groupBy, query.metric))
 if (tail === 'content') {
  const row = find(repo, 'media', key)
  const bytes = loadImage(repo, row)
  if (!bytes) fail(503, 'TEMPORARILY_UNAVAILABLE', 'The image bytes are unavailable.')
  return { bytes, headers: { 'Content-Type': row.contentType, 'Content-Length': String(bytes.length) } }
 }
 if (method === 'GET') return key ? resource(kind, find(repo, kind, key)) : listRecords(repo, kind, query)
 if (method === 'POST') return create(repo, kind, body, now, auth, image)
 if (method === 'PATCH') return patch(repo, kind, key, body, now, request, auth)
 if (method === 'PUT') return putDated(repo, kind, key, body, now, request, auth)
 return remove(repo, kind, key, now, request)
}

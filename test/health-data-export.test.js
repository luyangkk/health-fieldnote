import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { openDatabase } from '../selfhost/sqlite.js'
import { createToken } from '../selfhost/v1/tokens.js'
import { createV1Handler } from '../selfhost/v1/router.js'
import { legacyStorage } from '../selfhost/v1/legacy.js'
import { repository, newRecord } from '../selfhost/v1/store.js'
import { createHealthExportHandler, healthExportPath } from '../selfhost/health-data-export.js'
import { importLimit } from '../selfhost/health-export/parse.js'
import { validate } from '../src/lib.js'

// Synthetic values and UUIDs only; follows the user's Health Data Export 1.4
// Raw/Single File structure without copying their file or device details.
const Q = 'HKQuantityTypeIdentifier'
const date = '2030-02-03'
const exportDate = date + 'T12:00:00Z'
const device = { name: 'Synthetic Health Source', bundle_identifier: 'test.health', device: 'Test Device' }
const clone = value => JSON.parse(JSON.stringify(value))
const point = (id, value, unit, start = date + 'T00:00:00Z', end = start) => ({ id, value, unit, start_date: start, end_date: end, timestamp: start, provenance: 'reported', source: device })
const metric = (id, points, unit) => ({ id: Q + id, display_name: id, category: 'Test', unit, aggregation_level: 'raw', data_points: points })
const webhookSpec = JSON.parse(readFileSync(new URL('../docs/api/health-data-export.openapi.json', import.meta.url)))
const operation = webhookSpec.paths['/api/import/health-data-export'].post
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
const validateRequest = ajv.compile(operation.requestBody.content['application/json'].schema)
const validateResult = ajv.compile(operation.responses['200'].content['application/json'].schema)
function fixture() {
 return { export_date: exportDate, date_range: { days: 7, start: '2030-01-28T16:00:00Z', end: exportDate },
  metadata: { app_version: '1.4', aggregation_level: 'raw', export_format: 'json' },
  metrics: [metric('BodyMass', [point('weight-1', 70.25, 'kg')], 'kg'), metric('BodyFatPercentage', [point('fat-1', .215, '%')], '%'),
   metric('StepCount', [point(undefined, 1000, 'count', date + 'T00:00:00Z', date + 'T01:00:00Z')], 'count'),
   metric('ActiveEnergyBurned', [point(undefined, 100, 'kcal', date + 'T00:00:00Z', date + 'T01:00:00Z')], 'kcal'),
   metric('BasalEnergyBurned', [point(undefined, 500, 'kcal', date + 'T00:00:00Z', date + 'T01:00:00Z')], 'kcal'),
   metric('HeartRate', [point('ignored-heart', 65, 'bpm')], 'bpm')], category_metrics: [], sleep_summaries: [],
  workouts: [{ id: 'workout-1', type: 'strength_training', display_name: 'Strength Training', duration: 1800, energy: 150, energy_unit: 'kcal',
   start_date: date + 'T01:00:00Z', end_date: date + 'T01:30:00Z', source: device,
   route: [{ latitude: 1, longitude: 2 }], heart_rate: { samples: [{ value: 75 }] } }] }
}
function setup(t) {
 const db = openDatabase(':memory:')
 t.after(() => db.close())
 const token = createToken(db, 'health-data-export', ['records:read', 'records:write', 'records:delete'])
 let now = Date.parse(exportDate) + 3600_000
 const handle = createHealthExportHandler(db, () => now)
 const v1 = createV1Handler(db, () => now)
 const repo = repository(db)
 const send = (data = fixture(), options = {}) => handle(new Request('https://fieldnote.test' + healthExportPath + (options.query ?? ''), {
  method: options.method ?? 'POST', headers: { authorization: 'Bearer ' + token.token, 'content-type': 'application/json', ...options.headers },
  ...((options.method ?? 'POST') === 'POST' ? { body: options.raw ?? JSON.stringify(data) } : {}) }))
 const call = async (...args) => {
  const response = await send(...args), body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  assert.ok(validateResult(body), JSON.stringify(validateResult.errors))
  return body.data
 }
 const api = (method, path, data, headers = {}) => v1(new Request('https://fieldnote.test/api/v1' + path, { method,
  headers: { authorization: 'Bearer ' + token.token, 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json', 'x-fieldnote': '1', 'idempotency-key': randomUUID(), ...headers },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }) }))
 return { db, token, handle, repo, send, call, api, clock: value => { now = Date.parse(value) } }
}

test('raw export creates normalized records, stays visible to the browser, and repeated overlapping windows never accumulate', async t => {
 const { db, repo, call } = setup(t)
 const input = fixture(), result = await call(input)
 assert.ok(validateRequest(input), JSON.stringify(validateRequest.errors))
 assert.equal(result.added, 4)
 assert.equal(result.updated, 0)
 assert.equal(result.changed, true)
 assert.equal(result.revision, 1)
 assert.equal(result.ignored, 1)
 assert.ok(result.warnings.includes('MISSING_EXERCISE_TIME'))
 const weight = repo.list('measurement').find(row => row.weightKg !== null)
 const fat = repo.list('measurement').find(row => row.bodyFatPct !== null)
 assert.equal(weight.weightKg, 70.25)
 assert.equal(weight.time, '08:00:00')
 assert.equal(fat.bodyFatPct, 21.5)
 assert.equal(repo.list('workout')[0].durationMinutes, 30)
 assert.equal(repo.list('workout')[0].origin, 'health-data-export')
 const activity = repo.get('activity', date).value
 assert.equal(activity.steps, 1000)
 assert.equal(activity.totalKcal, 600)
 assert.equal(activity.durationMinutes, null)
 assert.equal(activity.isPartial, true)
 const repeated = await call(input)
 assert.equal(repeated.changed, false)
 assert.equal(repeated.skipped, 4)
 assert.equal(repeated.revision, 1)
 input.export_date = date + 'T12:10:00Z'
 input.date_range.end = input.export_date
 input.metrics.reverse()
 const unchanged = await call(input)
 assert.equal(unchanged.changed, false, 'export time/order alone is not a data update')
 assert.deepEqual(repo.get('activity', date).value, activity)
 assert.equal(repo.list('measurement').length, 2)
 const journal = JSON.parse(legacyStorage(db).load().payload)
 assert.equal(validate(journal).activity[0].minutes, null)
 assert.equal(validate(journal).workouts[0].source, 'Apple 健康')
 const stored = db.prepare('SELECT payload FROM fieldnote_records').all().map(row => row.payload).join('')
 for (const omitted of ['latitude', 'longitude', 'heart_rate', 'bundle_identifier', 'Test Device']) assert.ok(!stored.includes(omitted))
})

test('newer changed samples update in place and older exports cannot roll back corrections', async t => {
 const { call, repo, db } = setup(t)
 const before = fixture()
 await call(before)
 const ids = repo.list('measurement').map(row => row.id).sort()
 const updated = clone(before)
 updated.export_date = date + 'T12:10:00Z'
 updated.metrics[0].data_points[0].value = 70.5
 updated.metrics[2].data_points[0].value = 800 // A corrected total can decrease.
 updated.workouts[0].duration = 1740
 const result = await call(updated)
 assert.equal(result.updated, 3)
 assert.equal(result.added, 0)
 assert.equal(result.revision, 2)
 assert.deepEqual(repo.list('measurement').map(row => row.id).sort(), ids)
 assert.equal(repo.get('activity', date).value.steps, 800)
 assert.equal(repo.list('workout')[0].durationMinutes, 29)
 const stale = await call(before)
 assert.equal(stale.stale, 4)
 assert.equal(stale.changed, false)
 assert.equal(stale.revision, 2)
 assert.equal(repo.get('activity', date).value.steps, 800)
 assert.equal(db.prepare('SELECT count(*) AS n FROM fieldnote_health_imports').get().n, 4)
})

test('same timestamp conflicts roll back the complete batch; duplicate IDs cannot hide conflicting samples', async t => {
 const { call, send, repo, db } = setup(t)
 await call()
 const bad = fixture()
 bad.metrics[0].data_points.unshift(point('new-weight', 72, 'kg', date + 'T02:00:00Z'))
 bad.metrics[1].data_points[0].value = .22
 let response = await send(bad)
 assert.equal(response.status, 409)
 assert.equal((await response.json()).code, 'EXPORT_VERSION_CONFLICT')
 assert.equal(repo.list('measurement').length, 2)
 assert.equal(repo.state().revision, 1)
 assert.equal(db.prepare('SELECT count(*) AS n FROM fieldnote_health_imports').get().n, 4)
 const duplicate = fixture()
 duplicate.metrics[0].data_points.push({ ...duplicate.metrics[0].data_points[0], value: 73 })
 response = await send(duplicate)
 assert.equal(response.status, 422)
 assert.equal(repo.list('measurement').length, 2)
})

test('manual edits and deletion tombstones survive new exports and retries', async t => {
 const { call, repo, api } = setup(t)
 await call()
 const weight = repo.list('measurement').find(row => row.weightKg !== null)
 let response = await api('GET', '/measurements/' + weight.id)
 response = await api('PATCH', '/measurements/' + weight.id, { weightKg: 71 }, { 'if-match': response.headers.get('etag') })
 assert.equal(response.status, 200)
 const workout = repo.list('workout')[0]
 response = await api('GET', '/workouts/' + workout.id)
 response = await api('DELETE', '/workouts/' + workout.id, undefined, { 'if-match': response.headers.get('etag') })
 assert.equal(response.status, 200)
 const newer = fixture()
 newer.export_date = date + 'T12:10:00Z'
 newer.metrics[0].data_points[0].value = 72
 newer.workouts[0].energy = 160
 const result = await call(newer)
 assert.equal(result.changed, false)
 assert.equal(result.conflicts, 2)
 assert.equal(repo.get('measurement', weight.id).value.weightKg, 71)
 assert.equal(repo.list('workout').length, 0)
 assert.ok(result.warnings.includes('DELETED_RECORD_PRESERVED'))
})

test('different tokens and clients, simultaneous requests, and duplicate rows cannot duplicate the same sample', async t => {
 const { db, token, handle, call, repo } = setup(t)
 const [a, b] = await Promise.all([call(), call()])
 assert.equal(a.added + b.added, 4)
 assert.equal(repo.state().revision, 1)
 const other = createToken(db, 'another-client', ['records:write'])
 const response = await handle(new Request('https://fieldnote.test' + healthExportPath, { method: 'POST',
  headers: { authorization: 'Bearer ' + other.token, 'content-type': 'application/json' }, body: JSON.stringify(fixture()) }))
 assert.equal(response.status, 200)
 assert.equal((await response.json()).data.changed, false)
 const duplicate = fixture()
 duplicate.metrics[0].data_points.push(clone(duplicate.metrics[0].data_points[0]))
 duplicate.metrics[2].data_points.push(clone(duplicate.metrics[2].data_points[0]))
 assert.equal((await call(duplicate)).changed, false)
 assert.equal(repo.get('activity', date).value.steps, 1000)
 assert.equal(repo.list('measurement')[0].source.client, token.clientId)
})

test('preview and sample-free tests write neither records nor freshness watermarks', async t => {
 const { call, repo, db, send } = setup(t)
 const preview = await call(fixture(), { query: '?dryRun=true' })
 assert.equal(preview.added, 4)
 assert.equal(preview.wouldChange, true)
 assert.equal(preview.changed, false)
 assert.equal(preview.revision, 0)
 assert.equal(repo.list('measurement').length, 0)
 assert.equal(db.prepare('SELECT count(*) AS n FROM fieldnote_health_imports').get().n, 0)
 assert.equal((await call({ test: true })).test, true)
 assert.equal((await call({ type: 'test', message: 'synthetic connectivity test' })).changed, false)
 assert.equal((await send({ ...fixture(), test: true })).status, 422)
 assert.equal((await call()).added, 4)
})

test('activity snapshots select one source, skip ambiguous overlaps, and never turn incomplete ranges into full days', async t => {
 const { call, repo } = setup(t)
 const input = fixture()
 input.metrics[2].data_points.push({ ...point(undefined, 900, 'count', date + 'T00:00:00Z', date + 'T01:00:00Z'), source: { name: 'Other Device' } })
 let result = await call(input)
 assert.ok(result.warnings.includes('MULTIPLE_ACTIVITY_SOURCES'))
 assert.ok([900, 1000].includes(repo.get('activity', date).value.steps))
 const changed = fixture()
 changed.export_date = date + 'T12:10:00Z'
 changed.metrics[2].data_points.push(point(undefined, 500, 'count', date + 'T00:30:00Z', date + 'T01:30:00Z'))
 result = await call(changed)
 assert.ok(result.warnings.includes('OVERLAPPING_ACTIVITY_SAMPLES'))
 assert.equal(result.updated, 0)
 const partial = fixture()
 partial.export_date = date + 'T12:20:00Z'
 partial.date_range.start = date + 'T00:00:00Z' // Beijing day starts at 16:00Z the day before.
 result = await call(partial)
 assert.ok(result.warnings.includes('INCOMPLETE_ACTIVITY_RANGE'))
 assert.equal(result.updated, 0)
})

test('full days, cross-midnight samples, percentage units and workout review flags are normalized', async t => {
 const { call, repo, clock } = setup(t)
 const input = fixture()
 input.date_range.end = date + 'T16:00:00Z'
 input.export_date = input.date_range.end
 clock('2030-02-03T17:00:00Z')
 for (const m of input.metrics.slice(2, 5)) {
  m.data_points = [point(undefined, m.data_points[0].value, m.unit, '2030-02-02T15:00:00Z', '2030-02-02T17:00:00Z')]
 }
 input.metrics[1].data_points[0].value = 21.5
 input.metrics.push(metric('AppleExerciseTime', [point(undefined, 1800, 's', '2030-02-02T15:00:00Z', '2030-02-02T17:00:00Z')], 's'))
 input.workouts[0].duration = 3600
 const result = await call(input)
 assert.ok(result.warnings.includes('WORKOUT_DURATION_REVIEW'))
 assert.equal(repo.list('workout')[0].reviewRequired, true)
 assert.equal(repo.list('measurement').find(row => row.bodyFatPct !== null).bodyFatPct, 21.5)
 const first = repo.get('activity', '2030-02-02').value
 assert.equal(first.steps, 500)
 assert.equal(first.durationMinutes, 15)
 assert.equal(first.isPartial, false)
})

test('existing Nothing/manual records are preserved instead of cross-source duplication or replacement', async t => {
 const { call, repo } = setup(t)
 const now = exportDate
 repo.put('workout', 'cmf:existing', { ...newRecord('workout', now, undefined, 'existing'), id: 'cmf:existing', date, time: '09:00:00', type: '力量训练', durationMinutes: 30, activeKcal: 150, source: { client: 'nothing', externalId: 'existing' }, origin: 'nothing' })
 repo.put('activity', date, { ...newRecord('activity', now), date, asOf: '20:00:00', steps: 5000, activeKcal: 200, totalKcal: 1500, durationMinutes: 30, source: { client: 'nothing', externalId: date } })
 const result = await call()
 assert.equal(result.conflicts, 2)
 assert.equal(repo.list('workout').length, 1)
 assert.equal(repo.get('activity', date).value.steps, 5000)
})

test('invalid auth, origin, format, time, units, body sizes and missing scopes fail without writes', async t => {
 const { send, repo, db } = setup(t)
 const readOnly = createToken(db, 'read-only', ['records:read'])
 const checks = [
  [{ headers: { authorization: '' } }, 401],
  [{ headers: { authorization: 'Bearer ' + readOnly.token } }, 403],
  [{ headers: { origin: 'https://foreign.test' } }, 403],
  [{ method: 'GET' }, 405],
  [{ headers: { 'content-type': 'text/plain' } }, 415],
  [{ raw: '{' }, 400],
  [{ headers: { 'content-length': String(importLimit + 1) } }, 413],
  [{ query: '?dryRun=maybe' }, 400],
 ]
 for (const [options, status] of checks) assert.equal((await send(fixture(), options)).status, status)
 const cases = [
  data => { data.metadata.aggregation_level = 'daily' },
  data => { data.metrics[0].data_points[0].unit = 'unknown' },
  data => { data.metrics[0].data_points[0].value = -1 },
  data => { data.metrics[0].data_points[0].start_date = '2030-02-03T24:00:00Z' },
  data => { data.export_date = '2030-02-04T00:00:00Z' },
 ]
 for (const mutate of cases) {
  const input = fixture(); mutate(input)
  assert.equal((await send(input)).status, 422)
 }
 assert.equal(repo.state().revision, 0)
 assert.equal(db.prepare('SELECT count(*) AS n FROM fieldnote_health_imports').get().n, 0)
})

test('schema and token revocation are enforced', async t => {
 const { call, send, db } = setup(t)
 await call()
 assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
 const tables = db.prepare("SELECT name FROM sqlite_schema WHERE name = 'fieldnote_health_imports'").all()
 assert.equal(tables.length, 1)
 db.prepare('UPDATE fieldnote_tokens SET revoked_at = ?').run(exportDate)
 const response = await send()
 assert.equal(response.status, 401)
 assert.equal((await response.json()).code, 'TOKEN_REVOKED')
})

test('request-rate limits and tokens revoked during an upload are enforced before writing', async t => {
 const { call, send, handle, token, db, repo } = setup(t)
 for (let i = 0; i < 30; i++) assert.equal((await call({ test: true })).test, true)
 const limited = await send({ test: true })
 assert.equal(limited.status, 429)
 assert.ok(Number(limited.headers.get('retry-after')) > 0)
 // Use a new token, and revoke it after initial authentication while reading.
 const second = createToken(db, token.clientId, ['records:write'])
 let started = false
 const body = new ReadableStream({ pull(controller) {
  if (started) return
  started = true
  db.prepare('UPDATE fieldnote_tokens SET revoked_at = ? WHERE id = ?').run(exportDate, second.tokenId)
  controller.enqueue(new TextEncoder().encode(JSON.stringify(fixture())))
  controller.close()
 } })
 const result = await handle(new Request('https://fieldnote.test' + healthExportPath, { method: 'POST',
  headers: { authorization: 'Bearer ' + second.token, 'content-type': 'application/json' }, body, duplex: 'half' }))
 assert.equal(result.status, 401)
 assert.equal(repo.state().revision, 0)
})

test('daily totals can be corrected downwards without changing their time, and an empty export does not delete old records', async t => {
 const { call, repo } = setup(t)
 // All samples are on a completed historical day.
 const shifted = fixture()
 shifted.metrics = shifted.metrics.filter(m => [Q+'StepCount', Q+'ActiveEnergyBurned', Q+'BasalEnergyBurned'].includes(m.id))
 for (const m of shifted.metrics) m.data_points = [point(undefined, 100, m.unit, '2030-02-02T00:00:00Z', '2030-02-02T01:00:00Z')]
 shifted.workouts = []
 await call(shifted)
 const existing = repo.get('activity', '2030-02-02').value
 assert.equal(existing.asOf, '23:59:59')
 shifted.export_date = date + 'T12:10:00Z'
 shifted.metrics[0].data_points[0].value = 80
 const result = await call(shifted)
 assert.equal(result.updated, 1)
 const corrected = repo.get('activity', '2030-02-02').value
 assert.equal(corrected.id, existing.id)
 assert.equal(corrected.asOf, existing.asOf)
 assert.equal(corrected.steps, 80)
 const empty = { export_date: date + 'T12:20:00Z', metrics: [], workouts: [] }
 assert.equal((await call(empty)).changed, false)
 assert.equal(repo.get('activity', '2030-02-02').value.steps, 80)
})

test('version 2 databases migrate once without changing existing records or tokens', () => {
 const directory = mkdtempSync(join(tmpdir(), 'fieldnote-health-migration-'))
 const path = join(directory, 'health.sqlite')
 let db
 try {
  db = openDatabase(path)
  const repo = repository(db)
  const original = { ...newRecord('measurement', exportDate), date, time: '08:00:00', weightKg: 70, bodyFatPct: null, waistCm: null, note: null, source: { client: 'web', externalId: 'synthetic' } }
  repo.put('measurement', original.id, original)
  repo.setState(3, exportDate)
  const token = createToken(db, 'existing-client', ['records:read'])
  db.exec('DROP TABLE fieldnote_health_imports; PRAGMA user_version=2;')
  db.close()
  db = openDatabase(path)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
  assert.deepEqual(repository(db).get('measurement', original.id).value, original)
  assert.equal(repository(db).state().revision, 3)
  assert.equal(db.prepare('SELECT client_id FROM fieldnote_tokens WHERE id = ?').get(token.tokenId).client_id, 'existing-client')
  db.close()
  db = openDatabase(path)
  assert.equal(db.prepare('SELECT count(*) AS n FROM fieldnote_health_imports').get().n, 0)
 } finally { db?.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('webhook works over HTTP with only Bearer auth, large JSON, and persistent deduplication after restart and backup restore', { timeout: 20_000 }, async () => {
 const directory = mkdtempSync(join(tmpdir(), 'fieldnote-health-export-'))
 const secret = join(directory, 'password'), database = join(directory, 'health.sqlite'), snapshot = join(directory, 'backup.sqlite')
 writeFileSync(secret, 'synthetic-password-12345678901234567890', { mode: 0o600 })
 const listener = createServer()
 listener.listen(0, '127.0.0.1')
 await once(listener, 'listening')
 const port = listener.address().port
 await new Promise(resolve => listener.close(resolve))
 const origin = 'http://127.0.0.1:' + port
 const env = { ...process.env, FIELDNOTE_ORIGIN: origin, FIELDNOTE_BIND: '127.0.0.1', PORT: String(port), FIELDNOTE_DB: database, FIELDNOTE_PASSWORD_FILE: secret }
 const { token } = JSON.parse(execFileSync(process.execPath, ['selfhost/token.js', 'create', 'health-data-export', 'records:read,records:write'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
 let child
 const start = async path => {
  child = spawn(process.execPath, ['selfhost/server.js'], { env: { ...env, FIELDNOTE_DB: path }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  for (let i = 0; i < 100; i++) {
   if (child.exitCode !== null) throw Error('Server exited: ' + stderr)
   try { if ((await fetch(origin + '/healthz')).ok) return } catch {}
   await delay(30)
  }
  throw Error('Server did not start: ' + stderr)
 }
 const stop = async () => {
  if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed }
 }
 try {
  await start(database)
  const input = JSON.parse(JSON.stringify(fixture()).replaceAll('2030-', '2020-'))
  input.unused_export_padding = 'x'.repeat(1_100_000) // Larger than the normal v1 JSON limit.
  const send = (body = input, headers = {}) => fetch(origin + healthExportPath, { method: 'POST',
   headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  let response = await send()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.added, 4)
  assert.equal((await send(input, { authorization: '' })).status, 401)
  assert.equal((await send(input, { origin: 'https://foreign.test' })).status, 403)
  assert.equal((await (await send({ test: true })).json()).data.test, true)
  await stop(); await start(database)
  response = await send()
  assert.equal((await response.json()).data.changed, false)
  execFileSync(process.execPath, ['selfhost/backup.js', snapshot], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  await stop(); await start(snapshot)
  const replay = (await (await send()).json()).data
  assert.equal(replay.revision, 1)
  assert.equal(replay.added, 0)
  assert.equal(replay.skipped, 4)
  const records = await fetch(origin + '/api/v1/measurements?from=2020-02-03&to=2020-02-03', { headers: { authorization: 'Bearer ' + token } })
  assert.equal((await records.json()).data.length, 2)
 } finally { await stop(); rmSync(directory, { recursive: true, force: true }) }
})

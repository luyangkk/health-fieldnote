import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import * as XLSX from 'xlsx'
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js'
import { nothingImportAPI } from '../selfhost/import-api.js'
import { binding } from '../selfhost/sqlite.js'
import { fresh } from '../src/lib.js'

const url = 'https://test.example/api/import/nothing'
const date = '2030-02-03'
const workout = { '发起时间': date + ' 08:14:00', '运动类型': '力量训练', '运动时长(分钟)': 42.5, '活动卡路里(千卡)': 142, 'GPS运动轨迹': 'must not persist' }
const activity = (asOf = '14:10:20', steps = 4321) => ({ '时间': date + ' ' + asOf, '步数(步)': steps, '总卡路里(千卡)': 1200, '活动卡路里(千卡)': 150, '运动时长(分钟)': 5 })
const request = (data, query = '', headers = {}) => new Request(url + query, { method: 'POST', headers: { 'x-fieldnote': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })
function setup(t) {
 const db = new DatabaseSync(':memory:')
 db.exec(readFileSync(new URL('../drizzle/0000_health_logs.sql', import.meta.url), 'utf8'))
 t.after(() => db.close())
 return { db, env: { DB: binding(db) }, load: () => db.prepare('SELECT * FROM health_logs').get() }
}
function excel(name, rows) {
 const workbook = XLSX.utils.book_new()
 XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name)
 return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }))
}
const upload = (file, password) => {
 const form = new FormData(); form.set('file', file)
 if (password) form.set('password', password)
 return new Request(url, { method: 'POST', headers: { 'x-fieldnote': '1' }, body: form })
}

test('Nothing import previews, deduplicates, preserves other data and takes later activity', async t => {
 const { db, env, load } = setup(t)
 const original = { ...fresh(), target: 2100, meals: [{ id: 'meal', date, type: '早餐', name: 'fixture', kcal: 400 }], rest: [date] }
 db.prepare('INSERT INTO health_logs VALUES (?, ?, ?, ?)').run('unraid-owner', 1, JSON.stringify(original), 'initial')
 const rows = { workouts: [workout, workout, { ...workout, '运动时长(分钟)': -1 }], activity: [activity()] }
 const preview = await (await nothingImportAPI(request(rows, '?dryRun=true'), env)).json()
 assert.deepEqual({ added: preview.added, skipped: preview.skipped, rejected: preview.rejected, revision: preview.revision }, { added: 2, skipped: 1, rejected: 1, revision: 1 })
 assert.equal(load().payload, JSON.stringify(original))
 const first = await (await nothingImportAPI(request(rows), env)).json()
 assert.equal(first.revision, 2)
 assert.equal(first.added, 2)
 const second = await (await nothingImportAPI(request(rows), env)).json()
 assert.equal(second.revision, 2)
 assert.equal(second.skipped, 3)
 assert.equal((await (await nothingImportAPI(request({ activity: [activity('12:00:00', 123)] }), env)).json()).updated, 0)
 assert.equal((await (await nothingImportAPI(request({ activity: [activity('23:59:55', 5000)] }), env)).json()).updated, 1)
 const stored = JSON.parse(load().payload)
 assert.equal(stored.activity[0].steps, 5000)
 assert.equal(stored.activity[0].partial, false)
 assert.equal(stored.target, 2100)
 assert.equal(stored.meals[0].kcal, 400)
 assert.deepEqual(stored.rest, [date])
 assert.ok(!load().payload.includes('must not persist'))
})

test('Nothing import accepts XLSX and encrypted ZIP, rejects wrong passwords and unrelated files', async t => {
 const { env, load } = setup(t)
 const bytes = excel('运动数据', [workout])
 assert.equal((await nothingImportAPI(upload(new File([bytes], '运动.xlsx')), env)).status, 200)
 const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
 await zip.add('健康数据今日活动_203002.xlsx', new Uint8ArrayReader(excel('今日活动', [activity()])), { password: 'fixture-password', useWebWorkers: false, level: 0 })
 const file = new File([await zip.close()], 'export.zip')
 assert.equal((await nothingImportAPI(upload(file, 'wrong'), env)).status, 400)
 assert.equal(load().revision, 1)
 assert.equal((await nothingImportAPI(upload(file, 'fixture-password'), env)).status, 200)
 assert.equal(load().revision, 2)
 assert.equal((await nothingImportAPI(upload(new File(['{}'], 'backup.json')), env)).status, 400)
})

test('Nothing import rejects CSRF, malformed or oversized input without writing', async t => {
 const { env, load } = setup(t)
 assert.equal((await nothingImportAPI(new Request(url), env)).status, 405)
 assert.equal((await nothingImportAPI(request({}, '', { origin: 'https://other.example' }), env)).status, 403)
 assert.equal((await nothingImportAPI(request({}, '', { 'x-fieldnote': '0' }), env)).status, 403)
 assert.equal((await nothingImportAPI(request({}, '?dryRun=1'), env)).status, 400)
 for (const value of [null, [], {}, { workouts: {} }, { meals: [] }, { workouts: [null, {}] }])
  assert.equal((await nothingImportAPI(request(value), env)).status, 400)
 assert.equal((await nothingImportAPI(request({}, '', { 'content-length': '1500001' }), env)).status, 413)
 const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_500_001)); controller.close() } })
 assert.equal((await nothingImportAPI(new Request(url, { method: 'POST', headers: { 'x-fieldnote': '1', 'content-type': 'application/json' }, body: oversized, duplex: 'half' }), env)).status, 413)
 assert.equal((await nothingImportAPI(new Request(url, { method: 'POST', headers: { 'x-fieldnote': '1', 'content-type': 'text/plain' }, body: '{}' }), env)).status, 415)
 assert.equal(load(), undefined)
})

test('Nothing import retries a concurrent update and never overwrites a newer revision', async t => {
 const { env, load } = setup(t)
 const base = env.DB
 let raced = false
 env.DB = { prepare(query) {
  const statement = base.prepare(query)
  return { bind(...args) {
   const bound = statement.bind(...args)
   if (query.startsWith('INSERT')) return { ...bound, async run() {
    if (!raced) {
     raced = true
     await base.prepare('INSERT INTO health_logs VALUES (?, ?, ?, ?)').bind('unraid-owner', 1, JSON.stringify({ ...fresh(), target: 2200 }), 'concurrent').run()
    }
    return bound.run()
   } }
   return bound
  } }
 } }
 const response = await nothingImportAPI(request({ workouts: [workout] }), env)
 assert.equal(response.status, 200)
 assert.equal((await response.json()).revision, 2)
 assert.equal(JSON.parse(load().payload).target, 2200)
 const conflicting = { DB: { prepare(query) {
  if (query.startsWith('SELECT')) return base.prepare(query)
  return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) }
 } } }
 assert.equal((await nothingImportAPI(request({ activity: [activity()] }), conflicting)).status, 409)
 assert.equal(load().revision, 2)
})

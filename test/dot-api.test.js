import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import sharp from 'sharp'
import { openDatabase } from '../selfhost/sqlite.js'
import { createV1Handler, maintainV1 } from '../selfhost/v1/router.js'
import { createToken } from '../selfhost/v1/tokens.js'

const spec = JSON.parse(readFileSync(new URL('../docs/api/openapi.json', import.meta.url)))
const schemaId = 'https://fieldnote.test/openapi'
const ajv = new Ajv({ strict: false, allErrors: true, multipleOfPrecision: 8 })
addFormats(ajv)
ajv.addSchema(spec, schemaId)
const coverage = new Set()
const allScopes = spec['x-scope-catalog'].join(',')
const DATE = '2026-11-25'
const TOMORROW = '2026-11-26'
const stamp = '2026-11-25T03:00:00.000Z'
const ranged = `from=${DATE}&to=${TOMORROW}`
const source = externalId => ({ client:'dot', externalId })
const auth = token => ({ authorization:`Bearer ${token}` })
const writeHeaders = (key = randomUUID()) => ({ 'x-fieldnote':'1', 'idempotency-key':key })
const problemCode = async (response, status, code) => {
 assert.equal(response.status, status)
 assert.match(response.headers.get('content-type'), /^application\/problem\+json/)
 assert.equal((await response.json()).code, code)
}

function verifyResponse(method, path, response, payload) {
 const pathname = path.split('?')[0]
 const template = Object.keys(spec.paths).find(route => new RegExp('^'+route.replaceAll('.', '\\.').replace(/\{\w+\}/g,'[^/]+')+'$').test(pathname))
 assert.ok(template, path)
 const operation = spec.paths[template][method.toLowerCase()]
 assert.ok(operation, `${method} ${path}`)
 const definition = operation.responses[String(response.status)]
 assert.ok(definition, `${method} ${path}: ${response.status} ${JSON.stringify(payload)}`)
 const contentType = response.headers.get('content-type').split(';')[0]
 let schema = definition.content[contentType]?.schema
 assert.ok(schema, `Unsupported response content type ${contentType}`)
 if(contentType === 'application/json') {
  schema = JSON.parse(JSON.stringify(schema), (key, value) => key === '$ref' ? schemaId + value : value)
  const validate = ajv.compile(schema)
  assert.ok(validate(payload), `${operation.operationId}: ${JSON.stringify(validate.errors)}`)
 }
 coverage.add(operation.operationId)
}

async function port() {
 const listener = createServer()
 listener.listen(0,'127.0.0.1')
 await once(listener,'listening')
 const address = listener.address()
 await new Promise(resolve => listener.close(resolve))
 return address.port
}

function originalDatabase(path) {
 const db = new DatabaseSync(path)
 db.exec(readFileSync(new URL('../drizzle/0000_health_logs.sql',import.meta.url),'utf8'))
 db.exec('PRAGMA user_version=1')
 const old = { version:1, target:2050, completed:[DATE], rest:[DATE],
  meals:[{ id:'legacy-meal',date:DATE,type:'早餐',name:'fixture',kcal:300 }],
  metrics:[{ id:'legacy-weight',date:DATE,weight:69.543 }], workouts:[],activity:[] }
 db.prepare('INSERT INTO health_logs VALUES (?, ?, ?, ?)').run('unraid-owner', 7, JSON.stringify(old), stamp)
 db.close()
}

function upload(bytes, identity = 'photo') {
 const form = new FormData()
 form.set('file',new File([bytes],'meal.png',{type:'image/png'}))
 form.set('date',DATE)
 form.set('purpose','meal')
 form.set('source',JSON.stringify(source(identity)))
 return form
}

test('all 37 dot operations, v1 migration, Basic compatibility, Nothing import, and image backup over HTTP', {timeout:35_000}, async t => {
 const directory = mkdtempSync(join(tmpdir(),'dot-api-'))
 const database = join(directory,'health.sqlite'), secret = join(directory,'password'), snapshot = join(directory,'backup.sqlite')
 const password = 'test_password_only_123456789abcdefgh'
 writeFileSync(secret,password)
 originalDatabase(database)
 const p = await port(), origin = `http://127.0.0.1:${p}`
 const env = {...process.env,PORT:String(p),FIELDNOTE_ORIGIN:origin,FIELDNOTE_BIND:'127.0.0.1',FIELDNOTE_DB:database,FIELDNOTE_PASSWORD_FILE:secret}
 const cli = (...args) => JSON.parse(execFileSync(process.execPath,['selfhost/token.js',...args],{env,encoding:'utf8'}))
 let dot = cli('create','dot',allScopes)
 const restricted = cli('create','viewer','records:read')
 assert.equal(cli('list').length,2)
 const basic = 'Basic '+Buffer.from('fieldnote:'+password).toString('base64')
 let child
 const stop = async () => {
  if(child?.exitCode===null) {
   const exited = once(child,'exit'); child.kill('SIGTERM'); await exited
  }
 }
 const start = async (file = database) => {
  child = spawn(process.execPath,['selfhost/server.js'],{env:{...env,FIELDNOTE_DB:file},stdio:'pipe'})
  let stderr = ''
  child.stderr.on('data',chunk=>stderr+=chunk)
  for(let i=0;i<100;i++) {
   if(child.exitCode!==null) throw Error(stderr)
   try { if ((await fetch(origin+'/healthz')).ok) return } catch {}
   await delay(50)
  }
  throw Error('Server failed to start '+stderr)
 }
 t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true})})
 await start()
 const send = (method, path, body, headers = {}, token = dot.token) => {
  const write = method !== 'GET'
  return fetch(origin+'/api/v1'+path,{method,headers:{...auth(token),...(write?writeHeaders():{}),
   ...(body && !(body instanceof FormData)?{'content-type':method==='PATCH'?'application/merge-patch+json':'application/json'}:{}),...headers},
   body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)})
 }
 const call = async (method, path, body, headers, status = 200) => {
  const response = await send(method,path,body,headers)
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(data)}`)
  verifyResponse(method,path,response,data)
  return { ...data, headers:response.headers, bytes:Buffer.isBuffer(data)?data:undefined }
 }
 const get = path => call('GET',path)
 const update = (path, body, etag) => call('PATCH',path,body,{'if-match':etag})
 const put = (path, body, etag, create = false) => call('PUT',path,body,create?{'if-none-match':'*'}:{'if-match':etag},create?201:200)
 const remove = (path, etag) => call('DELETE',path,undefined,{'if-match':etag})
 const create = (path, body) => call('POST',path,body,undefined,201)
 await problemCode(await send('GET','/me',undefined,{'authorization':basic}),401,'UNAUTHENTICATED')
 await problemCode(await send('GET','/me',undefined,{'origin':'https://foreign.test'}),403,'ORIGIN_FORBIDDEN')
 assert.equal((await get('/me')).data.clientId,'dot')
 assert.ok((await get('/capabilities')).data.features.includes('body-fat'))
 assert.equal((await get('/openapi.json')).openapi,'3.1.1')
 const dayUrl = '/days/'+DATE, dayStateUrl = dayUrl+'/state'
 let day = await get(dayUrl)
 assert.equal(day.data.summary.measurement.weightKg,69.543)
 assert.equal(day.data.summary.measurement.bodyFatPct,null)
 assert.equal(day.data.summary.intakeKcal,300)
 assert.equal(day.data.summary.targetKcal,2050)
 assert.equal(day.data.summary.targetHistoryKnown,false)
 assert.equal(day.headers.get('x-data-revision'),'7')
 const first = { date:DATE,time:'07:30:00',weightKg:70.25,bodyFatPct:21.5,source:source('measurement:1') }
 const second = { date:DATE,time:'08:00:00',bodyFatPct:21.25,source:source('measurement:2') }
 const measure = await create('/measurements',first)
 const later = await create('/measurements',second)
 await problemCode(await send('POST','/measurements',{date:DATE,bodyFatPct:100,source:source('invalid')}),422,'VALIDATION_FAILED')
 await problemCode(await send('POST','/measurements',{...first,source:{...first.source,client:'spoof'}}),403,'SOURCE_CLIENT_MISMATCH')
 await problemCode(await send('POST','/measurements',first,undefined,restricted.token),403,'INSUFFICIENT_SCOPE')
 const exact = await get('/measurements?sourceClient=dot&externalId=measurement%3A1')
 assert.equal(exact.data[0].id,measure.data.id)
 const fp = `/measurements?${ranged}&metric=bodyFatPct&limit=1`
 const page = await get(fp)
 assert.equal(page.data.length,1)
 assert.ok(page.page.hasMore)
 const next = await get(fp+'&cursor='+page.page.nextCursor)
 assert.equal(next.data.length,1)
 assert.notEqual(page.data[0].id,next.data[0].id)
 await problemCode(await send('GET',fp.replace('bodyFatPct','weightKg')+'&cursor='+page.page.nextCursor),400,'INVALID_CURSOR')
 day = await get(dayUrl)
 assert.equal(day.data.summary.measurement.bodyFatPct,21.25)
 assert.equal(day.data.summary.measurement.weightKg,70.25)
 const mPath = '/measurements/'+measure.data.id, laterPath = '/measurements/'+later.data.id
 const current = await get(mPath)
 const legacyMeasurement = await get('/measurements/legacy-weight')
 const annotated = await update('/measurements/legacy-weight',{note:'legacy precision'},legacyMeasurement.headers.get('etag'))
 assert.equal(annotated.data.weightKg,69.543)
 const edited = await update(mPath,{weightKg:70.5},current.headers.get('etag'))
 assert.equal(edited.data.bodyFatPct,21.5)
 await problemCode(await send('PATCH',mPath,{weightKg:70.7},{'if-match':current.headers.get('etag')}),412,'VERSION_CONFLICT')
 await problemCode(await send('PATCH',mPath,{weightKg:70.7}),428,'PRECONDITION_REQUIRED')
 const trend = await get(`/trends?${ranged}&metric=bodyFatPct`)
 assert.equal(trend.data.unit,'%')
 assert.equal(trend.data.buckets[0].last,21.25)
 assert.equal(trend.data.buckets[1].last,null)
 await remove(laterPath,later.headers.get('etag'))
 await problemCode(await send('POST','/measurements',second),410,'SOURCE_RECORD_DELETED')

 const png = await sharp({create:{width:16,height:12,channels:3,background:'#aaccee'}}).png().withMetadata({exif:{IFD0:{Artist:'private-fixture'}}}).toBuffer()
 await problemCode(await send('POST','/media',upload(Buffer.from('<svg/>'),'bad-photo')),415,'UNSUPPORTED_MEDIA_TYPE')
 const image = await create('/media',upload(png))
 const iPath = '/media/'+image.data.id
 await problemCode(await send('GET',iPath+'/content',undefined,undefined,restricted.token),403,'INSUFFICIENT_SCOPE')
 const raw = await get(iPath+'/content')
 assert.equal((await sharp(raw.bytes).metadata()).exif,undefined)
 assert.equal(createHash('sha256').update(raw.bytes).digest('hex'),image.data.sha256)
 const imageEdit = await update(iPath,{caption:'fixture caption'},image.headers.get('etag'))
 assert.equal(imageEdit.data.caption,'fixture caption')
 const food = {date:DATE,mealType:'lunch',description:'Photo lunch',status:'draft',nutrition:{kcal:null,isEstimate:true},nutritionBasis:'photo_estimate',mediaIds:[image.data.id],source:source('meal:1')}
 const originalKey = randomUUID()
 const meal = await call('POST','/meals',food,writeHeaders(originalKey),201)
 const fPath = '/meals/'+meal.data.meal.id
 assert.equal(meal.data.daySummary.intakeKcal,300)
 const replay = await call('POST','/meals',food,writeHeaders(originalKey),201)
 assert.equal(replay.headers.get('idempotency-replayed'),'true')
 assert.equal(replay.data.meal.id,meal.data.meal.id)
 assert.equal((await call('POST','/meals',food)).data.meal.id,meal.data.meal.id)
 await problemCode(await send('POST','/meals',{...food,description:'Conflict'},writeHeaders(originalKey)),409,'IDEMPOTENCY_CONFLICT')
 await problemCode(await send('POST','/meals',{...food,description:'Conflict'}),409,'EXTERNAL_ID_CONFLICT')
 assert.equal((await get(`/meals?${ranged}&status=draft&hasMedia=true&q=lunch`)).data.length,1)
 const linkedImage = await get(iPath)
 assert.deepEqual(linkedImage.data.linkedMealIds,[meal.data.meal.id])
 assert.equal((await get(`/media?${ranged}&linked=true&purpose=meal`)).data.length,1)
 await problemCode(await send('DELETE',iPath,undefined,{'if-match':linkedImage.headers.get('etag')}),409,'MEDIA_IN_USE')
 const dayInput = {intakeMode:'total',dailyTotalKcal:0,totalIsEstimate:false,recordingStatus:'complete'}
 const state = await get(dayStateUrl)
 await problemCode(await send('PUT',dayStateUrl,dayInput,{'if-match':state.headers.get('etag')}),422,'UNRESOLVED_DRAFTS')
 const foodGet = await get(fPath)
 const foodEdit = await update(fPath,{status:'recorded',nutrition:{kcal:650,kcalRange:{min:500,max:700}}},foodGet.headers.get('etag'))
 assert.equal(foodEdit.data.daySummary.intakeKcal,950)
 await problemCode(await send('PATCH',fPath,{nutrition:{kcal:900}},{'if-match':foodEdit.data.mealEtag}),422,'VALIDATION_FAILED')
 const total = await put(dayStateUrl,dayInput,(await get(dayStateUrl)).headers.get('etag'))
 assert.equal(total.data.summary.intakeKcal,0)
 assert.equal(total.data.summary.mealSubtotalKcal,950)
 const moved = await update(fPath,{date:TOMORROW},foodEdit.data.mealEtag)
 assert.equal(moved.data.previousDateSummary.recordingStatus,'open')
 assert.equal(moved.data.daySummary.intakeKcal,650)
 const grouped = await get(`/summaries?${ranged}&groupBy=month`)
 assert.equal(grouped.data.totals.recordedDays,2)
 assert.equal(grouped.data.totals.recordedIntakeKcal,650)

 // Keep each test batch below the per-token write limit while retaining the client identity.
 dot = cli('create','dot',allScopes)
 assert.equal((await get('/me')).data.clientId,'dot')
 const exercise = await create('/workouts',{date:DATE,time:'12:00:00',type:'strength',durationMinutes:50,source:source('workout')})
 const wPath = '/workouts/'+exercise.data.id
 assert.ok((await get(`/workouts?${ranged}`)).data.some(row=>row.id===exercise.data.id))
 const w = await get(wPath)
 const wEdit = await update(wPath,{durationMinutes:51.25},w.headers.get('etag'))
 await remove(wPath,wEdit.headers.get('etag'))
 const activity = {asOf:'14:00:00',steps:8400,activeKcal:450,totalKcal:1700,durationMinutes:55,source:source('activity')}
 const aPath = '/activity/'+DATE
 await put(aPath,activity,null,true)
 assert.equal((await get(`/activity?${ranged}`)).data[0].steps,8400)
 const existingActivity = await get(aPath)
 assert.equal(existingActivity.data.isPartial,true)
 const finalActivity = await put(aPath,{...activity,asOf:'23:59:00'},existingActivity.headers.get('etag'))
 assert.equal(finalActivity.data.isPartial,false)
 await remove(aPath,finalActivity.headers.get('etag'))
 const tPath = '/targets/'+TOMORROW
 await put(tPath,{intakeKcal:2200},null,true)
 assert.equal((await get(`/targets?${ranged}`)).data.length,2)
 assert.equal((await get(dayUrl)).data.summary.targetKcal,2050)
 assert.equal((await get('/days/'+TOMORROW)).data.summary.targetKcal,2200)
 const target = await get(tPath)
 const targetEdit = await put(tPath,{intakeKcal:2300},target.headers.get('etag'))
 assert.equal((await remove(tPath,targetEdit.headers.get('etag'))).data.affectedRange.to,null)

 const old = await (await fetch(origin+'/api/health-log',{headers:{authorization:basic}})).json()
 assert.equal(old.data.metrics.find(x=>x.id===measure.data.id).bodyFatPct,21.5)
 assert.equal(old.data.dailyTotals[0].kcal,0)
 assert.equal(old.data.meals.find(row=>row.id===meal.data.meal.id).name,'Photo lunch')
 old.data.meals.find(row=>row.id===meal.data.meal.id).name='Edited by browser'
 const writeLegacy = revision => fetch(origin+'/api/health-log',{ method:'PUT', headers:{authorization:basic,origin,'x-fieldnote':'1','content-type':'application/json'},body:JSON.stringify({revision,data:old.data}) })
 assert.equal((await writeLegacy(old.revision-1)).status,409)
 const measurements = old.data.metrics
 old.data.metrics = measurements.filter(row=>row.id!==measure.data.id)
 assert.equal((await writeLegacy(old.revision)).status,409)
 old.data.metrics = measurements
 assert.equal((await writeLegacy(old.revision)).status,200)
 const browserEdit = await get(fPath)
 assert.equal(browserEdit.data.description,'Edited by browser')
 assert.deepEqual(browserEdit.data.mediaIds,[image.data.id])
 const rawNothing = {workouts:[{'发起时间':DATE+' 13:00:00','运动类型':'力量训练','运动时长(分钟)':20}]}
 const importNothing = () => fetch(origin+'/api/import/nothing',{method:'POST',headers:{authorization:basic,'x-fieldnote':'1','content-type':'application/json'},body:JSON.stringify(rawNothing)})
 assert.equal((await (await importNothing()).json()).added,1)
 const imported = (await get(`/workouts?${ranged}`)).data.find(x=>x.origin==='nothing')
 const importedPath = '/workouts/'+encodeURIComponent(imported.id)
 const fixed = await update(importedPath,{durationMinutes:55},(await get(importedPath)).headers.get('etag'))
 assert.equal((await (await importNothing()).json()).skipped,1)
 assert.equal((await get(importedPath)).data.durationMinutes,55)
 await remove(importedPath,fixed.headers.get('etag'))
 assert.equal((await (await importNothing()).json()).skipped,1)

 execFileSync(process.execPath,['selfhost/backup.js',snapshot],{env})
 await stop()
 await start(snapshot)
 assert.deepEqual((await get(iPath+'/content')).bytes,raw.bytes)
 assert.equal((await get(mPath)).data.weightKg,70.5)
 await remove(fPath,(await get(fPath)).headers.get('etag'))
 await remove(iPath,(await get(iPath)).headers.get('etag'))
 await problemCode(await send('GET',iPath+'/content'),404,'NOT_FOUND')
 await remove(mPath,(await get(mPath)).headers.get('etag'))
 assert.equal((await fetch(origin+'/api/health-log',{headers:auth(dot.token)})).status,401)
 assert.equal(cli('revoke',restricted.tokenId).revoked,true)
 await stop(); await start()
 await problemCode(await send('GET','/me',undefined,undefined,restricted.token),401,'TOKEN_REVOKED')
 const expected = Object.values(spec.paths).flatMap(ops=>Object.values(ops).map(op=>op.operationId)).sort()
 assert.deepEqual([...coverage].sort(),expected)
})

test('idempotency expiry, rate limits, and image cleanup remain consistent', async () => {
 const db = openDatabase(':memory:')
 try {
  const token = createToken(db,'dot',spec['x-scope-catalog']).token
  let time = Date.parse(stamp)
  const handle = createV1Handler(db,()=>time)
  const measurement = {date:DATE,bodyFatPct:22,source:source('old')}
  const key = randomUUID()
  async function request(method,path,body,headers={}) {
   return handle(new Request('https://fieldnote.test/api/v1'+path,{method,headers:{...auth(token),...writeHeaders(key),...headers,
    ...(body && !(body instanceof FormData)?{'content-type':'application/json'}:{})},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body)}))
  }
  const [first, replay] = await Promise.all([request('POST','/measurements',measurement),request('POST','/measurements',measurement)])
  assert.equal(first.status,201)
  const id = (await first.json()).data.id
  assert.equal(replay.status,201)
  assert.equal(replay.headers.get('idempotency-replayed'),'true')
  assert.equal((await replay.json()).data.id,id)
  time += 73*3600_000
  const onceAgain = await request('POST','/measurements',measurement)
  assert.equal(onceAgain.status,200)
  assert.equal((await onceAgain.json()).data.id,id)
  assert.equal(db.prepare('SELECT count(*) AS n FROM fieldnote_idempotency').get().n,1)
  for(let i=0;i<120;i++) assert.equal((await request('GET','/me')).status,200)
  await problemCode(await request('GET','/me'),429,'RATE_LIMITED')
  const png = await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer()
  const photo = await request('POST','/media',upload(png))
  assert.equal(photo.status,201)
  const image = (await photo.json()).data
  assert.equal((await request('DELETE','/media/'+image.id,undefined,{'if-match':photo.headers.get('etag')})).status,200)
  assert.equal(db.prepare('SELECT count(*) AS n FROM fieldnote_image_bytes').get().n,1)
  time += 8*86400_000
  maintainV1(db,time)
  assert.equal(db.prepare('SELECT count(*) AS n FROM fieldnote_image_bytes').get().n,0)
 } finally { db.close() }
})

test('invalid legacy data rolls back the whole SQLite migration', () => {
 const directory = mkdtempSync(join(tmpdir(),'dot-migration-'))
 const path = join(directory,'health.sqlite')
 try {
  originalDatabase(path)
  const before = new DatabaseSync(path)
  const invalid = JSON.stringify({version:1,metrics:[{id:'invalid',date:DATE,weight:3}]})
  before.prepare('UPDATE health_logs SET payload = ?').run(invalid)
  before.close()
  assert.throws(()=>openDatabase(path),/无效/)
  const after = new DatabaseSync(path)
  try {
   assert.equal(after.prepare('PRAGMA user_version').get().user_version,1)
   assert.equal(after.prepare('SELECT payload FROM health_logs').get().payload,invalid)
   assert.equal(after.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'fieldnote_records'").get(),undefined)
  } finally { after.close() }
 } finally { rmSync(directory,{recursive:true,force:true}) }
})

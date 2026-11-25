import { fresh, merge, validate } from '../src/lib.js'
import { readFile, readRows } from '../src/importer.js'

const JSON_LIMIT = 1_500_000
const FILE_LIMIT = 35_000_000
const LOG_LIMIT = 1_500_000
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (value, status = 200) => Response.json(value, { status, headers })
const failure = (status, message) => Object.assign(new Error(message), { status })

async function readBody(request, limit) {
 if (Number(request.headers.get('content-length')) > limit) throw failure(413, '导入文件过大，请按月拆分。')
 const reader = request.body?.getReader()
 if (!reader) throw failure(400, '请提供导入数据。')
 const chunks = []
 let size = 0
 try {
  for (;;) {
   const { value, done } = await reader.read()
   if (done) break
   size += value.byteLength
   if (size > limit) { await reader.cancel(); throw failure(413, '导入文件过大，请按月拆分。') }
   chunks.push(value)
  }
 } finally { reader.releaseLock() }
 return new Blob(chunks)
}

async function parse(request) {
 const type = request.headers.get('content-type') ?? ''
 if (type.split(';')[0].trim().toLowerCase() === 'application/json') {
  const body = await readBody(request, JSON_LIMIT)
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await body.arrayBuffer()))
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['workouts', 'activity'].includes(key)))
   throw failure(400, 'JSON 仅支持 workouts 和 activity 两个 Nothing X 原始行数组。')
  if (['workouts', 'activity'].some(key => input[key] != null && !Array.isArray(input[key])) ||
      (input.workouts?.length ?? 0) + (input.activity?.length ?? 0) > 30000)
   throw failure(400, '记录列表无效或超过 30000 条，请拆分后导入。')
  const out = { workouts: [], activity: new Map() }
  const rejected = readRows(input.workouts ?? [], 'workouts', out) + readRows(input.activity ?? [], 'activity', out)
  if (!out.workouts.length && !out.activity.size) throw failure(400, '找不到可导入的有效运动或活动记录。')
  return { data: { workouts: out.workouts, activity: [...out.activity.values()] }, rejected, files: 0 }
 }
 if (/^multipart\/form-data\s*;/i.test(type)) {
  const body = await readBody(request, FILE_LIMIT + 64_000)
  const form = await new Response(body, { headers: { 'Content-Type': type } }).formData()
  const file = form.get('file'), password = form.get('password') ?? ''
  if ([...form.keys()].some(key => !['file', 'password'].includes(key)) || form.getAll('file').length !== 1 || form.getAll('password').length > 1 ||
      !(file instanceof File) || !/\.(zip|xlsx)$/i.test(file.name) || typeof password !== 'string' || password.length > 1024)
   throw failure(400, '请使用 file 上传一个 Nothing X ZIP 或 XLSX；password 为可选的解压密码。')
  if (file.size > FILE_LIMIT) throw failure(413, '导入文件过大，请按月拆分。')
  return readFile(file, password)
 }
 throw failure(415, '请使用 multipart/form-data 上传文件，或 application/json 提交原始行。')
}

// This endpoint is only mounted behind the self-hosted server's Basic authentication.
export async function nothingImportAPI(request, env) {
 if (request.method !== 'POST') return json({ error: '请使用 POST 导入。' }, 405)
 const origin = request.headers.get('origin')
 if ((origin && origin !== new URL(request.url).origin) || request.headers.get('x-fieldnote') !== '1')
  return json({ error: '请提供 X-Fieldnote: 1，且不得从其他网站发起导入。' }, 403)
 const dry = new URL(request.url).searchParams.get('dryRun')
 if (dry !== null && !['true', 'false'].includes(dry)) return json({ error: 'dryRun 仅支持 true 或 false。' }, 400)
 let parsed
 try { parsed = await parse(request) }
 catch (error) { return json({ error: error.status ? error.message : '无法解析 Nothing X 数据，请检查文件格式、记录和解压密码。' }, error.status ?? 400) }
 try {
  for (let attempt = 0; attempt < 3; attempt++) {
   const row = await env.DB.prepare('SELECT revision, payload, updated_at FROM health_logs WHERE owner_id = ?').bind('unraid-owner').first()
   const revision = row?.revision ?? 0
   const current = row ? { ...fresh(), ...validate(JSON.parse(row.payload)) } : fresh()
   const { next, added, updated, skipped } = merge(current, parsed.data)
   if (['meals', 'workouts', 'metrics', 'activity'].reduce((sum, key) => sum + next[key].length, 0) > 30000)
    return json({ error: '合并后超过 30000 条日志，请先导出备份并整理记录。' }, 413)
   const payload = JSON.stringify({ ...fresh(), ...validate(next) })
   if (new TextEncoder().encode(payload).length > LOG_LIMIT)
    return json({ error: '合并后超出日志容量，请先导出备份并整理记录。' }, 413)
   const result = { dryRun: dry === 'true', added, updated, skipped, rejected: parsed.rejected, files: parsed.files }
   if (result.dryRun || (!added && !updated)) return json({ ...result, revision, updatedAt: row?.updated_at ?? null })
   const updatedAt = new Date().toISOString()
   const saved = revision === 0
    ? await env.DB.prepare('INSERT INTO health_logs (owner_id, revision, payload, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(owner_id) DO NOTHING').bind('unraid-owner', payload, updatedAt).run()
    : await env.DB.prepare('UPDATE health_logs SET revision = revision + 1, payload = ?, updated_at = ? WHERE owner_id = ? AND revision = ?').bind(payload, updatedAt, 'unraid-owner', revision).run()
   if (saved.meta.changes) return json({ ...result, revision: revision + 1, updatedAt })
  }
  return json({ error: '其他设备正在更新日志，请重试导入。' }, 409)
 } catch {
  return json({ error: '未能确认导入结果，请重试；重复记录会自动跳过。' }, 503)
 }
}

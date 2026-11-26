import { randomUUID } from 'node:crypto'
import { ApiError, bodyBytes, fail, parseJson } from './v1/protocol.js'
import { authenticate } from './v1/tokens.js'
import { importLimit, parseHealthExport } from './health-export/parse.js'
import { mergeHealthExport } from './health-export/store.js'
import { repository } from './v1/store.js'

export const healthExportPath = '/api/import/health-data-export'
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }

export function createHealthExportHandler(db, clock = Date.now) {
 const windows = new Map()
 return async request => {
  const requestId = randomUUID(), url = new URL(request.url), now = clock()
  const responseHeaders = { ...headers, 'X-Request-Id': requestId }
  try {
   const auth = authenticate(db, request.headers.get('authorization'))
   if (!auth.scopes.includes('records:write')) fail(403, 'INSUFFICIENT_SCOPE', 'The token requires records:write.')
   if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Use POST for Health Data Export.', { headers: { Allow: 'POST' } })
   const origin = request.headers.get('origin')
   if (origin !== null && origin !== url.origin) fail(403, 'ORIGIN_FORBIDDEN', 'Cross-origin requests are disabled.')
   const mime = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
   if (mime !== 'application/json') fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.')
   if ([...url.searchParams.keys()].some(key => key !== 'dryRun') || url.searchParams.getAll('dryRun').length > 1 ||
       (url.searchParams.has('dryRun') && !['true', 'false'].includes(url.searchParams.get('dryRun')))) fail(400, 'INVALID_QUERY', 'Only dryRun=true or dryRun=false is supported.')
   for (const [id, window] of windows) if (window.until <= now) windows.delete(id)
   const window = windows.get(auth.tokenId) ?? { count: 0, until: now + 60_000 }
   windows.set(auth.tokenId, window)
   if (++window.count > 30) fail(429, 'RATE_LIMITED', 'Too many imports. Retry later.', { headers: { 'Retry-After': String(Math.max(1, Math.ceil((window.until - now) / 1000))) } })
   const input = parseJson(await bodyBytes(request, importLimit))
   const parsed = parseHealthExport(input, auth.clientId, now)
   const dryRun = url.searchParams.get('dryRun') === 'true'
   db.exec('BEGIN IMMEDIATE')
   let result
   try {
    // A token can be revoked while an upload is being read.
    authenticate(db, request.headers.get('authorization'))
    const before = repository(db, auth.ownerId).state()
    result = mergeHealthExport(db, auth, parsed, new Date(now).toISOString())
    result.wouldChange = dryRun && result.changed
    if (dryRun) Object.assign(result, { changed: false, revision: before.revision, updatedAt: before.updatedAt })
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT')
   } catch (error) { db.exec('ROLLBACK'); throw error }
   return Response.json({ data: { ...result, dryRun } }, { headers: { ...responseHeaders, 'X-Data-Revision': String(result.revision) } })
  } catch (error) {
   const known = error instanceof ApiError
   const status = known ? error.status : 503
   const code = known ? error.code : 'TEMPORARILY_UNAVAILABLE'
   return Response.json({ type: `urn:fieldnote:problem:${code.toLowerCase()}`, title: code.replaceAll('_', ' '), status, code,
    detail: known ? error.message : 'The import could not be completed. Retry the same export.', requestId,
    ...(known && error.errors ? { errors: error.errors } : {}) },
   { status, headers: { ...responseHeaders, 'Content-Type': 'application/problem+json', ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="Fieldnote"' } : {}), ...(known ? error.headers : {}) } })
  }
 }
}

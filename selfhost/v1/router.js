import { randomUUID } from 'node:crypto'
import { collections, recordOperation } from './records.js'
import { ApiError, contract, fail, imageLimit, imageTypes, jsonBody, jsonLimit, limits, pathArgs, pixelLimit, readQuery } from './protocol.js'
import { canonical, digest, OWNER, repository, transact } from './store.js'
import { cleanupImages, imageBytesUsed, imageQuota, mediaBody, normalizeImage } from './media.js'
import { authenticate } from './tokens.js'
import { zone } from '../../src/lib.js'

const routes = Object.entries(contract.paths).map(([path, operations]) => ({ path, operations, pattern: new RegExp('^' + path.replaceAll('.', '\\.').replace(/\{\w+\}/g, '([^/]+)') + '$') }))
const standardHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }
const idempotencyMs = 72 * 3600_000

function problem(error, pathname, requestId) {
 const known = error instanceof ApiError
 const status = known ? error.status : 503
 const detail = known ? error.message : 'The server could not complete the request.'
 const code = known ? error.code : 'TEMPORARILY_UNAVAILABLE'
 const headers = { ...standardHeaders, 'Content-Type': 'application/problem+json', 'X-Request-Id': requestId, ...error.headers }
 if (status === 401) headers['WWW-Authenticate'] = 'Bearer realm="Fieldnote"'
 const { errors, linkedMealIds } = error
 return new Response(JSON.stringify({ type: `urn:fieldnote:problem:${code.toLowerCase()}`, title: code.replaceAll('_', ' '), status, detail,
  instance: pathname, code, requestId, ...(errors ? { errors } : {}), ...(linkedMealIds ? { linkedMealIds } : {}) }), { status, headers })
}

function reply(result, requestId, revision) {
 const headers = { ...standardHeaders, 'X-Request-Id': requestId, 'X-Data-Revision': String(revision), ...result.headers }
 if (result.bytes) return new Response(result.bytes, { status: result.status ?? 200, headers })
 return Response.json(result.body, { status: result.status ?? 200, headers })
}

function capabilities(repo) {
 return { apiVersion: 'v1', serviceVersion: '1.0.0', timezone: zone,
  features: ['meals', 'daily-intake', 'media', 'workouts', 'measurements', 'body-fat', 'activity', 'targets', 'summaries', 'trends'],
  imageContentTypes: imageTypes, limits: { jsonBytes: jsonLimit, imageBytes: imageLimit, imagePixels: pixelLimit, imagesPerMeal: 8,
   mediaQuotaBytes: imageQuota, mediaRemainingBytes: Math.max(0, imageQuota - imageBytesUsed(repo)), maxListLimit: 200,
   maxQueryDays: 366, maxTrendDays: 1827, idempotencyRetentionHours: 72 }, rateLimitsPerMinute: limits }
}

function throttle(windows, auth, group, time) {
 const key = auth.tokenId + ':' + group
 let window = windows.get(key)
 if (!window || window.until <= time) {
  window = { count: 0, until: time + 60_000 }
  windows.set(key, window)
 }
 if (window.count >= limits[group]) fail(429, 'RATE_LIMITED', 'The request limit has been reached.', { headers: { 'Retry-After': String(Math.ceil((window.until - time) / 1000)) } })
 window.count++
}

function idempotency(repo, auth, method, path, key, fingerprint, time) {
 const args = [repo.owner, auth.clientId, method, path, key]
 return {
  load() {
   const row = repo.db.prepare(`SELECT fingerprint, response FROM fieldnote_idempotency WHERE owner_id = ? AND client_id = ? AND method = ? AND path = ? AND request_key = ? AND expires_at > ?`).get(...args, time)
   if (!row) return null
   if (row.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used with different input.')
   const cached = JSON.parse(row.response)
   cached.result.headers = { ...cached.result.headers, 'Idempotency-Replayed': 'true' }
   return cached
  },
  save(result, revision) {
   repo.db.prepare(`INSERT INTO fieldnote_idempotency VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, client_id, method, path, request_key)
    DO UPDATE SET fingerprint = excluded.fingerprint, response = excluded.response, expires_at = excluded.expires_at`).run(...args, fingerprint, JSON.stringify({ result, revision }), time + idempotencyMs)
  }
 }
}

export function createV1Handler(db, clock = Date.now) {
 const windows = new Map(), pending = new Map()
 let lastCleanup = -Infinity
 return async function handle(request) {
  const requestId = randomUUID(), url = new URL(request.url)
  const path = url.pathname.slice('/api/v1'.length) || '/'
  const time = clock(), now = new Date(time).toISOString()
  try {
   const auth = authenticate(db, request.headers.get('authorization'))
   const match = routes.find(route => route.pattern.test(path))
   if (!match) fail(404, 'NOT_FOUND', 'The requested API route does not exist.')
   const method = request.method, operation = match.operations[method.toLowerCase()]
   if (!operation) fail(405, 'METHOD_NOT_ALLOWED', 'This method is not available for the route.', { headers: { Allow: Object.keys(match.operations).map(m => m.toUpperCase()).join(', ') } })
   if (operation['x-required-scopes'].some(scope => !auth.scopes.includes(scope))) fail(403, 'INSUFFICIENT_SCOPE', 'The token does not grant the required scope.')
   const origin = request.headers.get('origin')
   if (origin !== null && origin !== url.origin) fail(403, 'ORIGIN_FORBIDDEN', 'Cross-origin requests are disabled.')
   const repo = repository(db, auth.ownerId)
   if (time - lastCleanup >= 60_000) {
    for (const [key, entry] of windows) if (entry.until <= time) windows.delete(key)
    lastCleanup = time
   }
   const values = match.pattern.exec(path).slice(1)
   const args = pathArgs(operation, values)
   const query = readQuery(operation, url.searchParams)
   const canonicalPath = match.path.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(args[key]))
   const [segment, , tail] = match.path.slice(1).split('/')
   const write = method !== 'GET', upload = method === 'POST' && segment === 'media'
   const ctx = { repo, segment, tail, kind: collections[segment], key: args.id ?? args.date ?? args.effectiveFrom, method, now, request, auth, query }
   if (!write) {
    throttle(windows, auth, 'read', time)
    return transact(db, () => {
     const builtins = { getCapabilities: () => ({ data: capabilities(repo) }), getCurrentIdentity: () => ({ data: auth }), getOpenApiContract: () => contract }
     const builtin = builtins[operation.operationId]
     const result = builtin ? { body: builtin() } : recordOperation(ctx)
     return reply(result, requestId, repo.state().revision)
    }, false)
   }
   if (request.headers.get('x-fieldnote') !== '1') fail(403, 'WRITE_GUARD_REQUIRED', 'Supply X-Fieldnote: 1 on writes.')
   const key = request.headers.get('idempotency-key')
   if (!key || !/^[\x21-\x7e]{16,128}$/.test(key)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply an Idempotency-Key of 16 to 128 visible ASCII characters.')
   // Limit all mutation traffic, including invalid bodies and repeated requests.
   throttle(windows, auth, upload ? 'mediaUpload' : 'write', time)
   const form = upload ? await mediaBody(request) : null
   ctx.body = form ? form.input : operation.requestBody ? await jsonBody(request, operation) : null
   const fingerprint = digest(canonical({ body: ctx.body, query, upload: form?.inputDigest ?? null,
    ifMatch: request.headers.get('if-match'), ifNoneMatch: request.headers.get('if-none-match') }))
   const attempts = idempotency(repo, auth, method, canonicalPath, key, fingerprint, time)
   let prior = attempts.load()
   if (prior) return reply(prior.result, requestId, prior.revision)
   const pendingKey = canonical([auth.ownerId, auth.clientId, method, canonicalPath, key])
   if (pending.has(pendingKey)) {
    if (pending.get(pendingKey) !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key is in use with different input.')
    fail(409, 'REQUEST_IN_PROGRESS', 'The matching request is still processing.', { headers: { 'Retry-After': '1' } })
   }
   pending.set(pendingKey, fingerprint)
   try {
    if (form) ctx.image = { ...await normalizeImage(form.buffer), inputDigest: form.inputDigest }
    return transact(db, () => {
     // Re-check after reading the request body or decoding an image.
     authenticate(db, request.headers.get('authorization'))
     prior = attempts.load()
     if (prior) return reply(prior.result, requestId, prior.revision)
     if (upload) cleanupImages(repo, time)
     db.prepare('DELETE FROM fieldnote_idempotency WHERE expires_at <= ?').run(time)
     const result = recordOperation(ctx)
     const oldRevision = repo.state().revision
     const revision = result.changed ? repo.setState(oldRevision + 1, now) : oldRevision
     attempts.save(result, revision)
     return reply(result, requestId, revision)
    })
   } finally { pending.delete(pendingKey) }
  } catch (error) {
   if (!(error instanceof ApiError)) console.error('Fieldnote v1 request failed', requestId, error.code ?? error.name, url.pathname.split('/').slice(0, 4).join('/'))
   return problem(error, url.pathname, requestId)
  }
 }
}

export function maintainV1(db, time = Date.now()) {
 return transact(db, () => {
  cleanupImages(repository(db, OWNER), time)
  db.prepare('DELETE FROM fieldnote_idempotency WHERE expires_at <= ?').run(time)
 })
}

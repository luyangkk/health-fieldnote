import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import site from '../dist/server/index.js'
import { nothingImportAPI } from '../dist/server/nothing-import.js'
import { openDatabase } from './sqlite.js'
import { legacyStorage } from './v1/legacy.js'
import { createV1Handler, maintainV1 } from './v1/router.js'
import { createHealthExportHandler, healthExportPath } from './health-data-export.js'

process.umask(0o077)
const origin = new URL(process.env.FIELDNOTE_ORIGIN ?? '')
const bind = process.env.FIELDNOTE_BIND ?? '0.0.0.0'
const tlsDir = process.env.FIELDNOTE_TLS_DIR
const port = Number(process.env.PORT ?? (tlsDir ? 8443 : 8080))
if (port === 8443 && !tlsDir) throw Error('Set FIELDNOTE_TLS_DIR to enable HTTPS on port 8443')
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid PORT')
const loopback = ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
 !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback && bind === '127.0.0.1')))
 throw Error('FIELDNOTE_ORIGIN must be an HTTPS origin (HTTP loopback is only for local tests)')

if (tlsDir && origin.protocol !== 'https:') throw Error('Direct TLS requires an HTTPS FIELDNOTE_ORIGIN')
const tls = tlsDir ? { key:readFileSync(join(tlsDir,'server.key')), cert:readFileSync(join(tlsDir,'server.crt')), minVersion:'TLSv1.2' } : null

const password = readFileSync(process.env.FIELDNOTE_PASSWORD_FILE ?? '/run/secrets/fieldnote_password', 'utf8').replace(/\r?\n$/, '')
if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw Error('Set a randomly generated password (32–128 URL-safe characters)')
const hash = v => createHash('sha256').update(v).digest()
const expected = hash('fieldnote:' + password)
const path = process.env.FIELDNOTE_DB ?? '/data/health.sqlite'
const db = openDatabase(path)
const env = { LOGS: legacyStorage(db) }
const v1 = createV1Handler(db)
const healthExport = createHealthExportHandler(db)
maintainV1(db)
const maintenance = setInterval(() => {
 try { maintainV1(db) } catch { console.error('Fieldnote storage maintenance failed') }
}, 3600_000).unref()
const empty = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options':'nosniff' }
function reject(res, status, message, extras = {}) {
 res.writeHead(status, { ...empty, 'Content-Type':'text/plain; charset=utf-8', ...extras })
 res.end(message)
}

async function handler(req,res) {
 try {
  if (req.method === 'GET' && req.url === '/healthz') {
   db.prepare('SELECT 1 FROM fieldnote_state LIMIT 1').get()
   return reject(res,200,'ok')
  }
  if (req.headers.host !== origin.host || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\'))
   return reject(res,400,'Invalid request')
  const url = new URL(req.url,origin)
  if (url.origin !== origin.origin) return reject(res,400,'Invalid origin')
  const api = url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')
  if (api || url.pathname === healthExportPath) {
   const headers = new Headers()
   for (const name of ['origin','authorization','content-type','content-length','x-fieldnote','idempotency-key','if-match','if-none-match']) {
    if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name])
   }
   const hasBody = ['POST','PUT','PATCH'].includes(req.method)
   const request = new Request(url, { method:req.method, headers, ...(hasBody ? { body:Readable.toWeb(req),duplex:'half' } : {}) })
   return await send(req, res, await (api ? v1 : healthExport)(request))
  }
  const supplied = req.headers.authorization ?? ''
  const provides = supplied.startsWith('Basic ') && supplied.length < 1024
  const candidate = provides ? Buffer.from(supplied.slice(6),'base64') : Buffer.alloc(0)
  if (!timingSafeEqual(hash(candidate),expected))
   return reject(res,401,'Sign in to Fieldnote',{'WWW-Authenticate':'Basic realm="Fieldnote", charset="UTF-8"'})
  const method = req.method
  const importing = url.pathname === '/api/import/nothing'
  if (!['GET','HEAD','PUT'].includes(method) && !(importing && method === 'POST')) return reject(res,405,'Method not allowed')
  const hdr = new Headers({'oai-authenticated-user-id':'unraid-owner'})
  for (const name of ['origin','content-type','content-length','x-fieldnote','x-fieldnote-schema']) if(typeof req.headers[name] === 'string') hdr.set(name,req.headers[name])
  const input = new Request(url, { method, headers:hdr, ...(['PUT','POST'].includes(method) ? { body:Readable.toWeb(req),duplex:'half' } : {}) })
  const response = importing ? await nothingImportAPI(input,env) : await site.fetch(input,env)
  await send(req, res, response)
 } catch {
  if(!res.headersSent)reject(res,500,'Fieldnote request failed')
  else res.destroy()
 }
}
async function send(req, res, response) {
 const headers = Object.fromEntries(response.headers)
 if (!req.complete) headers.Connection = 'close'
 res.writeHead(response.status, headers)
 if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res)
 else res.end()
}
const server = tls ? createHttpsServer(tls,handler) : createHttpServer(handler)
server.requestTimeout=30000
server.headersTimeout=10000
server.listen(port,bind,()=>console.log('Fieldnote is ready on '+(tls?'HTTPS':'HTTP')+' port '+port))
const stop=()=>{clearInterval(maintenance);server.close(()=>{db.close();process.exit(0)})}
process.on('SIGTERM',stop);process.on('SIGINT',stop)

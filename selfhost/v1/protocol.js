import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

export const contract = JSON.parse(readFileSync(new URL('../../docs/api/openapi.json', import.meta.url)))
export const scopes = contract['x-scope-catalog']
export const jsonLimit = 1_000_000
export const imageLimit = 10_000_000
export const pixelLimit = 25_000_000
export const imageTypes = ['image/jpeg', 'image/png', 'image/webp']
export const limits = { read: 120, write: 30, mediaUpload: 10 }

const schemaId = 'https://fieldnote.invalid/openapi'
const legacySchemaId = 'https://fieldnote.invalid/legacy-precision'
const ajv = new Ajv({ strict: false, allErrors: true, multipleOfPrecision: 8 })
addFormats(ajv)
ajv.addSchema(contract, schemaId)
// Keep precision from older logs when patching another field. The patch itself still uses the published limits.
const legacyPrecisionContract = JSON.parse(JSON.stringify(contract), (key, value) => key === 'multipleOf' ? undefined : value)
ajv.addSchema(legacyPrecisionContract, legacySchemaId)
const validators = new Map()

export class ApiError extends Error {
 constructor(status, code, message, options = {}) {
  super(message)
  Object.assign(this, { status, code }, options)
 }
}
export const fail = (status, code, message, options) => { throw new ApiError(status, code, message, options) }

function check(schema, value, status, code) {
 const key = JSON.stringify(schema)
 if (!validators.has(key)) validators.set(key, ajv.compile(schema))
 const validate = validators.get(key)
 if (!validate(value)) {
  const errors = validate.errors.slice(0, 20).map(err => ({
   pointer: (err.instancePath + (err.keyword === 'additionalProperties' ? '/' + err.params.additionalProperty.replaceAll('~', '~0').replaceAll('/', '~1') : '')).slice(0, 500),
   code: err.keyword.toUpperCase(), message: (err.message ?? 'Invalid value').slice(0, 500)
  }))
  fail(status, code, 'One or more fields are invalid.', { errors })
 }
}
export function validateSchema(name, value, preservePrecision = false) {
 check({ $ref: `${preservePrecision ? legacySchemaId : schemaId}#/components/schemas/${name}` }, value, 422, 'VALIDATION_FAILED')
}

function parameters(operation, kind) {
 return operation.parameters.map(p => p.$ref ? contract.components.parameters[p.$ref.split('/').at(-1)] : p).filter(p => p.in === kind)
}

export function readQuery(operation, query) {
 const fields = parameters(operation, 'query')
 const output = Object.create(null)
 for (const key of query.keys()) {
  if (!fields.some(field => field.name === key) || query.getAll(key).length !== 1) fail(400, 'INVALID_QUERY', 'Unknown or repeated query parameter.')
 }
 for (const field of fields) {
  const raw = query.get(field.name)
  if (raw === null && !field.required && field.schema.default === undefined) continue
  let value = raw ?? field.schema.default
  if (raw !== null && field.schema.type === 'integer' && /^\d+$/.test(raw)) value = Number(raw)
  if (raw !== null && field.schema.type === 'boolean' && ['true', 'false'].includes(raw)) value = raw === 'true'
  const code = ['from', 'to'].includes(field.name) ? 'INVALID_DATE_RANGE' : 'INVALID_QUERY'
  check(field.schema, value, 400, code)
  output[field.name] = value
 }
 return output
}

export function pathArgs(operation, values) {
 return Object.fromEntries(parameters(operation, 'path').map((field, index) => {
  let value
  try { value = decodeURIComponent(values[index]) } catch { fail(400, 'INVALID_PATH', 'Invalid path encoding.') }
  check(field.schema, value, 400, 'INVALID_PATH')
  if (field.schema.format === 'date' && value < '0001-01-01') fail(400, 'INVALID_PATH', 'Supply a valid business date.')
  return [field.name, value]
 }))
}

export async function bodyBytes(request, limit) {
 if (Number(request.headers.get('content-length')) > limit) fail(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the limit.')
 if (!request.body) fail(400, 'INVALID_BODY', 'A request body is required.')
 const reader = request.body.getReader()
 const chunks = []
 let size = 0
 try {
  for (;;) {
   const { value, done } = await reader.read()
   if (done) break
   size += value.byteLength
   if (size > limit) fail(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the limit.')
   chunks.push(value)
  }
 } finally { reader.releaseLock() }
 return Buffer.concat(chunks, size)
}

export function parseJson(bytes) {
 try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
 catch { fail(400, 'INVALID_JSON', 'The request contains invalid UTF-8 or JSON.') }
}

export async function jsonBody(request, operation) {
 const mime = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
 const reference = operation.requestBody.content[mime]?.schema.$ref
 if (!reference) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use the content type specified for this operation.')
 const value = parseJson(await bodyBytes(request, jsonLimit))
 validateSchema(reference.split('/').at(-1), value)
 return value
}

export function mergePatch(original, patch) {
 const result = { ...original }
 for (const [key, value] of Object.entries(patch)) {
  if (value === null) delete result[key]
  else if (value && typeof value === 'object' && !Array.isArray(value)) result[key] = mergePatch(original?.[key], value)
  else result[key] = value
 }
 return result
}

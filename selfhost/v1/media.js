import sharp from 'sharp'
import { bodyBytes, fail, imageLimit, imageTypes, parseJson, pixelLimit, validateSchema } from './protocol.js'
import { digest } from './store.js'

const fields = ['file', 'date', 'purpose', 'capturedAt', 'caption', 'source']
export const imageQuota = Number(process.env.FIELDNOTE_MEDIA_QUOTA_BYTES ?? 5_000_000_000)
if (!Number.isSafeInteger(imageQuota) || imageQuota < 1) throw Error('Invalid FIELDNOTE_MEDIA_QUOTA_BYTES')

export async function mediaBody(request) {
 const type = request.headers.get('content-type') ?? ''
 if (!/^multipart\/form-data\s*;/i.test(type)) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data for images.')
 const bytes = await bodyBytes(request, imageLimit + 64_000)
 let form
 try { form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData() }
 catch { fail(400, 'INVALID_MULTIPART', 'The multipart data is invalid.') }
 const metadata = Object.create(null)
 for (const [key, value] of form.entries()) {
  if (!fields.includes(key) || form.getAll(key).length !== 1) fail(422, 'VALIDATION_FAILED', 'Unknown or repeated image field.')
  if (key === 'file') {
   if (!(value instanceof File)) fail(422, 'VALIDATION_FAILED', 'The file field must be an image file.')
   metadata.file = value.name
  } else {
   if (typeof value !== 'string') fail(422, 'VALIDATION_FAILED', 'Image metadata must be text.')
   metadata[key] = value
  }
 }
 validateSchema('MediaUpload', metadata)
 const file = form.get('file')
 if (file.size > imageLimit) fail(413, 'PAYLOAD_TOO_LARGE', 'The image exceeds 10 MB.')
 const buffer = Buffer.from(await file.arrayBuffer())
 const source = parseJson(Buffer.from(metadata.source))
 validateSchema('Source', source)
 const input = { date: metadata.date, purpose: metadata.purpose, capturedAt: metadata.capturedAt ?? null, caption: metadata.caption ?? null, source }
 return { input, buffer, inputDigest: digest(buffer) }
}

export async function normalizeImage(buffer) {
 // Check the container signature before invoking any native decoder.
 const format = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff ? 'jpeg'
  : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
   : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null
 if (!format) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use a JPEG, PNG or WebP image.')
 const contentType = imageTypes.find(type => type.endsWith('/' + format))
 let result
 try {
  const image = sharp(buffer, { limitInputPixels: pixelLimit, failOn: 'warning', sequentialRead: true })
  const meta = await image.metadata()
  if (meta.format !== format || (meta.pages ?? 1) !== 1) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use a supported still image.')
  if (meta.width * meta.height > pixelLimit) fail(413, 'PAYLOAD_TOO_LARGE', 'The image exceeds the pixel limit.')
  result = await image.autoOrient().toFormat(format).toBuffer({ resolveWithObject: true })
 } catch (error) {
  if (error.status) throw error
  if (/pixel limit/i.test(error.message)) fail(413, 'PAYLOAD_TOO_LARGE', 'The image exceeds the pixel limit.')
  fail(422, 'INVALID_IMAGE', 'The image could not be decoded.')
 }
 if (result.data.length > imageLimit) fail(413, 'PAYLOAD_TOO_LARGE', 'The processed image exceeds 10 MB.')
 return { bytes: result.data, properties: { contentType, byteSize: result.data.length, width: result.info.width, height: result.info.height, sha256: digest(result.data) } }
}

export function imageBytesUsed(repo) {
 return repo.db.prepare('SELECT coalesce(sum(length(bytes)), 0) AS size FROM fieldnote_image_bytes WHERE owner_id = ?').get(repo.owner).size
}

export function saveImage(repo, image) {
 const sha = image.properties.sha256
 if (repo.db.prepare('SELECT 1 FROM fieldnote_image_bytes WHERE owner_id = ? AND sha256 = ?').get(repo.owner, sha)) return
 if (imageBytesUsed(repo) + image.bytes.length > imageQuota) fail(503, 'STORAGE_FULL', 'The configured image storage quota has been reached.')
 repo.db.prepare('INSERT INTO fieldnote_image_bytes VALUES (?, ?, ?)').run(repo.owner, sha, image.bytes)
}

export function cleanupImages(repo, now) {
 const cutoff = new Date(now - 7 * 86400_000).toISOString()
 repo.db.prepare(`DELETE FROM fieldnote_image_bytes AS image WHERE owner_id = ? AND NOT EXISTS (
  SELECT 1 FROM fieldnote_records WHERE owner_id = image.owner_id AND kind = 'media'
  AND json_extract(payload, '$.sha256') = image.sha256 AND (deleted_at IS NULL OR deleted_at > ?))`).run(repo.owner, cutoff)
}

export function loadImage(repo, metadata) {
 return repo.db.prepare('SELECT bytes FROM fieldnote_image_bytes WHERE owner_id = ? AND sha256 = ?').get(repo.owner, metadata.sha256)?.bytes
}

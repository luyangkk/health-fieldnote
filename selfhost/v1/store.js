import { createHash, randomUUID } from 'node:crypto'

export const OWNER = 'unraid-owner'
export const BASELINE = '0001-01-01'
export const dateField = "coalesce(json_extract(payload, '$.date'), json_extract(payload, '$.effectiveFrom'))"
export const digest = value => createHash('sha256').update(value).digest('hex')

export function canonical(value) {
 if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
 if (value && typeof value === 'object') {
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
 }
 return JSON.stringify(value)
}

export function transact(db, fn, write = true) {
 db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
 try {
  const result = fn()
  db.exec('COMMIT')
  return result
 } catch (error) {
  db.exec('ROLLBACK')
  throw error
 }
}

export function newRecord(kind, now, previous, id = randomUUID()) {
 return { id: previous?.id ?? `${kind}_${id}`, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now }
}

export function repository(db, owner = OWNER) {
 return {
  db, owner,
  state() {
   return db.prepare('SELECT revision, updated_at AS updatedAt FROM fieldnote_state WHERE owner_id = ?').get(owner) ?? { revision: 0, updatedAt: null }
  },
  setState(revision, now) {
   db.prepare(`INSERT INTO fieldnote_state VALUES (?, ?, ?) ON CONFLICT(owner_id)
    DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`).run(owner, revision, now)
   return revision
  },
  get(kind, key, includingDeleted = false) {
   const found = db.prepare(`SELECT payload, deleted_at FROM fieldnote_records WHERE owner_id = ? AND kind = ? AND record_key = ?${includingDeleted ? '' : ' AND deleted_at IS NULL'}`).get(owner, kind, key)
   return found && { value: JSON.parse(found.payload), deletedAt: found.deleted_at }
  },
  list(kind, from = null, to = null) {
   const ranged = from !== null && to !== null
   return db.prepare(`SELECT payload FROM fieldnote_records WHERE owner_id = ? AND kind = ? AND deleted_at IS NULL${ranged ? ` AND ${dateField} BETWEEN ? AND ?` : ''}`)
    .all(owner, kind, ...(ranged ? [from, to] : [])).map(row => JSON.parse(row.payload))
  },
  put(kind, key, data) {
   db.prepare(`INSERT INTO fieldnote_records VALUES (?, ?, ?, ?, NULL) ON CONFLICT(owner_id, kind, record_key)
    DO UPDATE SET payload = excluded.payload, deleted_at = NULL`).run(owner, kind, key, JSON.stringify(data))
   return data
  },
  remove(kind, key, data, now) {
   const removed = { ...data, version: data.version + 1, updatedAt: now }
   db.prepare('UPDATE fieldnote_records SET deleted_at = ?, payload = ? WHERE owner_id = ? AND kind = ? AND record_key = ?')
    .run(now, JSON.stringify(removed), owner, kind, key)
   db.prepare('UPDATE fieldnote_sources SET deleted_at = ? WHERE owner_id = ? AND kind = ? AND record_key = ? AND deleted_at IS NULL')
    .run(now, owner, kind, key)
   return removed
  },
  source(kind, source) {
   return db.prepare('SELECT record_key, fingerprint, deleted_at FROM fieldnote_sources WHERE owner_id = ? AND kind = ? AND client_id = ? AND external_id = ?')
    .get(owner, kind, source.client, source.externalId)
  },
  addSource(kind, source, key, fingerprint) {
   db.prepare('INSERT INTO fieldnote_sources VALUES (?, ?, ?, ?, ?, ?, NULL)').run(owner, kind, source.client, source.externalId, key, fingerprint)
  }
 }
}

export function defaultDay(date) {
 return { date, version: 0, updatedAt: null, intakeMode: 'meals', dailyTotalKcal: null, totalIsEstimate: null, recordingStatus: 'open', isRestDay: false, note: null }
}

export function dayState(repo, date) {
 return repo.get('day', date)?.value ?? defaultDay(date)
}

export function reopenDays(repo, dates, now) {
 for (const date of new Set(dates.filter(Boolean))) {
  const state = dayState(repo, date)
  repo.put('day', date, { ...state, recordingStatus: 'open', version: state.version + 1, updatedAt: now })
 }
}

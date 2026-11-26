import { canonical, digest, newRecord, repository } from '../v1/store.js'
import { fail } from '../v1/protocol.js'

const business = row => {
 const { id, version, createdAt, updatedAt, ...fields } = row
 return digest(canonical(fields))
}
function comparable(row) {
 const { source, asOf, ...fields } = row.input
 return digest(canonical({ kind: row.kind, date: row.date, ...fields,
  ...(row.kind === 'activity' ? { isPartial: asOf !== '23:59:59' } : {}) }))
}
function workoutFamily(type) {
 if (/力量|strength/i.test(type)) return 'strength'
 if (/骑|cycl/i.test(type)) return 'cycling'
 if (/跑|run/i.test(type)) return 'running'
 if (/步|walk/i.test(type)) return 'walking'
 return type
}
function existingEquivalent(rows, imported) {
 const { kind, input } = imported
 return rows.some(row => row.date === input.date && row.time === input.time &&
  (kind === 'workout' ? workoutFamily(row.type) === workoutFamily(input.type)
   : (input.weightKg !== undefined && row.weightKg === input.weightKg) || (input.bodyFatPct !== undefined && row.bodyFatPct === input.bodyFatPct)))
}

// The caller wraps the whole batch in one BEGIN IMMEDIATE transaction. Source
// identity is owner-wide, so token rotation or a second client cannot duplicate it.
export function mergeHealthExport(db, auth, parsed, now) {
 const repo = repository(db, auth.ownerId), before = repo.state()
 const counts = { added: 0, updated: 0, skipped: parsed.duplicates, stale: 0, conflicts: 0 }
 const details = { measurements: { added: 0, updated: 0 }, workouts: { added: 0, updated: 0 }, activity: { added: 0, updated: 0 } }
 const groups = { measurement: 'measurements', workout: 'workouts', activity: 'activity' }
 const warnings = new Set(parsed.warnings)
 const existing = { measurement: repo.list('measurement'), workout: repo.list('workout') }
 const lookup = db.prepare('SELECT * FROM fieldnote_health_imports WHERE owner_id = ? AND sample_key = ?')
 const save = db.prepare(`INSERT INTO fieldnote_health_imports VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(owner_id, sample_key) DO UPDATE SET fingerprint = excluded.fingerprint,
   record_fingerprint = excluded.record_fingerprint, exported_at = excluded.exported_at`)
 const advance = db.prepare('UPDATE fieldnote_health_imports SET exported_at = ? WHERE owner_id = ? AND sample_key = ?')
 for (const imported of parsed.records) {
  const { sampleKey, kind, input } = imported
  const prior = lookup.get(auth.ownerId, sampleKey)
  const fingerprint = comparable(imported)
  if (prior && parsed.exportedAt < prior.exported_at) { counts.skipped++; counts.stale++; continue }
  if (prior && parsed.exportedAt === prior.exported_at && prior.fingerprint !== fingerprint) {
   fail(409, 'EXPORT_VERSION_CONFLICT', 'The same export timestamp contains different versions of a sample. Export again with a new timestamp.')
  }
  const key = prior?.record_key ?? (kind === 'activity' ? imported.date : kind + '_' + digest(sampleKey))
  const previous = repo.get(kind, key, true)
  if (previous?.deletedAt || (prior && (!previous || business(previous.value) !== prior.record_fingerprint)) || (!prior && previous)) {
   counts.skipped++; counts.conflicts++
   warnings.add(previous?.deletedAt ? 'DELETED_RECORD_PRESERVED' : 'LOCAL_CHANGE_PRESERVED')
   continue
  }
  if (prior?.fingerprint === fingerprint) {
   counts.skipped++
   if (parsed.exportedAt > prior.exported_at) advance.run(parsed.exportedAt, auth.ownerId, sampleKey)
   continue
  }
  if (!prior && existing[kind] && existingEquivalent(existing[kind], imported)) {
   counts.skipped++; counts.conflicts++; warnings.add('EXISTING_RECORD_PRESERVED'); continue
  }
  const row = { ...newRecord(kind, now, previous?.value, digest(sampleKey)), ...input,
   source: previous?.value.source ?? input.source }
  if (kind === 'activity') Object.assign(row, { date: imported.date, isPartial: input.asOf !== '23:59:59', completenessBasis: 'timestamp_heuristic' })
  else if (kind === 'measurement') Object.assign(row, { weightKg: input.weightKg ?? null, bodyFatPct: input.bodyFatPct ?? null, waistCm: null, note: null })
  else Object.assign(row, { origin: 'health-data-export', note: null })
  repo.put(kind, key, row)
  if (!prior) {
   repo.addSource(kind, row.source, key, fingerprint)
   existing[kind]?.push(row)
  } else {
   db.prepare('UPDATE fieldnote_sources SET fingerprint = ? WHERE owner_id = ? AND kind = ? AND record_key = ? AND deleted_at IS NULL')
    .run(fingerprint, auth.ownerId, kind, key)
   if (existing[kind]) existing[kind] = existing[kind].map(old => old.id === row.id ? row : old)
  }
  save.run(auth.ownerId, sampleKey, kind, key, fingerprint, business(row), parsed.exportedAt)
  const change = prior ? 'updated' : 'added'
  counts[change]++; details[groups[kind]][change]++
 }
 const changed = counts.added + counts.updated > 0
 const revision = changed ? repo.setState(before.revision + 1, now) : before.revision
 return { ...counts, changed, details, ignored: parsed.ignored, warnings: [...warnings].sort(), revision,
  updatedAt: changed ? now : before.updatedAt, test: parsed.test }
}

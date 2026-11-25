import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

export function openDatabase(path) {
 const db = new DatabaseSync(path, { timeout: 5000 })
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
 try {
  const { user_version: version } = db.prepare('PRAGMA user_version').get()
  if (version === 0) {
   db.exec(readFileSync(new URL('../drizzle/0000_health_logs.sql', import.meta.url), 'utf8'))
   db.exec('PRAGMA user_version=1')
  } else if (version !== 1) throw Error('Unsupported database schema version')
  db.exec('COMMIT')
 } catch (error) {
  db.exec('ROLLBACK'); db.close(); throw error
 }
 return db
}

export const binding = db => ({
 prepare(query) {
  const stmt = db.prepare(query)
  return { bind: (...args) => ({
   first: async () => stmt.get(...args),
   run: async () => ({ meta: stmt.run(...args) })
  }) }
 }
})

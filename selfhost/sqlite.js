import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { migrateLegacy } from './v1/legacy.js'

export function openDatabase(path) {
 const db = new DatabaseSync(path, { timeout: 5000 })
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
 try {
  const { user_version: version } = db.prepare('PRAGMA user_version').get()
  if (version === 0) {
   db.exec(readFileSync(new URL('../drizzle/0000_health_logs.sql', import.meta.url), 'utf8'))
  } else if (![1, 2, 3].includes(version)) throw Error('Unsupported database schema version')
  if (version < 2) {
   db.exec(readFileSync(new URL('../drizzle/0001_dot_api.sql', import.meta.url), 'utf8'))
   migrateLegacy(db)
   db.exec('DROP TABLE health_logs')
   db.exec('PRAGMA user_version=2')
  }
  if (version < 3) {
   db.exec(readFileSync(new URL('../drizzle/0002_health_data_export.sql', import.meta.url), 'utf8'))
   db.exec('PRAGMA user_version=3')
  }
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

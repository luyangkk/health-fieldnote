import { openDatabase } from './sqlite.js'
import { createToken, defaultScopes } from './v1/tokens.js'

process.umask(0o077)
const [command, value, rawScopes, ...extra] = process.argv.slice(2)
const usage = 'Usage: node selfhost/token.js create <client-id> [scope,scope] | list | revoke <token-id>'
if (extra.length || !['create', 'list', 'revoke'].includes(command) || (command === 'list' ? value : !value) || (command !== 'create' && rawScopes)) {
 console.error(usage)
 process.exit(2)
}
const db = openDatabase(process.env.FIELDNOTE_DB ?? '/data/health.sqlite')
try {
 if (command === 'create') console.log(JSON.stringify(createToken(db, value, rawScopes ? rawScopes.split(',') : defaultScopes)))
 if (command === 'list') {
  const rows = db.prepare('SELECT id AS tokenId, client_id AS clientId, scopes, revoked_at AS revokedAt FROM fieldnote_tokens ORDER BY client_id, id').all()
  console.log(JSON.stringify(rows.map(row => ({ ...row, scopes: JSON.parse(row.scopes) }))))
 }
 if (command === 'revoke') {
  const result = db.prepare('UPDATE fieldnote_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), value)
  if (!result.changes) throw Error('No active token with that ID')
  console.log(JSON.stringify({ tokenId: value, revoked: true }))
 }
} catch (error) {
 console.error(error.message)
 process.exitCode = 1
} finally { db.close() }

import { randomBytes, randomUUID } from 'node:crypto'
import { contract, fail } from './protocol.js'
import { digest, OWNER } from './store.js'

export const allowedScopes = contract['x-scope-catalog']
export const defaultScopes = ['records:read', 'records:write', 'media:read', 'media:write']

export function createToken(db, clientId, scopes = defaultScopes) {
 if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId) || ['legacy', 'nothing', 'web'].includes(clientId)) throw Error('Invalid or reserved client ID')
 if (!scopes.length || scopes.some(scope => !allowedScopes.includes(scope))) throw Error('Invalid token scopes')
 const token = 'fn_' + randomBytes(32).toString('base64url')
 const tokenId = randomUUID()
 db.prepare('INSERT INTO fieldnote_tokens VALUES (?, ?, ?, ?, ?, NULL)').run(tokenId, OWNER, clientId, digest(token), JSON.stringify([...new Set(scopes)]))
 return { tokenId, clientId, token, scopes: [...new Set(scopes)] }
}

export function authenticate(db, value) {
 const match = /^Bearer (fn_[A-Za-z0-9_-]{43})$/i.exec(value ?? '')
 const token = match && db.prepare('SELECT id, owner_id, client_id, scopes, revoked_at FROM fieldnote_tokens WHERE digest = ?').get(digest(match[1]))
 if (!token) fail(401, 'UNAUTHENTICATED', 'A valid personal access token is required.')
 if (token.revoked_at) fail(401, 'TOKEN_REVOKED', 'This token has been revoked.')
 return { ownerId: token.owner_id, clientId: token.client_id, tokenId: token.id, scopes: JSON.parse(token.scopes) }
}

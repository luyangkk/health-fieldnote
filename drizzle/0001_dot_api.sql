CREATE TABLE fieldnote_state (
  owner_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT
) STRICT;

CREATE TABLE fieldnote_records (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  deleted_at TEXT,
  PRIMARY KEY (owner_id, kind, record_key)
) STRICT;
CREATE INDEX fieldnote_record_dates ON fieldnote_records (
  owner_id, kind, coalesce(json_extract(payload, '$.date'), json_extract(payload, '$.effectiveFrom'))
) WHERE deleted_at IS NULL;

CREATE TABLE fieldnote_sources (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (owner_id, kind, client_id, external_id)
) STRICT;

CREATE TABLE fieldnote_tokens (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  revoked_at TEXT
) STRICT;

CREATE TABLE fieldnote_idempotency (
  owner_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL CHECK (json_valid(response)),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, client_id, method, path, request_key)
) STRICT;
CREATE INDEX fieldnote_idempotency_expiry ON fieldnote_idempotency (expires_at);

CREATE TABLE fieldnote_image_bytes (
  owner_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (owner_id, sha256)
) STRICT;

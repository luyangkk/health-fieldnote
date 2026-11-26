-- Only normalized imported records and daily summaries; never the source file,
-- routes, heart-rate samples, credentials, or device/account metadata.
CREATE TABLE fieldnote_health_imports (
  owner_id TEXT NOT NULL,
  sample_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  record_fingerprint TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, sample_key)
) STRICT;

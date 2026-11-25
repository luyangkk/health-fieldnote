CREATE TABLE health_logs (
  owner_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

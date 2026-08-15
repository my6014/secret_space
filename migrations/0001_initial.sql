CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  author INTEGER NOT NULL CHECK (author IN (1, 2)),
  content_cipher TEXT NOT NULL,
  content_iv TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

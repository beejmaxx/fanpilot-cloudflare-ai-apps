CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  intent_type TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_challenges_email_created ON auth_challenges(email, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  organizer_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (organizer_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS room_memberships (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id),
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS room_memberships_user_id ON room_memberships(user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS invitations (
  token_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  created_by_user_id TEXT,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS invitations_room_id ON invitations(room_id, created_at DESC);

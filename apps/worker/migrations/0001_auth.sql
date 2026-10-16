-- Passkey auth (T4.2). Times are unix milliseconds.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY, -- base64url credential id
  user_id TEXT NOT NULL REFERENCES users (id),
  public_key BLOB NOT NULL, -- COSE public key
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX credentials_user_id ON credentials (user_id);

CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL REFERENCES users (id),
  code_hash TEXT NOT NULL, -- hex SHA-256 of the normalised code
  used_at INTEGER,
  PRIMARY KEY (user_id, code_hash)
);
CREATE INDEX recovery_codes_hash ON recovery_codes (code_hash);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL, -- register | login | add
  user_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expires_at ON challenges (expires_at);

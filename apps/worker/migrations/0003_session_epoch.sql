-- Session revocation. A session token carries the epoch it was issued under; bumping the epoch
-- invalidates every older token ("sign out everywhere", and after a recovery code is used).
ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

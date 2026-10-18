-- Registration cap (T8.6): counting the accounts created in the last hour reads this index.
CREATE INDEX users_created_at ON users (created_at);

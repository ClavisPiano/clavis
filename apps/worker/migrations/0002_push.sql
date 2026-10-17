-- Practice cue push subscriptions (T6.4). One row per browser push endpoint (per device).
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  p256dh TEXT NOT NULL, -- base64url subscriber public key (65 byte uncompressed P-256 point)
  auth TEXT NOT NULL, -- base64url 16 byte auth secret
  time_local TEXT NOT NULL, -- "HH:MM", learner local time
  weekdays INTEGER NOT NULL, -- bit mask, bit 0 = Sunday ... bit 6 = Saturday
  tz_offset_min INTEGER NOT NULL, -- minutes east of UTC (R6)
  habit TEXT NOT NULL DEFAULT '', -- habit phrase shown in the notification
  last_sent_day TEXT, -- learner day (YYYY-MM-DD) of the last cue sent
  last_practised_day TEXT, -- learner day the client last reported as practised
  created_at INTEGER NOT NULL -- unix ms
);
CREATE INDEX push_subscriptions_user_id ON push_subscriptions (user_id);

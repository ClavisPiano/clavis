-- Practice cue scaling (T8.3). cue_utc_min is the UTC minute of the day (0 to 1439) at which a
-- device's cue time falls, so the cron can ask the database for the rows near "now" instead of
-- reading the whole table every 15 minutes.
ALTER TABLE push_subscriptions ADD COLUMN cue_utc_min INTEGER;

UPDATE push_subscriptions
SET cue_utc_min = (
  (
    CAST(substr(time_local, 1, 2) AS INTEGER) * 60 + CAST(substr(time_local, 4, 2) AS INTEGER)
    - tz_offset_min
  ) % 1440 + 1440
) % 1440;

CREATE INDEX push_subscriptions_cue_utc_min ON push_subscriptions (cue_utc_min);

-- Weekly schedule: admins pick the weekdays matches are played; a daily cron creates upcoming
-- match days and opens check-in. Cancellations carry a reason shown to players.

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  -- Comma-separated ISO weekdays, 1 = Monday … 7 = Sunday. Empty = no automatic schedule.
  ('match_weekdays', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('schedule_kickoff', '07:00', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Check-in opens this many days before the match day, and closes this many hours before kickoff.
  ('schedule_open_days_before', '3', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('schedule_close_hours_before', '11', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- How far ahead match days are created.
  ('schedule_weeks_ahead', '2', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE match_days ADD COLUMN cancel_reason TEXT;
ALTER TABLE match_days ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0;

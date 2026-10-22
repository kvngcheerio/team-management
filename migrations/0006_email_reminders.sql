-- Check-in reminder emails. On match day, 2 hours before kick-off, players who haven't responded (and
-- check-in is still open) get one email. Each player gets at most one reminder per match day.

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('checkin_reminders_enabled', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- The check-in deadline is soft: players may still check in after it (until an admin closes check-in),
-- and those check-ins are flagged so lateness can be enforced later.
ALTER TABLE registrations ADD COLUMN checked_in_late INTEGER NOT NULL DEFAULT 0 CHECK (checked_in_late IN (0, 1));

-- Players can opt out of reminder emails from their profile.
ALTER TABLE players ADD COLUMN email_reminders INTEGER NOT NULL DEFAULT 1 CHECK (email_reminders IN (0, 1));

-- One row per (match day, player, kind): claimed before sending so concurrent runs never double-send.
CREATE TABLE email_log (
  id TEXT PRIMARY KEY NOT NULL,
  match_day_id TEXT NOT NULL REFERENCES match_days(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('checkin_reminder')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  provider TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (match_day_id, player_id, kind)
);

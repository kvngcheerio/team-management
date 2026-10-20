-- Self-signup with admin approval, profile photos, availability ("not available"),
-- team-sheet reveal time, announcements, disciplinary cards with fines, and dummy payments.

PRAGMA defer_foreign_keys = true;

-- ---------------------------------------------------------------------------
-- Players: approval for self-signups, and profile photos
-- ---------------------------------------------------------------------------
ALTER TABLE players ADD COLUMN approved INTEGER NOT NULL DEFAULT 1 CHECK (approved IN (0, 1));
ALTER TABLE players ADD COLUMN signup_source TEXT NOT NULL DEFAULT 'admin' CHECK (signup_source IN ('admin', 'invite', 'signup_link', 'guest_form', 'setup'));
ALTER TABLE players ADD COLUMN avatar_updated_at TEXT;

-- Small, client-resized images (max ~200 KB). Kept out of the players table so lists stay light.
CREATE TABLE player_avatars (
  player_id TEXT PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Registrations: add 'unavailable' (player said they can't make it).
-- SQLite can't alter a CHECK constraint, so the table is rebuilt.
-- ---------------------------------------------------------------------------
CREATE TABLE registrations_new (
  id TEXT PRIMARY KEY NOT NULL,
  match_day_id TEXT NOT NULL REFERENCES match_days(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'waitlist', 'withdrawn', 'rejected', 'unavailable')),
  source TEXT NOT NULL CHECK (source IN ('self', 'admin', 'guest_form')),
  attended INTEGER CHECK (attended IN (0, 1)),
  guest_note TEXT,
  queued_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (match_day_id, player_id)
);
INSERT INTO registrations_new (id, match_day_id, player_id, status, source, attended, guest_note, queued_at, created_at, updated_at)
  SELECT id, match_day_id, player_id, status, source, attended, guest_note, queued_at, created_at, updated_at FROM registrations;
DROP TABLE registrations;
ALTER TABLE registrations_new RENAME TO registrations;
CREATE INDEX registrations_day_status_idx ON registrations(match_day_id, status, queued_at);
CREATE INDEX registrations_player_idx ON registrations(player_id);

-- ---------------------------------------------------------------------------
-- Match days: when the team sheet becomes visible to players (UTC instant).
-- Existing rows default to 07:50 Africa/Lagos (06:50 UTC) on the match date.
-- ---------------------------------------------------------------------------
ALTER TABLE match_days ADD COLUMN team_sheet_at TEXT;
UPDATE match_days SET team_sheet_at = date || 'T06:50:00.000Z' WHERE team_sheet_at IS NULL;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('team_sheet_time', '07:50', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('fine_yellow', '2000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('fine_red', '5000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('currency', 'NGN', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('signup_enabled', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('signup_token', lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------------------------------------------------------------------------
-- Announcements
-- ---------------------------------------------------------------------------
CREATE TABLE announcements (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  author_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX announcements_order_idx ON announcements(pinned DESC, created_at DESC);

-- ---------------------------------------------------------------------------
-- Disciplinary cards. Each card carries its fine (amount fixed when the card is given).
-- Amounts are whole currency units (naira).
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id TEXT PRIMARY KEY NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id),
  user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'dummy',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'succeeded', 'failed', 'cancelled')),
  reference TEXT NOT NULL UNIQUE,
  card_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX payments_player_idx ON payments(player_id, created_at);

CREATE TABLE cards (
  id TEXT PRIMARY KEY NOT NULL,
  match_day_id TEXT NOT NULL REFERENCES match_days(id) ON DELETE CASCADE,
  match_id TEXT REFERENCES matches(id) ON DELETE SET NULL,
  player_id TEXT NOT NULL REFERENCES players(id),
  color TEXT NOT NULL CHECK (color IN ('yellow', 'red')),
  reason TEXT,
  fine_amount INTEGER NOT NULL CHECK (fine_amount >= 0),
  fine_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (fine_status IN ('unpaid', 'paid', 'waived')),
  paid_via TEXT CHECK (paid_via IN ('online', 'cash', 'wallet')),
  payment_id TEXT REFERENCES payments(id),
  paid_at TEXT,
  voided_at TEXT,
  void_reason TEXT,
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX cards_player_idx ON cards(player_id, fine_status);
CREATE INDEX cards_day_idx ON cards(match_day_id);

-- ---------------------------------------------------------------------------
-- Admin invites: single-use links that create a new account with the admin role.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_invites (
  token_hash TEXT PRIMARY KEY NOT NULL,
  note TEXT,
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

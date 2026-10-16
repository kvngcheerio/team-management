-- Matchday initial schema.
-- All timestamps are stored as UTC ISO-8601 strings (e.g. 2026-10-15T15:04:05.000Z).
-- Calendar dates (season dates, match-day dates) are stored as local YYYY-MM-DD strings
-- interpreted in the season's timezone; kickoff times as local HH:MM.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Authentication (Better Auth core schema + app role)
-- ---------------------------------------------------------------------------
CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON session(userId);

CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt DATE,
  refreshTokenExpiresAt DATE,
  scope TEXT,
  password TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);
CREATE INDEX account_user_idx ON account(userId);

CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt DATE NOT NULL,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

-- ---------------------------------------------------------------------------
-- Settings (single-row key/value)
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO settings (key, value, updated_at) VALUES
  ('group_name', 'Matchday FC', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('timezone', 'Africa/Lagos', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('default_capacity', '20', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('default_team_size', '5', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('default_set_count', '4', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('default_venue', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------------------------------------------------------------------------
-- Players: a person in the playing pool. May exist without a login (user_id NULL).
-- ---------------------------------------------------------------------------
CREATE TABLE players (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member', 'guest')),
  user_id TEXT UNIQUE REFERENCES user(id) ON DELETE SET NULL,
  -- Private contact details: only admins can read them.
  contact_email TEXT,
  contact_phone TEXT,
  -- Private admin-entered rating, 1 (weakest) .. 10 (strongest).
  skill_rating INTEGER NOT NULL DEFAULT 5 CHECK (skill_rating BETWEEN 1 AND 10),
  gk_preference TEXT NOT NULL DEFAULT 'none' CHECK (gk_preference IN ('none', 'can', 'prefers')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  member_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX players_kind_idx ON players(kind, active);

CREATE TABLE player_invites (
  token_hash TEXT PRIMARY KEY NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX player_invites_player_idx ON player_invites(player_id);

-- ---------------------------------------------------------------------------
-- Seasons
-- ---------------------------------------------------------------------------
CREATE TABLE seasons (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_date > start_date)
);

-- Frozen final table written when a season is closed.
CREATE TABLE season_final_standings (
  season_id TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  position INTEGER NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL,
  points INTEGER NOT NULL,
  daily_wins INTEGER NOT NULL,
  appearances INTEGER NOT NULL,
  goals INTEGER NOT NULL,
  assists INTEGER NOT NULL,
  PRIMARY KEY (season_id, player_id)
);

-- ---------------------------------------------------------------------------
-- Match days
-- ---------------------------------------------------------------------------
CREATE TABLE match_days (
  id TEXT PRIMARY KEY NOT NULL,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  date TEXT NOT NULL,
  kickoff_time TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 2 AND 200),
  checkin_deadline TEXT NOT NULL,
  team_size INTEGER NOT NULL CHECK (team_size BETWEEN 1 AND 30),
  set_count INTEGER NOT NULL CHECK (set_count BETWEEN 2 AND 12),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'checkin_open', 'locked', 'in_progress', 'finalized', 'cancelled')),
  tie_policy TEXT NOT NULL DEFAULT 'shared' CHECK (tie_policy IN ('shared', 'playoff')),
  public_token TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  teams_published_at TEXT,
  started_at TEXT,
  finalized_at TEXT,
  cancelled_at TEXT,
  -- Optimistic concurrency: bumped on every state-changing write.
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX match_days_season_idx ON match_days(season_id, date);
CREATE INDEX match_days_status_idx ON match_days(status, date);

-- Registered-to-play (status) is separate from actually-attended (attended).
CREATE TABLE registrations (
  id TEXT PRIMARY KEY NOT NULL,
  match_day_id TEXT NOT NULL REFERENCES match_days(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'waitlist', 'withdrawn', 'rejected')),
  source TEXT NOT NULL CHECK (source IN ('self', 'admin', 'guest_form')),
  -- NULL = not yet marked, 1 = present, 0 = absent.
  attended INTEGER CHECK (attended IN (0, 1)),
  guest_note TEXT,
  -- Monotonic ordering for the waiting list.
  queued_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (match_day_id, player_id)
);
CREATE INDEX registrations_day_status_idx ON registrations(match_day_id, status, queued_at);
CREATE INDEX registrations_player_idx ON registrations(player_id);

-- ---------------------------------------------------------------------------
-- Sets (teams) and rosters
-- ---------------------------------------------------------------------------
CREATE TABLE sets (
  id TEXT PRIMARY KEY NOT NULL,
  match_day_id TEXT NOT NULL REFERENCES match_days(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  is_daily_winner INTEGER NOT NULL DEFAULT 0,
  UNIQUE (match_day_id, idx),
  UNIQUE (match_day_id, id)
);

CREATE TABLE roster_entries (
  match_day_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id),
  role TEXT NOT NULL DEFAULT 'starter' CHECK (role IN ('starter', 'sub')),
  is_goalkeeper INTEGER NOT NULL DEFAULT 0,
  -- Snapshot of membership taken when play starts (roster lock). Guests are not eligible.
  member_at_lock INTEGER,
  -- A player can appear in at most one set per match day.
  PRIMARY KEY (match_day_id, player_id),
  FOREIGN KEY (match_day_id, set_id) REFERENCES sets(match_day_id, id) ON DELETE CASCADE
);
CREATE INDEX roster_set_idx ON roster_entries(set_id);

-- ---------------------------------------------------------------------------
-- Matches and goal events
-- ---------------------------------------------------------------------------
CREATE TABLE matches (
  id TEXT PRIMARY KEY NOT NULL,
  match_day_id TEXT NOT NULL REFERENCES match_days(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  home_set_id TEXT NOT NULL,
  away_set_id TEXT NOT NULL,
  home_score INTEGER NOT NULL DEFAULT 0 CHECK (home_score >= 0),
  away_score INTEGER NOT NULL DEFAULT 0 CHECK (away_score >= 0),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'void')),
  is_playoff INTEGER NOT NULL DEFAULT 0 CHECK (is_playoff IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (home_set_id <> away_set_id),
  UNIQUE (match_day_id, seq),
  FOREIGN KEY (match_day_id, home_set_id) REFERENCES sets(match_day_id, id),
  FOREIGN KEY (match_day_id, away_set_id) REFERENCES sets(match_day_id, id)
);
CREATE INDEX matches_day_idx ON matches(match_day_id, seq);

CREATE TABLE goal_events (
  id TEXT PRIMARY KEY NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  -- The set credited with the goal.
  set_id TEXT NOT NULL REFERENCES sets(id),
  kind TEXT NOT NULL CHECK (kind IN ('normal', 'own_goal', 'unattributed')),
  scorer_player_id TEXT REFERENCES players(id),
  assist_player_id TEXT REFERENCES players(id),
  created_at TEXT NOT NULL,
  CHECK (assist_player_id IS NULL OR scorer_player_id IS NULL OR assist_player_id <> scorer_player_id),
  CHECK (kind <> 'unattributed' OR (scorer_player_id IS NULL AND assist_player_id IS NULL)),
  CHECK (kind <> 'own_goal' OR (scorer_player_id IS NOT NULL AND assist_player_id IS NULL)),
  CHECK (kind <> 'normal' OR scorer_player_id IS NOT NULL)
);
CREATE INDEX goal_events_match_idx ON goal_events(match_id);
CREATE INDEX goal_events_scorer_idx ON goal_events(scorer_player_id);
CREATE INDEX goal_events_assist_idx ON goal_events(assist_player_id);

-- ---------------------------------------------------------------------------
-- Finalized per-player day records. Official standings are SUMs over these rows
-- for finalized match days only. Recomputed wholesale on finalization/correction,
-- and the primary key makes duplicate awards impossible.
-- ---------------------------------------------------------------------------
CREATE TABLE day_player_stats (
  match_day_id TEXT NOT NULL REFERENCES match_days(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  set_id TEXT REFERENCES sets(id),
  attended INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 0,
  daily_win INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0 CHECK (points IN (0, 3)),
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  own_goals INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_day_id, player_id)
);
CREATE INDEX day_player_stats_player_idx ON day_player_stats(player_id);

-- ---------------------------------------------------------------------------
-- Audit log for admin actions and corrections.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  actor_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  match_day_id TEXT,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_log_created_idx ON audit_log(created_at);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Rate limiting (fixed window counters) for public forms and sign-in.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- ---------------------------------------------------------------------------
-- Batch guard: inserting changes() aborts (and rolls back) a D1 batch when the
-- preceding conditional UPDATE matched no rows.
-- ---------------------------------------------------------------------------
CREATE TABLE _batch_guard (
  ok INTEGER NOT NULL CHECK (ok > 0)
);

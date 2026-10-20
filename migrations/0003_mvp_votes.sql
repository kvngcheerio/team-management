-- MVP voting: a weekly (per match day) vote that opens when the day is finalized, and a season vote
-- opened by an admin. One vote per voter per poll (changeable while open); no self-votes.

CREATE TABLE polls (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('matchday', 'season')),
  match_day_id TEXT REFERENCES match_days(id) ON DELETE CASCADE,
  season_id TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  closed_early_at TEXT,
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  CHECK (closes_at > opens_at),
  CHECK ((kind = 'matchday' AND match_day_id IS NOT NULL) OR (kind = 'season' AND match_day_id IS NULL))
);
CREATE UNIQUE INDEX polls_matchday_unique ON polls(match_day_id) WHERE kind = 'matchday';
CREATE UNIQUE INDEX polls_season_unique ON polls(season_id) WHERE kind = 'season';
CREATE INDEX polls_closes_idx ON polls(closes_at);

CREATE TABLE votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_player_id TEXT NOT NULL REFERENCES players(id),
  candidate_player_id TEXT NOT NULL REFERENCES players(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, voter_player_id),
  CHECK (voter_player_id <> candidate_player_id)
);
CREATE INDEX votes_candidate_idx ON votes(poll_id, candidate_player_id);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('mvp_vote_hours', '48', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------------------------------------------------------------------------
-- Finance ledger: admin-recorded expenditures and other income. Fine payments are read from
-- `cards` (paid online or in cash), so they're never double-entered.
-- Amounts are whole currency units (naira).
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  entry_date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ledger_entries_date_idx ON ledger_entries(entry_date);

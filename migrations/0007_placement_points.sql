-- Placement points: 2nd and 3rd place sets now earn points too (3/2/1 with 4 sets, 3/1/0 with 3),
-- so day_player_stats.points is no longer only 0 or 3. SQLite can't alter a CHECK, so rebuild the table.
CREATE TABLE day_player_stats_new (
  match_day_id TEXT NOT NULL REFERENCES match_days(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id),
  set_id TEXT REFERENCES sets(id),
  attended INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 0,
  daily_win INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0 CHECK (points BETWEEN 0 AND 3),
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  own_goals INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_day_id, player_id)
);
INSERT INTO day_player_stats_new (match_day_id, player_id, set_id, attended, eligible, daily_win, points, goals, assists, own_goals)
  SELECT match_day_id, player_id, set_id, attended, eligible, daily_win, points, goals, assists, own_goals FROM day_player_stats;
DROP TABLE day_player_stats;
ALTER TABLE day_player_stats_new RENAME TO day_player_stats;
CREATE INDEX day_player_stats_player_idx ON day_player_stats(player_id);

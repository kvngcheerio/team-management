import { rankBy, rankStandings, type StandingRow } from "../../shared/rules";
import { all, first } from "./db";

interface Agg {
  playerId: string;
  displayName: string;
  kind: "member" | "guest";
  points: number;
  dailyWins: number;
  appearances: number;
  goals: number;
  assists: number;
}

/** Aggregate finalized day records for a season. Official standings come only from finalized match days. */
export async function seasonAggregates(db: D1Database, seasonId: string): Promise<Agg[]> {
  return all<Agg>(
    db,
    `SELECT p.id AS playerId, p.display_name AS displayName, p.kind AS kind,
            SUM(s.points) AS points, SUM(s.daily_win) AS dailyWins, SUM(s.attended) AS appearances,
            SUM(s.goals) AS goals, SUM(s.assists) AS assists
       FROM day_player_stats s
       JOIN match_days md ON md.id = s.match_day_id AND md.status = 'finalized' AND md.season_id = ?
       JOIN players p ON p.id = s.player_id
      GROUP BY p.id`,
    seasonId,
  );
}

export interface SeasonTables {
  table: (StandingRow & { kind: string })[];
  goals: (Agg & { position: number })[];
  assists: (Agg & { position: number })[];
  frozen: boolean;
}

export async function seasonTables(db: D1Database, seasonId: string): Promise<SeasonTables> {
  const season = await first<{ status: string }>(db, "SELECT status FROM seasons WHERE id = ?", seasonId);
  const aggs = await seasonAggregates(db, seasonId);
  const goals = rankBy(aggs, (r) => r.goals);
  const assists = rankBy(aggs, (r) => r.assists);
  if (season?.status === "closed") {
    const frozen = await all<Omit<StandingRow, "shared"> & { kind: string; shared: number }>(
      db,
      `SELECT f.player_id AS playerId, f.display_name AS displayName, f.position, f.shared, f.points, f.daily_wins AS dailyWins,
              f.appearances, f.goals, f.assists, p.kind
         FROM season_final_standings f JOIN players p ON p.id = f.player_id WHERE f.season_id = ? ORDER BY f.position, f.display_name`,
      seasonId,
    );
    return { table: frozen.map((r) => ({ ...r, shared: Boolean(r.shared) })), goals, assists, frozen: true };
  }
  // League table: members (guests earn no league points) plus anyone who earned points before converting.
  const leagueRows = aggs.filter((a) => a.kind === "member" || a.points > 0);
  const kinds = new Map(aggs.map((a) => [a.playerId, a.kind]));
  const table = rankStandings(leagueRows).map((r) => ({ ...r, kind: kinds.get(r.playerId) ?? "member" }));
  return { table, goals, assists, frozen: false };
}

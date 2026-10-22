import { chooseSetForLatePlayer, computeDayStats, type DayState, type SetFill, type GoalKind, type MatchDayStatus, type MatchStatus, type TiePolicy } from "../../shared/rules";
import type { Ctx } from "../env";
import { all, atomic, auditStmt, ConflictError, first, guard, HttpError, nowIso, stmt, type AuditEntry } from "./db";

export interface MatchDayRow {
  id: string;
  season_id: string;
  date: string;
  kickoff_time: string;
  venue: string;
  capacity: number;
  checkin_deadline: string;
  team_size: number;
  set_count: number;
  status: MatchDayStatus;
  tie_policy: TiePolicy;
  public_token: string;
  notes: string;
  teams_published_at: string | null;
  started_at: string | null;
  finalized_at: string | null;
  cancelled_at: string | null;
  team_sheet_at: string | null;
  cancel_reason: string | null;
  auto_created: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SetRow {
  id: string;
  match_day_id: string;
  idx: number;
  name: string;
  color: string;
  is_daily_winner: number;
}
export interface RosterRow {
  match_day_id: string;
  set_id: string;
  player_id: string;
  role: "starter" | "sub";
  is_goalkeeper: number;
  member_at_lock: number | null;
  display_name: string;
  kind: "member" | "guest";
}
export interface MatchRow {
  id: string;
  match_day_id: string;
  seq: number;
  home_set_id: string;
  away_set_id: string;
  home_score: number;
  away_score: number;
  status: MatchStatus;
  is_playoff: number;
  created_at: string;
  updated_at: string;
}
export interface GoalRow {
  id: string;
  match_id: string;
  set_id: string;
  kind: GoalKind;
  scorer_player_id: string | null;
  assist_player_id: string | null;
  created_at: string;
}
export interface RegistrationRow {
  id: string;
  match_day_id: string;
  player_id: string;
  status: "pending" | "confirmed" | "waitlist" | "withdrawn" | "rejected" | "unavailable";
  source: "self" | "admin" | "guest_form";
  attended: number | null;
  guest_note: string | null;
  fee_status: "none" | "unpaid" | "paid" | "free" | "waived";
  fee_amount: number;
  checked_in_late: number;
  queued_at: string;
  created_at: string;
  display_name: string;
  kind: "member" | "guest";
  contact_email: string | null;
  contact_phone: string | null;
}

export async function loadDay(db: D1Database, id: string): Promise<MatchDayRow> {
  const day = await first<MatchDayRow>(db, "SELECT * FROM match_days WHERE id = ?", id);
  if (!day) throw new HttpError(404, "Match day not found.");
  return day;
}

export interface LoadedDay {
  day: MatchDayRow;
  sets: SetRow[];
  roster: RosterRow[];
  matches: MatchRow[];
  goals: GoalRow[];
  registrations: RegistrationRow[];
}

export async function loadDayFull(db: D1Database, id: string): Promise<LoadedDay> {
  const [dayRes, sets, roster, matches, goals, registrations] = await db.batch([
    stmt(db, "SELECT * FROM match_days WHERE id = ?", id),
    stmt(db, "SELECT * FROM sets WHERE match_day_id = ? ORDER BY idx", id),
    stmt(
      db,
      `SELECT r.*, p.display_name, p.kind FROM roster_entries r JOIN players p ON p.id = r.player_id
       WHERE r.match_day_id = ? ORDER BY r.is_goalkeeper DESC, r.role, p.display_name`,
      id,
    ),
    stmt(db, "SELECT * FROM matches WHERE match_day_id = ? ORDER BY seq", id),
    stmt(
      db,
      `SELECT g.* FROM goal_events g JOIN matches m ON m.id = g.match_id WHERE m.match_day_id = ? ORDER BY g.created_at, g.id`,
      id,
    ),
    stmt(
      db,
      `SELECT r.*, p.display_name, p.kind, p.contact_email, p.contact_phone FROM registrations r JOIN players p ON p.id = r.player_id
       WHERE r.match_day_id = ? ORDER BY r.queued_at, r.id`,
      id,
    ),
  ]);
  const day = (dayRes!.results as MatchDayRow[])[0];
  if (!day) throw new HttpError(404, "Match day not found.");
  return {
    day,
    sets: sets!.results as SetRow[],
    roster: roster!.results as RosterRow[],
    matches: matches!.results as MatchRow[],
    goals: goals!.results as GoalRow[],
    registrations: registrations!.results as RegistrationRow[],
  };
}

/** Each published set's size and total skill rating, for late placement. */
export async function setFills(db: D1Database, loaded: LoadedDay): Promise<SetFill[]> {
  const ratings = new Map(
    (await all<{ id: string; skill_rating: number }>(db, "SELECT p.id, p.skill_rating FROM roster_entries r JOIN players p ON p.id = r.player_id WHERE r.match_day_id = ?", loaded.day.id)).map((r) => [r.id, r.skill_rating]),
  );
  return loaded.sets.map((s) => {
    const members = loaded.roster.filter((r) => r.set_id === s.id);
    return { setId: s.id, idx: s.idx, size: members.length, totalRating: members.reduce((n, r) => n + (ratings.get(r.player_id) ?? 5), 0) };
  });
}

/**
 * A player confirmed after teams were published (late check-in, promotion, paid guest fee…) joins a
 * team automatically (`chooseSetForLatePlayer`). No-op unless teams exist, play hasn't started, and the
 * player is confirmed but not yet in a set. Retries on a concurrent roster change; never throws, since
 * the registration itself has already succeeded (admins can still place the player by hand).
 */
export async function autoPlaceInTeam(c: Ctx, dayId: string, playerId: string): Promise<{ setName: string; role: "starter" | "sub" } | null> {
  const db = c.env.DB;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const loaded = await loadDayFull(db, dayId);
      const { day } = loaded;
      if (!["checkin_open", "locked"].includes(day.status) || loaded.sets.length === 0) return null;
      if (loaded.registrations.find((r) => r.player_id === playerId)?.status !== "confirmed") return null;
      if (loaded.roster.some((r) => r.player_id === playerId)) return null;
      const choice = chooseSetForLatePlayer(await setFills(db, loaded), day.team_size);
      if (!choice) return null;
      const setName = loaded.sets.find((s) => s.id === choice.set.setId)!.name;
      await commitDay(
        c,
        day,
        [
          stmt(
            db,
            `INSERT INTO roster_entries (match_day_id, set_id, player_id, role, is_goalkeeper)
             SELECT ?1, ?2, ?3, ?4, 0 WHERE EXISTS (SELECT 1 FROM registrations WHERE match_day_id = ?1 AND player_id = ?3 AND status = 'confirmed')`,
            day.id,
            choice.set.setId,
            playerId,
            choice.role,
          ),
          guard(db),
        ],
        { audit: { action: "roster.auto_place", entityType: "player", entityId: playerId, after: { set: setName, role: choice.role } } },
      );
      return { setName, role: choice.role };
    } catch (err) {
      if (!(err instanceof ConflictError)) {
        console.error("auto-place failed", dayId, playerId, err);
        return null;
      }
    }
  }
  console.error("auto-place gave up after concurrent changes", dayId, playerId);
  return null;
}

export function toDayState(l: LoadedDay): DayState {
  const attendance: Record<string, boolean | null> = {};
  const regByPlayer = new Map(l.registrations.map((r) => [r.player_id, r]));
  for (const r of l.roster) {
    const reg = regByPlayer.get(r.player_id);
    attendance[r.player_id] = reg?.attended == null ? null : reg.attended === 1;
  }
  return {
    setIds: l.sets.map((s) => s.id),
    tiePolicy: l.day.tie_policy,
    matches: l.matches.map((m) => ({
      id: m.id,
      seq: m.seq,
      homeSetId: m.home_set_id,
      awaySetId: m.away_set_id,
      homeScore: m.home_score,
      awayScore: m.away_score,
      status: m.status,
      isPlayoff: m.is_playoff === 1,
    })),
    goals: l.goals.map((g) => ({
      id: g.id,
      matchId: g.match_id,
      setId: g.set_id,
      kind: g.kind,
      scorerPlayerId: g.scorer_player_id,
      assistPlayerId: g.assist_player_id,
    })),
    roster: l.roster.map((r) => ({
      playerId: r.player_id,
      setId: r.set_id,
      memberAtLock: r.member_at_lock == null ? null : r.member_at_lock === 1,
    })),
    attendance,
  };
}

/** Replace the finalized records for a day with freshly computed ones (used by finalize and corrections). */
export function statsStatements(db: D1Database, dayId: string, state: DayState): D1PreparedStatement[] {
  const { winner, stats } = computeDayStats(state);
  const winners = winner.status === "decided" ? winner.winnerSetIds : [];
  const out: D1PreparedStatement[] = [stmt(db, "DELETE FROM day_player_stats WHERE match_day_id = ?", dayId)];
  for (const s of stats) {
    out.push(
      stmt(
        db,
        `INSERT INTO day_player_stats (match_day_id, player_id, set_id, attended, eligible, daily_win, points, goals, assists, own_goals)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        dayId,
        s.playerId,
        s.setId,
        s.attended ? 1 : 0,
        s.eligible ? 1 : 0,
        s.dailyWin ? 1 : 0,
        s.points,
        s.goals,
        s.assists,
        s.ownGoals,
      ),
    );
  }
  out.push(
    stmt(
      db,
      `UPDATE sets SET is_daily_winner = CASE WHEN id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END WHERE match_day_id = ?`,
      JSON.stringify(winners),
      dayId,
    ),
  );
  return out;
}

export interface CommitOptions {
  audit?: AuditEntry | AuditEntry[];
  /** When set (finalized days), official records are recomputed from this post-change state in the same batch. */
  recompute?: DayState;
  conflictMessage?: string;
}

/**
 * Commit a day-scoped mutation atomically, guarded by the day's version so concurrent
 * read-modify-write requests cannot interleave. Any failure rolls back everything.
 */
export async function commitDay(c: Ctx, day: MatchDayRow, statements: D1PreparedStatement[], opts: CommitOptions = {}) {
  const db = c.env.DB;
  const batch: D1PreparedStatement[] = [
    stmt(db, "UPDATE match_days SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?", nowIso(), day.id, day.version),
    guard(db),
    ...statements,
  ];
  if (opts.recompute) batch.push(...statsStatements(db, day.id, opts.recompute));
  const audits = opts.audit ? (Array.isArray(opts.audit) ? opts.audit : [opts.audit]) : [];
  for (const a of audits) batch.push(auditStmt(c, { matchDayId: day.id, ...a }));
  return atomic(db, batch, opts.conflictMessage);
}

/**
 * Corrections to a finalized day require a reason and an open season. Returns whether the
 * mutation must recompute official records.
 */
export async function correctionContext(c: Ctx, day: MatchDayRow, reason: string | undefined | null): Promise<boolean> {
  if (day.status === "cancelled") throw new HttpError(409, "This match day was cancelled.");
  if (day.status !== "finalized") return false;
  if (!reason || reason.trim().length < 3) {
    throw new HttpError(422, "This match day is finalized. Give a reason for the correction.");
  }
  const season = await first<{ status: string }>(c.env.DB, "SELECT status FROM seasons WHERE id = ?", day.season_id);
  if (season?.status === "closed") throw new HttpError(409, "The season is closed; its results are frozen.");
  return true;
}

export async function seasonOf(db: D1Database, seasonId: string) {
  return first<{ id: string; status: string; timezone: string; start_date: string; end_date: string; name: string }>(
    db,
    "SELECT * FROM seasons WHERE id = ?",
    seasonId,
  );
}

export async function registrationsForDay(db: D1Database, dayId: string) {
  return all<RegistrationRow>(
    db,
    `SELECT r.*, p.display_name, p.kind, p.contact_email, p.contact_phone FROM registrations r JOIN players p ON p.id = r.player_id
     WHERE r.match_day_id = ? ORDER BY r.queued_at, r.id`,
    dayId,
  );
}

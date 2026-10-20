import { Hono } from "hono";
import { z } from "zod";
import { defaultSeasonEnd, isDateInSeason, seasonsOverlap, validateSeasonDates } from "../../shared/rules";
import { isValidTimeZone } from "../../shared/time";
import type { AppEnv } from "../env";
import { all, atomic, auditStmt, first, getSetting, guard, HttpError, newId, nowIso, stmt } from "../lib/db";
import { requireAdmin, requireUser } from "../lib/guards";
import { seasonTables } from "../lib/standings";
import { body, zDate, zName, zReason } from "../lib/validate";
import { mvpAwards } from "./mvp";

export const seasonRoutes = new Hono<AppEnv>();

interface SeasonRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  timezone: string;
  status: "active" | "closed";
  closed_at: string | null;
  created_at: string;
  match_days?: number;
  finalized_days?: number;
  started_days?: number;
}

const toSeason = (s: SeasonRow) => ({
  id: s.id,
  name: s.name,
  startDate: s.start_date,
  endDate: s.end_date,
  timezone: s.timezone,
  status: s.status,
  closedAt: s.closed_at,
  matchDays: s.match_days ?? 0,
  finalizedDays: s.finalized_days ?? 0,
  datesEditable: s.status === "active" && (s.started_days ?? 0) === 0,
});

const SEASON_LIST_SQL = `SELECT s.*,
   (SELECT COUNT(*) FROM match_days md WHERE md.season_id = s.id AND md.status <> 'cancelled') AS match_days,
   (SELECT COUNT(*) FROM match_days md WHERE md.season_id = s.id AND md.status = 'finalized') AS finalized_days,
   (SELECT COUNT(*) FROM match_days md WHERE md.season_id = s.id AND md.status IN ('in_progress', 'finalized')) AS started_days
 FROM seasons s`;

seasonRoutes.get("/seasons", requireUser, async (c) => {
  const rows = await all<SeasonRow>(c.env.DB, `${SEASON_LIST_SQL} ORDER BY s.start_date DESC`);
  return c.json({ seasons: rows.map(toSeason) });
});

seasonRoutes.get("/seasons/:id/standings", requireUser, async (c) => {
  const season = await first<SeasonRow>(c.env.DB, `${SEASON_LIST_SQL} WHERE s.id = ?`, c.req.param("id"));
  if (!season) throw new HttpError(404, "Season not found.");
  return c.json({ season: toSeason(season), ...(await seasonTables(c.env.DB, season.id)) });
});

async function assertNoOverlap(db: D1Database, startDate: string, endDate: string, exceptId?: string) {
  const others = await all<SeasonRow>(db, "SELECT * FROM seasons WHERE id <> ?", exceptId ?? "");
  const clash = others.find((o) => seasonsOverlap({ startDate, endDate }, { startDate: o.start_date, endDate: o.end_date }));
  if (clash) throw new HttpError(409, `These dates overlap with season “${clash.name}”.`);
}

seasonRoutes.post("/seasons", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({ name: zName, startDate: zDate, endDate: zDate.optional(), timezone: z.string().max(64).optional() }),
  );
  const endDate = input.endDate ?? defaultSeasonEnd(input.startDate);
  const err = validateSeasonDates(input.startDate, endDate);
  if (err) throw new HttpError(422, err);
  const timezone = input.timezone || (await getSetting(c.env.DB, "timezone", "Africa/Lagos"));
  if (!isValidTimeZone(timezone)) throw new HttpError(422, "Unknown timezone.");
  await assertNoOverlap(c.env.DB, input.startDate, endDate);
  const id = newId();
  const now = nowIso();
  const db = c.env.DB;
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO seasons (id, name, start_date, end_date, timezone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      id,
      input.name,
      input.startDate,
      endDate,
      timezone,
      now,
      now,
    ),
    auditStmt(c, { action: "season.create", entityType: "season", entityId: id, after: { ...input, endDate, timezone } }),
  ]);
  const season = await first<SeasonRow>(db, `${SEASON_LIST_SQL} WHERE s.id = ?`, id);
  return c.json({ season: toSeason(season!) }, 201);
});

seasonRoutes.patch("/seasons/:id", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({ name: zName.optional(), startDate: zDate.optional(), endDate: zDate.optional(), timezone: z.string().max(64).optional() }),
  );
  const db = c.env.DB;
  const season = await first<SeasonRow & { started_days: number }>(db, `${SEASON_LIST_SQL} WHERE s.id = ?`, c.req.param("id"));
  if (!season) throw new HttpError(404, "Season not found.");
  if (season.status === "closed") throw new HttpError(409, "Closed seasons cannot be edited.");
  const changingDates = input.startDate !== undefined || input.endDate !== undefined || input.timezone !== undefined;
  if (changingDates && season.started_days > 0) {
    throw new HttpError(409, "Season dates are locked once play has started on a match day.");
  }
  const startDate = input.startDate ?? season.start_date;
  const endDate = input.endDate ?? (input.startDate ? defaultSeasonEnd(input.startDate) : season.end_date);
  const err = validateSeasonDates(startDate, endDate);
  if (err) throw new HttpError(422, err);
  const timezone = input.timezone ?? season.timezone;
  if (!isValidTimeZone(timezone)) throw new HttpError(422, "Unknown timezone.");
  await assertNoOverlap(db, startDate, endDate, season.id);
  const days = await all<{ date: string }>(db, "SELECT date FROM match_days WHERE season_id = ? AND status <> 'cancelled'", season.id);
  if (days.some((d) => !isDateInSeason(d.date, { startDate, endDate }))) {
    throw new HttpError(409, "Some match days would fall outside the new dates.");
  }
  await atomic(db, [
    stmt(
      db,
      `UPDATE seasons SET name = ?, start_date = ?, end_date = ?, timezone = ?, updated_at = ?
       WHERE id = ? AND status = 'active'
         AND NOT EXISTS (SELECT 1 FROM match_days WHERE season_id = ? AND status IN ('in_progress', 'finalized') AND ? = 1)`,
      input.name ?? season.name,
      startDate,
      endDate,
      timezone,
      nowIso(),
      season.id,
      season.id,
      changingDates ? 1 : 0,
    ),
    guard(db),
    auditStmt(c, {
      action: "season.update",
      entityType: "season",
      entityId: season.id,
      before: { name: season.name, startDate: season.start_date, endDate: season.end_date, timezone: season.timezone },
      after: { name: input.name ?? season.name, startDate, endDate, timezone },
    }),
  ]);
  const updated = await first<SeasonRow>(db, `${SEASON_LIST_SQL} WHERE s.id = ?`, season.id);
  return c.json({ season: toSeason(updated!) });
});

seasonRoutes.post("/seasons/:id/close", requireAdmin, async (c) => {
  const input = await body(c, z.object({ reason: zReason }));
  const db = c.env.DB;
  const season = await first<SeasonRow>(db, "SELECT * FROM seasons WHERE id = ?", c.req.param("id"));
  if (!season) throw new HttpError(404, "Season not found.");
  if (season.status === "closed") return c.json({ ok: true, alreadyClosed: true });
  const open = await first<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM match_days WHERE season_id = ? AND status NOT IN ('finalized', 'cancelled')",
    season.id,
  );
  if ((open?.n ?? 0) > 0) {
    throw new HttpError(409, `Finalize or cancel the season's ${open!.n} open match day(s) before closing it.`);
  }
  const { table } = await seasonTables(db, season.id);
  const now = nowIso();
  await atomic(
    db,
    [
      stmt(db, "UPDATE seasons SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'active'", now, now, season.id),
      guard(db),
      stmt(db, "DELETE FROM season_final_standings WHERE season_id = ?", season.id),
      ...table.map((r) =>
        stmt(
          db,
          `INSERT INTO season_final_standings (season_id, player_id, position, shared, display_name, points, daily_wins, appearances, goals, assists)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          season.id,
          r.playerId,
          r.position,
          r.shared ? 1 : 0,
          r.displayName,
          r.points,
          r.dailyWins,
          r.appearances,
          r.goals,
          r.assists,
        ),
      ),
      auditStmt(c, { action: "season.close", entityType: "season", entityId: season.id, reason: input.reason, after: { rows: table.length } }),
    ],
    "The season was already closed.",
  );
  return c.json({ ok: true });
});

/** Season stats: appearances, wins, goals, assists, cards — plus fines totals for admins. */
seasonRoutes.get("/seasons/:id/stats", requireUser, async (c) => {
  const db = c.env.DB;
  const season = await first<SeasonRow>(db, `${SEASON_LIST_SQL} WHERE s.id = ?`, c.req.param("id"));
  if (!season) throw new HttpError(404, "Season not found.");
  const rows = await all<{
    playerId: string;
    displayName: string;
    kind: string;
    avatar_updated_at: string | null;
    appearances: number | null;
    dailyWins: number | null;
    points: number | null;
    goals: number | null;
    assists: number | null;
    ownGoals: number | null;
    yellow: number | null;
    red: number | null;
    owed: number | null;
    paid: number | null;
  }>(
    db,
    `WITH st AS (
       SELECT d.player_id, SUM(d.attended) AS appearances, SUM(d.daily_win) AS dailyWins, SUM(d.points) AS points,
              SUM(d.goals) AS goals, SUM(d.assists) AS assists, SUM(d.own_goals) AS ownGoals
         FROM day_player_stats d JOIN match_days md ON md.id = d.match_day_id AND md.status = 'finalized' AND md.season_id = ?1
        GROUP BY d.player_id),
     cd AS (
       SELECT k.player_id, SUM(k.color = 'yellow') AS yellow, SUM(k.color = 'red') AS red,
              SUM(CASE WHEN k.fine_status = 'unpaid' THEN k.fine_amount ELSE 0 END) AS owed,
              SUM(CASE WHEN k.fine_status = 'paid' THEN k.fine_amount ELSE 0 END) AS paid
         FROM cards k JOIN match_days md ON md.id = k.match_day_id AND md.status <> 'cancelled' AND md.season_id = ?1
        WHERE k.voided_at IS NULL GROUP BY k.player_id)
     SELECT p.id AS playerId, p.display_name AS displayName, p.kind, p.avatar_updated_at,
            st.appearances, st.dailyWins, st.points, st.goals, st.assists, st.ownGoals, cd.yellow, cd.red, cd.owed, cd.paid
       FROM players p LEFT JOIN st ON st.player_id = p.id LEFT JOIN cd ON cd.player_id = p.id
      WHERE st.player_id IS NOT NULL OR cd.player_id IS NOT NULL
      ORDER BY p.display_name COLLATE NOCASE`,
    season.id,
  );
  const admin = c.get("user")?.role === "admin";
  const awards = await mvpAwards(c, season.id);
  const seasonMvp = awards.season.get(season.id) ?? [];
  const players = rows.map((r) => {
    const appearances = r.appearances ?? 0;
    return {
      playerId: r.playerId,
      displayName: r.displayName,
      kind: r.kind,
      avatarUrl: r.avatar_updated_at ? `/api/players/${r.playerId}/avatar?v=${encodeURIComponent(r.avatar_updated_at)}` : null,
      appearances,
      dailyWins: r.dailyWins ?? 0,
      winRate: appearances > 0 ? Math.round(((r.dailyWins ?? 0) / appearances) * 100) : 0,
      points: r.points ?? 0,
      goals: r.goals ?? 0,
      assists: r.assists ?? 0,
      ownGoals: r.ownGoals ?? 0,
      yellow: r.yellow ?? 0,
      red: r.red ?? 0,
      mvpAwards: awards.weekly.get(r.playerId) ?? 0,
      seasonMvp: seasonMvp.includes(r.playerId),
      ...(admin ? { owed: r.owed ?? 0, paid: r.paid ?? 0 } : {}),
    };
  });
  const totals = {
    matchDays: season.finalized_days ?? 0,
    goals: players.reduce((s, p) => s + p.goals, 0),
    yellow: players.reduce((s, p) => s + p.yellow, 0),
    red: players.reduce((s, p) => s + p.red, 0),
    ...(admin ? { owed: rows.reduce((s, r) => s + (r.owed ?? 0), 0), paid: rows.reduce((s, r) => s + (r.paid ?? 0), 0) } : {}),
  };
  return c.json({ season: toSeason(season), players, totals });
});

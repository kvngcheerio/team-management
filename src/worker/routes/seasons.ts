import { Hono } from "hono";
import { z } from "zod";
import { defaultSeasonEnd, isDateInSeason, seasonsOverlap, validateSeasonDates } from "../../shared/rules";
import { isValidTimeZone } from "../../shared/time";
import type { AppEnv } from "../env";
import { all, atomic, auditStmt, first, getSetting, guard, HttpError, newId, nowIso, stmt } from "../lib/db";
import { requireAdmin, requireUser } from "../lib/guards";
import { seasonTables } from "../lib/standings";
import { body, zDate, zName, zReason } from "../lib/validate";

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
}

const toSeason = (s: SeasonRow & { match_days?: number; finalized_days?: number; started_days?: number }) => ({
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

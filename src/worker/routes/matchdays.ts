import { Hono } from "hono";
import { z } from "zod";
import {
  balancedTeams,
  canTransition,
  computeSetTable,
  determineDailyWinner,
  finalizationIssues,
  isDateInSeason,
  randomTeams,
  reconcileMatch,
  rosterEditable,
  seededRandom,
  selfCheckInOpen,
  SET_COLORS,
  SET_NAMES,
  TeamSelectionError,
  validateAssignment,
  type PoolPlayer,
} from "../../shared/rules";
import { utcToZoned, zonedToUtcIso } from "../../shared/time";
import type { AppEnv, Ctx } from "../env";
import { randomToken } from "../lib/crypto";
import { all, atomic, auditStmt, first, HttpError, newId, nowIso, stmt } from "../lib/db";
import { isAdmin, requireAdmin, requireUser } from "../lib/guards";
import {
  commitDay,
  correctionContext,
  loadDay,
  loadDayFull,
  seasonOf,
  toDayState,
  type LoadedDay,
  type MatchDayRow,
} from "../lib/matchday";
import { body, zDate, zId, zReason, zTime } from "../lib/validate";

export const matchDayRoutes = new Hono<AppEnv>();

/** SQL fragment: 'confirmed' if a place is free, otherwise 'waitlist'. Evaluated atomically inside one statement. */
const CAPACITY_STATUS = `CASE WHEN (SELECT COUNT(*) FROM registrations WHERE match_day_id = ?1 AND status = 'confirmed')
  < (SELECT capacity FROM match_days WHERE id = ?1) THEN 'confirmed' ELSE 'waitlist' END`;

async function myPlayer(c: Ctx) {
  const user = c.get("user");
  if (!user) return null;
  return first<{ id: string; kind: "member" | "guest"; active: number; display_name: string }>(
    c.env.DB,
    "SELECT id, kind, active, display_name FROM players WHERE user_id = ?",
    user.id,
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function dayShape(day: MatchDayRow, season: { name: string; timezone: string; status: string } | null, admin: boolean, origin: string) {
  const tz = season?.timezone ?? "Africa/Lagos";
  return {
    id: day.id,
    seasonId: day.season_id,
    seasonName: season?.name ?? "",
    seasonStatus: season?.status ?? "active",
    timezone: tz,
    date: day.date,
    kickoffTime: day.kickoff_time,
    venue: day.venue,
    capacity: day.capacity,
    checkinDeadline: day.checkin_deadline,
    checkinDeadlineLocal: utcToZoned(day.checkin_deadline, tz),
    teamSize: day.team_size,
    setCount: day.set_count,
    status: day.status,
    tiePolicy: day.tie_policy,
    notes: day.notes,
    teamsPublishedAt: day.teams_published_at,
    startedAt: day.started_at,
    finalizedAt: day.finalized_at,
    cancelledAt: day.cancelled_at,
    version: day.version,
    guestLink: admin ? `${origin}/g/${day.public_token}` : undefined,
  };
}

export async function buildDetail(c: Ctx, loaded: LoadedDay) {
  const admin = isAdmin(c);
  const { day, sets, roster, matches, goals, registrations } = loaded;
  const season = await seasonOf(c.env.DB, day.season_id);
  const me = await myPlayer(c);
  const state = toDayState(loaded);
  const table = computeSetTable(state.setIds, state.matches);
  const winner = determineDailyWinner(state.setIds, state.matches, state.tiePolicy);
  const stats =
    day.status === "finalized"
      ? await all<{ player_id: string; points: number; eligible: number; daily_win: number; goals: number; assists: number }>(
          c.env.DB,
          "SELECT player_id, points, eligible, daily_win, goals, assists FROM day_player_stats WHERE match_day_id = ?",
          day.id,
        )
      : [];
  const statsBy = new Map(stats.map((s) => [s.player_id, s]));
  const regByPlayer = new Map(registrations.map((r) => [r.player_id, r]));
  const origin = c.env.BETTER_AUTH_URL || new URL(c.req.url).origin;
  const visibleRegs = registrations.filter((r) => admin || ["confirmed", "waitlist"].includes(r.status) || r.player_id === me?.id);
  const mine = me ? registrations.find((r) => r.player_id === me.id) : undefined;
  let waitPos = 0;
  return {
    day: dayShape(day, season, admin, origin),
    registrations: visibleRegs.map((r) => ({
      id: r.id,
      playerId: r.player_id,
      displayName: r.display_name,
      kind: r.kind,
      status: r.status,
      source: r.source,
      attended: r.attended == null ? null : r.attended === 1,
      queuedAt: r.queued_at,
      waitlistPosition: r.status === "waitlist" ? ++waitPos : null,
      ...(admin ? { note: r.guest_note, contactEmail: r.contact_email, contactPhone: r.contact_phone } : {}),
    })),
    counts: {
      confirmed: registrations.filter((r) => r.status === "confirmed").length,
      waitlist: registrations.filter((r) => r.status === "waitlist").length,
      pending: registrations.filter((r) => r.status === "pending").length,
    },
    sets: sets.map((s) => ({
      id: s.id,
      idx: s.idx,
      name: s.name,
      color: s.color,
      isDailyWinner: day.status === "finalized" ? s.is_daily_winner === 1 : winner.status === "decided" && winner.winnerSetIds.includes(s.id),
      record: table.find((t) => t.setId === s.id),
      players: roster
        .filter((r) => r.set_id === s.id)
        .map((r) => {
          const st = statsBy.get(r.player_id);
          const reg = regByPlayer.get(r.player_id);
          return {
            playerId: r.player_id,
            displayName: r.display_name,
            kind: r.kind,
            role: r.role,
            isGoalkeeper: r.is_goalkeeper === 1,
            memberAtLock: r.member_at_lock == null ? null : r.member_at_lock === 1,
            attended: reg?.attended == null ? null : reg.attended === 1,
            points: st?.points ?? null,
          };
        }),
    })),
    matches: matches.map((m) => {
      const mr = state.matches.find((x) => x.id === m.id)!;
      return {
        id: m.id,
        seq: m.seq,
        homeSetId: m.home_set_id,
        awaySetId: m.away_set_id,
        homeScore: m.home_score,
        awayScore: m.away_score,
        status: m.status,
        isPlayoff: m.is_playoff === 1,
        reconciled: reconcileMatch(mr, state.goals).ok,
        goals: goals
          .filter((g) => g.match_id === m.id)
          .map((g) => ({ id: g.id, setId: g.set_id, kind: g.kind, scorerPlayerId: g.scorer_player_id, assistPlayerId: g.assist_player_id })),
      };
    }),
    winner,
    issues: admin && (day.status === "in_progress" || day.status === "finalized") ? finalizationIssues(state) : [],
    me: me
      ? {
          playerId: me.id,
          kind: me.kind,
          registrationStatus: mine?.status ?? null,
          canCheckIn: selfCheckInOpen(day.status, day.checkin_deadline, new Date()) && me.active === 1,
          points: statsBy.get(me.id)?.points ?? null,
        }
      : null,
  };
}

matchDayRoutes.get("/matchdays", requireUser, async (c) => {
  const seasonId = c.req.query("seasonId");
  const me = await myPlayer(c);
  const rows = await all<MatchDayRow & { confirmed: number; waitlist: number; pending: number; my_status: string | null; season_name: string; timezone: string }>(
    c.env.DB,
    `SELECT md.*, s.name AS season_name, s.timezone,
       (SELECT COUNT(*) FROM registrations r WHERE r.match_day_id = md.id AND r.status = 'confirmed') AS confirmed,
       (SELECT COUNT(*) FROM registrations r WHERE r.match_day_id = md.id AND r.status = 'waitlist') AS waitlist,
       (SELECT COUNT(*) FROM registrations r WHERE r.match_day_id = md.id AND r.status = 'pending') AS pending,
       (SELECT r.status FROM registrations r WHERE r.match_day_id = md.id AND r.player_id = ?1) AS my_status
     FROM match_days md JOIN seasons s ON s.id = md.season_id
     WHERE (?2 IS NULL OR md.season_id = ?2)
     ORDER BY md.date DESC, md.kickoff_time DESC LIMIT 200`,
    me?.id ?? "",
    seasonId ?? null,
  );
  const admin = isAdmin(c);
  return c.json({
    matchDays: rows
      .filter((r) => admin || r.status !== "draft")
      .map((r) => ({
        id: r.id,
        seasonId: r.season_id,
        seasonName: r.season_name,
        timezone: r.timezone,
        date: r.date,
        kickoffTime: r.kickoff_time,
        venue: r.venue,
        capacity: r.capacity,
        status: r.status,
        checkinDeadline: r.checkin_deadline,
        confirmed: r.confirmed,
        waitlist: r.waitlist,
        pending: admin ? r.pending : undefined,
        myStatus: r.my_status,
        teamsPublished: Boolean(r.teams_published_at),
      })),
  });
});

matchDayRoutes.get("/matchdays/:id", requireUser, async (c) => {
  const loaded = await loadDayFull(c.env.DB, c.req.param("id"));
  if (loaded.day.status === "draft" && !isAdmin(c)) throw new HttpError(404, "Match day not found.");
  return c.json(await buildDetail(c, loaded));
});

async function respondDetail(c: Ctx, id: string, status: 200 | 201 = 200) {
  return c.json(await buildDetail(c, await loadDayFull(c.env.DB, id)), status);
}

// ---------------------------------------------------------------------------
// Create / edit / lifecycle (admin)
// ---------------------------------------------------------------------------

const zDayFields = z.object({
  date: zDate,
  kickoffTime: zTime,
  venue: z.string().trim().max(120).default(""),
  capacity: z.number().int().min(2).max(200),
  checkinDeadlineDate: zDate,
  checkinDeadlineTime: zTime,
  teamSize: z.number().int().min(1).max(30),
  setCount: z.number().int().min(2).max(12),
  tiePolicy: z.enum(["shared", "playoff"]).default("shared"),
  notes: z.string().trim().max(500).default(""),
});

matchDayRoutes.post("/matchdays", requireAdmin, async (c) => {
  const input = await body(c, zDayFields.extend({ seasonId: zId }));
  const db = c.env.DB;
  const season = await seasonOf(db, input.seasonId);
  if (!season) throw new HttpError(404, "Season not found.");
  if (season.status !== "active") throw new HttpError(409, "This season is closed.");
  if (!isDateInSeason(input.date, { startDate: season.start_date, endDate: season.end_date })) {
    throw new HttpError(422, `The date must fall within the season (${season.start_date} to ${season.end_date}).`);
  }
  const deadline = zonedToUtcIso(input.checkinDeadlineDate, input.checkinDeadlineTime, season.timezone);
  const kickoff = zonedToUtcIso(input.date, input.kickoffTime, season.timezone);
  if (deadline > kickoff) throw new HttpError(422, "The check-in deadline must be before kickoff.");
  const id = newId();
  const now = nowIso();
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO match_days (id, season_id, date, kickoff_time, venue, capacity, checkin_deadline, team_size, set_count, status, tie_policy, public_token, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      id,
      season.id,
      input.date,
      input.kickoffTime,
      input.venue,
      input.capacity,
      deadline,
      input.teamSize,
      input.setCount,
      input.tiePolicy,
      randomToken(12),
      input.notes,
      now,
      now,
    ),
    auditStmt(c, { action: "matchday.create", entityType: "match_day", entityId: id, matchDayId: id, after: input }),
  ]);
  return respondDetail(c, id, 201);
});

matchDayRoutes.patch("/matchdays/:id", requireAdmin, async (c) => {
  const input = await body(c, zDayFields.partial());
  const db = c.env.DB;
  const day = await loadDay(db, c.req.param("id"));
  const season = (await seasonOf(db, day.season_id))!;
  const onlyPolicyOrNotes = Object.keys(input).every((k) => k === "tiePolicy" || k === "notes");
  if (day.status === "finalized" || day.status === "cancelled") throw new HttpError(409, "This match day can no longer be edited.");
  if (day.status === "in_progress" && !onlyPolicyOrNotes) {
    throw new HttpError(409, "Play has started: only the tie policy and notes can change.");
  }
  const local = utcToZoned(day.checkin_deadline, season.timezone);
  const next = {
    date: input.date ?? day.date,
    kickoff_time: input.kickoffTime ?? day.kickoff_time,
    venue: input.venue ?? day.venue,
    capacity: input.capacity ?? day.capacity,
    checkin_deadline: zonedToUtcIso(input.checkinDeadlineDate ?? local.date, input.checkinDeadlineTime ?? local.time, season.timezone),
    team_size: input.teamSize ?? day.team_size,
    set_count: input.setCount ?? day.set_count,
    tie_policy: input.tiePolicy ?? day.tie_policy,
    notes: input.notes ?? day.notes,
  };
  if (!isDateInSeason(next.date, { startDate: season.start_date, endDate: season.end_date })) {
    throw new HttpError(422, "The date must fall within the season.");
  }
  if (next.checkin_deadline > zonedToUtcIso(next.date, next.kickoff_time, season.timezone)) {
    throw new HttpError(422, "The check-in deadline must be before kickoff.");
  }
  if (next.set_count !== day.set_count && day.teams_published_at) {
    throw new HttpError(409, "Teams are already published. Republish teams to change the number of sets.");
  }
  const confirmed = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM registrations WHERE match_day_id = ? AND status = 'confirmed'", day.id);
  if (next.capacity < (confirmed?.n ?? 0)) {
    throw new HttpError(409, `${confirmed!.n} players are already confirmed. Withdraw some before lowering capacity.`);
  }
  await commitDay(
    c,
    day,
    [
      stmt(
        db,
        `UPDATE match_days SET date = ?, kickoff_time = ?, venue = ?, capacity = ?, checkin_deadline = ?, team_size = ?, set_count = ?, tie_policy = ?, notes = ? WHERE id = ?`,
        next.date,
        next.kickoff_time,
        next.venue,
        next.capacity,
        next.checkin_deadline,
        next.team_size,
        next.set_count,
        next.tie_policy,
        next.notes,
        day.id,
      ),
    ],
    { audit: { action: "matchday.update", entityType: "match_day", entityId: day.id, before: pick(day, Object.keys(next)), after: next } },
  );
  return respondDetail(c, day.id);
});

function pick(obj: object, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, (obj as Record<string, unknown>)[k]]));
}

matchDayRoutes.post("/matchdays/:id/transition", requireAdmin, async (c) => {
  const input = await body(c, z.object({ to: z.enum(["draft", "checkin_open", "locked", "cancelled"]), reason: zReason }));
  const db = c.env.DB;
  const day = await loadDay(db, c.req.param("id"));
  if (day.status === input.to) return respondDetail(c, day.id);
  const statements: D1PreparedStatement[] = [];
  if (input.to === "cancelled" && day.status === "finalized") {
    // Cancelling a finalized day is a correction: its records are removed so it awards nothing.
    await correctionContext(c, day, input.reason);
    statements.push(stmt(db, "DELETE FROM day_player_stats WHERE match_day_id = ?", day.id));
    statements.push(stmt(db, "UPDATE sets SET is_daily_winner = 0 WHERE match_day_id = ?", day.id));
  } else if (!canTransition(day.status, input.to)) {
    throw new HttpError(409, `Cannot move a match day from ${day.status} to ${input.to}.`);
  }
  if (input.to === "cancelled" && day.status === "in_progress" && (!input.reason || input.reason.length < 3)) {
    throw new HttpError(422, "Give a reason for cancelling a match day that has started.");
  }
  const now = nowIso();
  statements.push(
    stmt(db, "UPDATE match_days SET status = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END WHERE id = ?", input.to, input.to, now, day.id),
  );
  await commitDay(c, day, statements, {
    audit: { action: `matchday.${input.to}`, entityType: "match_day", entityId: day.id, reason: input.reason, before: { status: day.status }, after: { status: input.to } },
  });
  return respondDetail(c, day.id);
});

/** Start play: locks rosters and snapshots membership (guests at this point are not eligible for points). */
matchDayRoutes.post("/matchdays/:id/start", requireAdmin, async (c) => {
  const db = c.env.DB;
  const day = await loadDay(db, c.req.param("id"));
  if (day.status === "in_progress") return respondDetail(c, day.id);
  if (day.status !== "locked" && day.status !== "checkin_open") throw new HttpError(409, `Cannot start play from ${day.status}.`);
  if (!day.teams_published_at) throw new HttpError(409, "Publish teams before starting play.");
  const now = nowIso();
  await commitDay(
    c,
    day,
    [
      stmt(db, "UPDATE match_days SET status = 'in_progress', started_at = ? WHERE id = ?", now, day.id),
      stmt(
        db,
        `UPDATE roster_entries SET member_at_lock = (SELECT CASE WHEN p.kind = 'member' THEN 1 ELSE 0 END FROM players p WHERE p.id = roster_entries.player_id)
         WHERE match_day_id = ?`,
        day.id,
      ),
    ],
    { audit: { action: "matchday.start", entityType: "match_day", entityId: day.id, before: { status: day.status }, after: { status: "in_progress" } } },
  );
  return respondDetail(c, day.id);
});

/**
 * Finalize: compute the daily winner and individual records. Idempotent — a repeat (or concurrent
 * duplicate) request never awards points twice: the version guard lets only one commit through and
 * records are replaced, not appended.
 */
matchDayRoutes.post("/matchdays/:id/finalize", requireAdmin, async (c) => {
  const db = c.env.DB;
  const loaded = await loadDayFull(db, c.req.param("id"));
  const { day } = loaded;
  if (day.status === "finalized") return c.json({ ...(await buildDetail(c, loaded)), alreadyFinalized: true });
  if (day.status !== "in_progress") throw new HttpError(409, "Only a match day in progress can be finalized.");
  const state = toDayState(loaded);
  const issues = finalizationIssues(state);
  if (issues.length > 0) throw new HttpError(422, "This match day cannot be finalized yet.", issues);
  const winner = determineDailyWinner(state.setIds, state.matches, state.tiePolicy);
  try {
    await commitDay(
      c,
      day,
      [stmt(db, "UPDATE match_days SET status = 'finalized', finalized_at = ? WHERE id = ? AND status = 'in_progress'", nowIso(), day.id)],
      {
        recompute: state,
        audit: { action: "matchday.finalize", entityType: "match_day", entityId: day.id, after: { winner } },
      },
    );
  } catch (err) {
    // A concurrent finalize won the race: report the finalized state instead of an error.
    const fresh = await loadDay(db, day.id);
    if (fresh.status === "finalized") return c.json({ ...(await buildDetail(c, await loadDayFull(db, day.id))), alreadyFinalized: true });
    throw err;
  }
  return respondDetail(c, day.id);
});

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

matchDayRoutes.post("/matchdays/:id/checkin", requireUser, async (c) => {
  const db = c.env.DB;
  const dayId = c.req.param("id");
  const me = await myPlayer(c);
  if (!me) throw new HttpError(409, "Your login isn't linked to a player yet. Ask an admin.");
  if (me.active !== 1) throw new HttpError(403, "Your player profile is inactive.");
  const now = nowIso();
  // Guests (even with a login) need admin approval; members get a place or join the waiting list.
  const statusExpr = me.kind === "guest" ? "'pending'" : CAPACITY_STATUS;
  const row = await db
    .prepare(
      `INSERT INTO registrations (id, match_day_id, player_id, status, source, queued_at, created_at, updated_at)
       SELECT ?2, ?1, ?3, ${statusExpr}, 'self', ?4, ?4, ?4
         FROM match_days md WHERE md.id = ?1 AND md.status = 'checkin_open' AND md.checkin_deadline > ?4
       ON CONFLICT (match_day_id, player_id) DO UPDATE SET
         status = CASE WHEN registrations.status = 'withdrawn' THEN excluded.status ELSE registrations.status END,
         queued_at = CASE WHEN registrations.status = 'withdrawn' THEN excluded.queued_at ELSE registrations.queued_at END,
         updated_at = excluded.updated_at
       RETURNING status`,
    )
    .bind(dayId, newId(), me.id, now)
    .first<{ status: string }>();
  if (!row) throw new HttpError(409, "Check-in is closed for this match day.");
  if (row.status === "rejected") throw new HttpError(409, "Your registration for this day was declined by an admin.");
  return respondDetail(c, dayId);
});

matchDayRoutes.post("/matchdays/:id/withdraw", requireUser, async (c) => {
  const db = c.env.DB;
  const dayId = c.req.param("id");
  const me = await myPlayer(c);
  if (!me) throw new HttpError(409, "Your login isn't linked to a player yet.");
  const now = nowIso();
  const res = await db.batch([
    stmt(
      db,
      `UPDATE registrations SET status = 'withdrawn', updated_at = ?3
        WHERE match_day_id = ?1 AND player_id = ?2 AND status IN ('confirmed', 'waitlist', 'pending')
          AND EXISTS (SELECT 1 FROM match_days WHERE id = ?1 AND status = 'checkin_open' AND checkin_deadline > ?3)`,
      dayId,
      me.id,
      now,
    ),
    // If teams were already published, free their roster spot too (play hasn't started while check-in is open).
    stmt(
      db,
      `DELETE FROM roster_entries WHERE match_day_id = ?1 AND player_id = ?2
         AND EXISTS (SELECT 1 FROM registrations WHERE match_day_id = ?1 AND player_id = ?2 AND status = 'withdrawn')
         AND EXISTS (SELECT 1 FROM match_days WHERE id = ?1 AND status = 'checkin_open')`,
      dayId,
      me.id,
    ),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) throw new HttpError(409, "You can't withdraw now: you're not registered or the deadline has passed.");
  return respondDetail(c, dayId);
});

matchDayRoutes.post("/matchdays/:id/registrations", requireAdmin, async (c) => {
  const input = await body(c, z.object({ playerId: zId }));
  const db = c.env.DB;
  const day = await loadDay(db, c.req.param("id"));
  if (!["draft", "checkin_open", "locked"].includes(day.status)) throw new HttpError(409, "Players can't be added once play has started.");
  const player = await first<{ id: string; active: number; display_name: string }>(db, "SELECT id, active, display_name FROM players WHERE id = ?", input.playerId);
  if (!player || player.active !== 1) throw new HttpError(404, "Active player not found.");
  const now = nowIso();
  // Admin-added players (members or guests) are approved; they still respect capacity.
  const row = await db
    .prepare(
      `INSERT INTO registrations (id, match_day_id, player_id, status, source, queued_at, created_at, updated_at)
       VALUES (?2, ?1, ?3, ${CAPACITY_STATUS}, 'admin', ?4, ?4, ?4)
       ON CONFLICT (match_day_id, player_id) DO UPDATE SET
         status = CASE WHEN registrations.status IN ('withdrawn', 'rejected', 'pending') THEN excluded.status ELSE registrations.status END,
         queued_at = CASE WHEN registrations.status IN ('withdrawn', 'rejected') THEN excluded.queued_at ELSE registrations.queued_at END,
         updated_at = excluded.updated_at
       RETURNING status`,
    )
    .bind(day.id, newId(), player.id, now)
    .first<{ status: string }>();
  await db.batch([auditStmt(c, { action: "registration.admin_add", entityType: "player", entityId: player.id, matchDayId: day.id, after: { status: row?.status } })]);
  return respondDetail(c, day.id);
});

const REG_ACTIONS = {
  approve: { from: ["pending"], sql: CAPACITY_STATUS },
  promote: { from: ["waitlist"], sql: "'confirmed'" },
  reject: { from: ["pending"], sql: "'rejected'" },
  withdraw: { from: ["pending", "confirmed", "waitlist"], sql: "'withdrawn'" },
  restore: { from: ["withdrawn", "rejected"], sql: CAPACITY_STATUS },
} as const;

matchDayRoutes.post("/registrations/:regId/:action{approve|promote|reject|withdraw|restore}", requireAdmin, async (c) => {
  const action = c.req.param("action") as keyof typeof REG_ACTIONS;
  const input = await body(c, z.object({ reason: zReason }).default({}));
  const db = c.env.DB;
  const reg = await first<{ id: string; match_day_id: string; player_id: string; status: string }>(
    db,
    "SELECT id, match_day_id, player_id, status FROM registrations WHERE id = ?",
    c.req.param("regId"),
  );
  if (!reg) throw new HttpError(404, "Registration not found.");
  const day = await loadDay(db, reg.match_day_id);
  if (!["draft", "checkin_open", "locked"].includes(day.status)) {
    throw new HttpError(409, "Registrations are frozen once play has started. Use attendance instead.");
  }
  const spec = REG_ACTIONS[action];
  if (!(spec.from as readonly string[]).includes(reg.status)) throw new HttpError(409, `Cannot ${action} a registration that is ${reg.status}.`);
  const now = nowIso();
  const capacityCheck =
    action === "promote"
      ? `AND (SELECT COUNT(*) FROM registrations WHERE match_day_id = ?1 AND status = 'confirmed') < (SELECT capacity FROM match_days WHERE id = ?1)`
      : "";
  const res = await db.batch([
    stmt(
      db,
      `UPDATE registrations SET status = ${spec.sql}, updated_at = ?3 ${action === "restore" ? ", queued_at = ?3" : ""}
        WHERE id = ?2 AND status = ?4 ${capacityCheck}`,
      day.id,
      reg.id,
      now,
      reg.status,
    ),
    // Withdrawn/rejected players leave any (not yet locked) roster.
    stmt(
      db,
      `DELETE FROM roster_entries WHERE match_day_id = ?1 AND player_id = ?2
         AND EXISTS (SELECT 1 FROM registrations WHERE id = ?3 AND status IN ('withdrawn', 'rejected'))`,
      day.id,
      reg.player_id,
      reg.id,
    ),
    auditStmt(c, { action: `registration.${action}`, entityType: "registration", entityId: reg.id, matchDayId: day.id, reason: input.reason, before: { status: reg.status } }),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) {
    throw new HttpError(409, action === "promote" ? "No free place: the match day is full." : "The registration changed. Refresh and try again.");
  }
  return respondDetail(c, day.id);
});

// ---------------------------------------------------------------------------
// Attendance (actual presence; separate from registration)
// ---------------------------------------------------------------------------

matchDayRoutes.post("/matchdays/:id/attendance", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({ entries: z.array(z.object({ playerId: zId, attended: z.boolean().nullable() })).min(1).max(200), reason: zReason }),
  );
  const db = c.env.DB;
  const loaded = await loadDayFull(db, c.req.param("id"));
  const { day } = loaded;
  if (day.status === "draft" || day.status === "cancelled") throw new HttpError(409, "Attendance can't be marked for this match day.");
  const recompute = await correctionContext(c, day, input.reason);
  const regs = new Map(loaded.registrations.map((r) => [r.player_id, r]));
  const state = toDayState(loaded);
  const statements: D1PreparedStatement[] = [];
  const before: Record<string, number | null> = {};
  for (const e of input.entries) {
    const reg = regs.get(e.playerId);
    if (!reg || reg.status !== "confirmed") throw new HttpError(422, "Attendance can only be marked for confirmed players.");
    if (recompute && e.attended === null) throw new HttpError(422, "Finalized days need attendance marked present or absent.");
    before[e.playerId] = reg.attended;
    state.attendance[e.playerId] = e.attended;
    statements.push(
      stmt(db, "UPDATE registrations SET attended = ?, updated_at = ? WHERE id = ?", e.attended === null ? null : e.attended ? 1 : 0, nowIso(), reg.id),
    );
  }
  await commitDay(c, day, statements, {
    recompute: recompute ? state : undefined,
    audit: {
      action: recompute ? "correction.attendance" : "attendance.mark",
      entityType: "match_day",
      entityId: day.id,
      reason: input.reason,
      before,
      after: Object.fromEntries(input.entries.map((e) => [e.playerId, e.attended])),
    },
  });
  return respondDetail(c, day.id);
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

async function confirmedPool(db: D1Database, dayId: string): Promise<PoolPlayer[]> {
  const rows = await all<{ id: string; display_name: string; skill_rating: number; gk_preference: PoolPlayer["gk"] }>(
    db,
    `SELECT p.id, p.display_name, p.skill_rating, p.gk_preference FROM registrations r JOIN players p ON p.id = r.player_id
      WHERE r.match_day_id = ? AND r.status = 'confirmed' AND p.active = 1 ORDER BY r.queued_at`,
    dayId,
  );
  return rows.map((r) => ({ playerId: r.id, displayName: r.display_name, rating: r.skill_rating, gk: r.gk_preference }));
}

matchDayRoutes.post("/matchdays/:id/teams/generate", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({
      mode: z.enum(["balanced", "random"]),
      setCount: z.number().int().min(2).max(12).optional(),
      teamSize: z.number().int().min(1).max(30).optional(),
      seed: z.number().int().optional(),
    }),
  );
  const db = c.env.DB;
  const day = await loadDay(db, c.req.param("id"));
  if (!rosterEditable(day.status)) throw new HttpError(409, "Teams can only be generated before play starts.");
  const pool = await confirmedPool(db, day.id);
  const setCount = input.setCount ?? day.set_count;
  const teamSize = input.teamSize ?? day.team_size;
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  try {
    const fn = input.mode === "balanced" ? balancedTeams : randomTeams;
    const result = fn(pool, setCount, teamSize, seededRandom(seed));
    const names = new Map(pool.map((p) => [p.playerId, p]));
    return c.json({
      seed,
      setCount,
      teamSize,
      mode: input.mode,
      warnings: result.warnings,
      explanation: result.explanation,
      sets: result.sets.map((s) => ({
        idx: s.idx,
        name: SET_NAMES[s.idx - 1],
        color: SET_COLORS[s.idx - 1],
        totalRating: s.totalRating,
        players: s.players.map((p) => ({ ...p, displayName: names.get(p.playerId)!.displayName, rating: names.get(p.playerId)!.rating })),
      })),
    });
  } catch (err) {
    if (err instanceof TeamSelectionError) throw new HttpError(422, err.message);
    throw err;
  }
});

matchDayRoutes.post("/matchdays/:id/teams/publish", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({
      expectedVersion: z.number().int().optional(),
      replace: z.boolean().default(false),
      teamSize: z.number().int().min(1).max(30).optional(),
      sets: z
        .array(
          z.object({
            idx: z.number().int().min(1).max(12),
            name: z.string().trim().min(1).max(30).optional(),
            players: z.array(z.object({ playerId: zId, role: z.enum(["starter", "sub"]).default("starter"), isGoalkeeper: z.boolean().default(false) })),
          }),
        )
        .min(2)
        .max(12),
      reason: zReason,
    }),
  );
  const db = c.env.DB;
  const day = await loadDay(db, c.req.param("id"));
  if (!rosterEditable(day.status)) {
    throw new HttpError(409, day.status === "in_progress" || day.status === "finalized" ? "Rosters are locked: play has started." : "Open check-in before publishing teams.");
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== day.version) {
    throw new HttpError(409, "The match day changed since you loaded it. Refresh and try again.");
  }
  if (day.teams_published_at && !input.replace) throw new HttpError(409, "Teams are already published. Confirm to replace them.");
  const pool = await confirmedPool(db, day.id);
  const err = validateAssignment(input.sets, input.sets.length, new Set(pool.map((p) => p.playerId)));
  if (err) throw new HttpError(422, err);
  const now = nowIso();
  const statements: D1PreparedStatement[] = [
    stmt(db, "DELETE FROM roster_entries WHERE match_day_id = ?", day.id),
    stmt(db, "DELETE FROM sets WHERE match_day_id = ?", day.id),
    stmt(db, "UPDATE match_days SET set_count = ?, team_size = ?, teams_published_at = ? WHERE id = ?", input.sets.length, input.teamSize ?? day.team_size, now, day.id),
  ];
  for (const s of [...input.sets].sort((a, b) => a.idx - b.idx)) {
    const setId = newId();
    statements.push(
      stmt(db, "INSERT INTO sets (id, match_day_id, idx, name, color) VALUES (?, ?, ?, ?, ?)", setId, day.id, s.idx, s.name ?? SET_NAMES[s.idx - 1]!, SET_COLORS[s.idx - 1]!),
    );
    for (const p of s.players) {
      statements.push(
        stmt(db, "INSERT INTO roster_entries (match_day_id, set_id, player_id, role, is_goalkeeper) VALUES (?, ?, ?, ?, ?)", day.id, setId, p.playerId, p.role, p.isGoalkeeper ? 1 : 0),
      );
    }
  }
  await commitDay(c, day, statements, {
    audit: {
      action: day.teams_published_at ? "teams.republish" : "teams.publish",
      entityType: "match_day",
      entityId: day.id,
      reason: input.reason,
      after: input.sets.map((s) => ({ idx: s.idx, players: s.players.map((p) => p.playerId) })),
    },
  });
  return respondDetail(c, day.id);
});

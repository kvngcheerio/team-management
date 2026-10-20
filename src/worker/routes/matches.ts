import { Hono } from "hono";
import { z } from "zod";
import { validateGoalEvent } from "../../shared/rules";
import type { AppEnv, Ctx } from "../env";
import { first, guard, HttpError, nowIso, stmt } from "../lib/db";
import { requireAdmin } from "../lib/guards";
import { commitDay, correctionContext, loadDayFull, toDayState, type MatchRow } from "../lib/matchday";
import { body, zId, zReason } from "../lib/validate";
import { buildDetail } from "./matchdays";

export const matchRoutes = new Hono<AppEnv>();

/** Matches can be recorded while play is in progress, or corrected (with a reason) after finalization. */
async function editableDay(c: Ctx, dayId: string, reason: string | null | undefined) {
  const loaded = await loadDayFull(c.env.DB, dayId);
  if (loaded.day.status !== "in_progress" && loaded.day.status !== "finalized") {
    throw new HttpError(409, loaded.day.status === "cancelled" ? "This match day was cancelled." : "Start play before recording matches.");
  }
  const isCorrection = await correctionContext(c, loaded.day, reason);
  return { loaded, isCorrection };
}

async function dayForMatch(db: D1Database, matchId: string) {
  const m = await first<MatchRow>(db, "SELECT * FROM matches WHERE id = ?", matchId);
  if (!m) throw new HttpError(404, "Match not found.");
  return m;
}

async function detail(c: Ctx, dayId: string, status: 200 | 201 = 200) {
  return c.json(await buildDetail(c, await loadDayFull(c.env.DB, dayId)), status);
}

const action = (isCorrection: boolean, name: string) => (isCorrection ? `correction.${name}` : name);

// Create a match. The client may supply the id so a retried/double-submitted request is idempotent.
matchRoutes.post("/matchdays/:id/matches", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({
      id: z.string().uuid().optional(),
      homeSetId: zId,
      awaySetId: zId,
      isPlayoff: z.boolean().default(false),
      // Record a finished match in one go: goals are stored as unattributed so the score reconciles;
      // scorers can be named afterwards.
      final: z.object({ homeScore: z.number().int().min(0).max(30), awayScore: z.number().int().min(0).max(30) }).optional(),
      reason: zReason,
    }),
  );
  const db = c.env.DB;
  if (input.id && (await first(db, "SELECT 1 FROM matches WHERE id = ?", input.id))) return detail(c, c.req.param("id"));
  const { loaded, isCorrection } = await editableDay(c, c.req.param("id"), input.reason);
  const setIds = new Set(loaded.sets.map((s) => s.id));
  if (!setIds.has(input.homeSetId) || !setIds.has(input.awaySetId)) throw new HttpError(422, "Both sets must belong to this match day.");
  if (input.homeSetId === input.awaySetId) throw new HttpError(422, "A set cannot play itself.");
  if (input.isPlayoff && loaded.day.tie_policy !== "playoff") throw new HttpError(422, "Switch the tie policy to playoff before recording a playoff match.");
  if (!input.final && loaded.matches.some((m) => m.status === "in_progress")) throw new HttpError(409, "Finish the current match before starting another.");
  const id = input.id ?? crypto.randomUUID();
  const now = nowIso();
  const state = toDayState(loaded);
  state.matches.push({ id, homeSetId: input.homeSetId, awaySetId: input.awaySetId, homeScore: 0, awayScore: 0, status: "in_progress", isPlayoff: input.isPlayoff });
  // Corrections and final-score entries are stored as completed.
  const status = isCorrection || input.final ? "completed" : "in_progress";
  const newMatch = state.matches[state.matches.length - 1]!;
  newMatch.status = status;
  const goalStatements: D1PreparedStatement[] = [];
  if (input.final) {
    newMatch.homeScore = input.final.homeScore;
    newMatch.awayScore = input.final.awayScore;
    const add = (setId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const gid = crypto.randomUUID();
        state.goals.push({ id: gid, matchId: id, setId, kind: "unattributed", scorerPlayerId: null, assistPlayerId: null });
        goalStatements.push(stmt(db, "INSERT INTO goal_events (id, match_id, set_id, kind, created_at) VALUES (?, ?, ?, 'unattributed', ?)", gid, id, setId, now));
      }
    };
    add(input.homeSetId, input.final.homeScore);
    add(input.awaySetId, input.final.awayScore);
  }
  await commitDay(
    c,
    loaded.day,
    [
      stmt(
        db,
        `INSERT INTO matches (id, match_day_id, seq, home_set_id, away_set_id, home_score, away_score, status, is_playoff, created_at, updated_at)
         SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ? FROM matches WHERE match_day_id = ?`,
        id,
        loaded.day.id,
        input.homeSetId,
        input.awaySetId,
        newMatch.homeScore,
        newMatch.awayScore,
        status,
        input.isPlayoff ? 1 : 0,
        now,
        now,
        loaded.day.id,
      ),
      ...goalStatements,
    ],
    {
      recompute: isCorrection ? state : undefined,
      audit: { action: action(isCorrection, "match.create"), entityType: "match", entityId: id, reason: input.reason, after: input },
    },
  );
  return detail(c, loaded.day.id, 201);
});

matchRoutes.patch("/matches/:id", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({
      homeScore: z.number().int().min(0).max(99).optional(),
      awayScore: z.number().int().min(0).max(99).optional(),
      status: z.enum(["in_progress", "completed", "void"]).optional(),
      reason: zReason,
    }),
  );
  const db = c.env.DB;
  const match = await dayForMatch(db, c.req.param("id"));
  const { loaded, isCorrection } = await editableDay(c, match.match_day_id, input.reason);
  const next = {
    home_score: input.homeScore ?? match.home_score,
    away_score: input.awayScore ?? match.away_score,
    status: input.status ?? match.status,
  };
  if (isCorrection && next.status === "in_progress") throw new HttpError(422, "A finalized day's matches must be completed or void.");
  if (next.status === "in_progress" && match.status !== "in_progress" && loaded.matches.some((m) => m.id !== match.id && m.status === "in_progress")) {
    throw new HttpError(409, "Another match is already in progress.");
  }
  const state = toDayState(loaded);
  const m = state.matches.find((x) => x.id === match.id)!;
  Object.assign(m, { homeScore: next.home_score, awayScore: next.away_score, status: next.status });
  await commitDay(
    c,
    loaded.day,
    [stmt(db, "UPDATE matches SET home_score = ?, away_score = ?, status = ?, updated_at = ? WHERE id = ?", next.home_score, next.away_score, next.status, nowIso(), match.id)],
    {
      recompute: isCorrection ? state : undefined,
      audit: {
        action: action(isCorrection, "match.update"),
        entityType: "match",
        entityId: match.id,
        reason: input.reason,
        before: { homeScore: match.home_score, awayScore: match.away_score, status: match.status },
        after: { homeScore: next.home_score, awayScore: next.away_score, status: next.status },
      },
    },
  );
  return detail(c, loaded.day.id);
});

function scoreColumn(match: MatchRow, setId: string) {
  if (setId === match.home_set_id) return "home_score";
  if (setId === match.away_set_id) return "away_score";
  throw new HttpError(422, "The credited set is not playing in this match.");
}

// Record a goal. `adjustScore` (default) increments the credited side's score so they stay reconciled.
matchRoutes.post("/matches/:id/goals", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({
      id: z.string().uuid().optional(),
      setId: zId,
      kind: z.enum(["normal", "own_goal", "unattributed"]),
      scorerPlayerId: zId.nullable().optional(),
      assistPlayerId: zId.nullable().optional(),
      adjustScore: z.boolean().default(true),
      reason: zReason,
    }),
  );
  const db = c.env.DB;
  const match = await dayForMatch(db, c.req.param("id"));
  if (input.id && (await first(db, "SELECT 1 FROM goal_events WHERE id = ?", input.id))) return detail(c, match.match_day_id);
  const { loaded, isCorrection } = await editableDay(c, match.match_day_id, input.reason);
  if (match.status === "void") throw new HttpError(409, "This match was voided.");
  const goal = { setId: input.setId, kind: input.kind, scorerPlayerId: input.scorerPlayerId ?? null, assistPlayerId: input.assistPlayerId ?? null };
  const state = toDayState(loaded);
  const error = validateGoalEvent(goal, { homeSetId: match.home_set_id, awaySetId: match.away_set_id }, state.roster);
  if (error) throw new HttpError(422, error);
  const col = scoreColumn(match, input.setId);
  const id = input.id ?? crypto.randomUUID();
  state.goals.push({ id, matchId: match.id, ...goal });
  const statements = [
    stmt(
      db,
      "INSERT INTO goal_events (id, match_id, set_id, kind, scorer_player_id, assist_player_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      match.id,
      goal.setId,
      goal.kind,
      goal.scorerPlayerId,
      goal.assistPlayerId,
      nowIso(),
    ),
  ];
  if (input.adjustScore) {
    statements.push(stmt(db, `UPDATE matches SET ${col} = ${col} + 1, updated_at = ? WHERE id = ?`, nowIso(), match.id));
    const m = state.matches.find((x) => x.id === match.id)!;
    if (col === "home_score") m.homeScore++;
    else m.awayScore++;
  }
  await commitDay(c, loaded.day, statements, {
    recompute: isCorrection ? state : undefined,
    audit: { action: action(isCorrection, "goal.create"), entityType: "goal", entityId: id, reason: input.reason, after: { matchId: match.id, ...goal } },
  });
  return detail(c, loaded.day.id, 201);
});

matchRoutes.post("/goals/:id/delete", requireAdmin, async (c) => {
  const input = await body(c, z.object({ adjustScore: z.boolean().default(true), reason: zReason }));
  const db = c.env.DB;
  const goal = await first<{ id: string; match_id: string; set_id: string; kind: string; scorer_player_id: string | null; assist_player_id: string | null }>(
    db,
    "SELECT * FROM goal_events WHERE id = ?",
    c.req.param("id"),
  );
  if (!goal) throw new HttpError(404, "Goal not found.");
  const match = await dayForMatch(db, goal.match_id);
  const { loaded, isCorrection } = await editableDay(c, match.match_day_id, input.reason);
  const state = toDayState(loaded);
  state.goals = state.goals.filter((g) => g.id !== goal.id);
  const col = scoreColumn(match, goal.set_id);
  const statements = [stmt(db, "DELETE FROM goal_events WHERE id = ?", goal.id)];
  if (input.adjustScore) {
    statements.push(stmt(db, `UPDATE matches SET ${col} = MAX(${col} - 1, 0), updated_at = ? WHERE id = ?`, nowIso(), match.id));
    const m = state.matches.find((x) => x.id === match.id)!;
    if (col === "home_score") m.homeScore = Math.max(0, m.homeScore - 1);
    else m.awayScore = Math.max(0, m.awayScore - 1);
  }
  await commitDay(c, loaded.day, statements, {
    recompute: isCorrection ? state : undefined,
    audit: { action: action(isCorrection, "goal.delete"), entityType: "goal", entityId: goal.id, reason: input.reason, before: goal },
  });
  return detail(c, loaded.day.id);
});

/** Name the scorer (and assister) of an unattributed goal, or mark it an own goal. The score doesn't change. */
matchRoutes.post("/goals/:id/attribute", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({ kind: z.enum(["normal", "own_goal"]), scorerPlayerId: zId, assistPlayerId: zId.nullable().optional(), reason: zReason }),
  );
  const db = c.env.DB;
  const goal = await first<{ id: string; match_id: string; set_id: string; kind: string }>(db, "SELECT id, match_id, set_id, kind FROM goal_events WHERE id = ?", c.req.param("id"));
  if (!goal) throw new HttpError(404, "Goal not found.");
  if (goal.kind !== "unattributed") throw new HttpError(409, "This goal already has a scorer. Remove it and add it again to change it.");
  const match = await dayForMatch(db, goal.match_id);
  const { loaded, isCorrection } = await editableDay(c, match.match_day_id, input.reason);
  const state = toDayState(loaded);
  const next = { setId: goal.set_id, kind: input.kind, scorerPlayerId: input.scorerPlayerId, assistPlayerId: input.kind === "normal" ? input.assistPlayerId ?? null : null };
  const error = validateGoalEvent(next, { homeSetId: match.home_set_id, awaySetId: match.away_set_id }, state.roster);
  if (error) throw new HttpError(422, error);
  state.goals = state.goals.map((g) => (g.id === goal.id ? { ...g, ...next } : g));
  await commitDay(
    c,
    loaded.day,
    [stmt(db, "UPDATE goal_events SET kind = ?, scorer_player_id = ?, assist_player_id = ? WHERE id = ? AND kind = 'unattributed'", next.kind, next.scorerPlayerId, next.assistPlayerId, goal.id), guard(db)],
    {
      recompute: isCorrection ? state : undefined,
      audit: { action: action(isCorrection, "goal.attribute"), entityType: "goal", entityId: goal.id, reason: input.reason, after: next },
      conflictMessage: "That goal was already updated. Refresh and try again.",
    },
  );
  return detail(c, loaded.day.id);
});

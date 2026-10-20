import { Hono } from "hono";
import { z } from "zod";
import { pollOpen, tallyVotes, validateVote } from "../../shared/rules";
import type { AppEnv, Ctx } from "../env";
import { all, atomic, auditStmt, first, getSetting, guard, HttpError, newId, nowIso, stmt } from "../lib/db";
import { requireAdmin, requireUser } from "../lib/guards";
import { body, zId } from "../lib/validate";

export const mvpRoutes = new Hono<AppEnv>();

interface PollRow {
  id: string;
  kind: "matchday" | "season";
  match_day_id: string | null;
  season_id: string;
  opens_at: string;
  closes_at: string;
  closed_early_at: string | null;
  created_at: string;
  date?: string | null;
  season_name?: string;
  day_status?: string | null;
}

const POLL_SQL = `SELECT p.*, md.date, md.status AS day_status, s.name AS season_name
  FROM polls p JOIN seasons s ON s.id = p.season_id LEFT JOIN match_days md ON md.id = p.match_day_id`;

/** Statement that opens the weekly MVP vote for a match day (used inside the finalize batch). */
export async function matchdayPollStatement(db: D1Database, dayId: string, seasonId: string, now: Date) {
  const hours = Number(await getSetting(db, "mvp_vote_hours", "48")) || 48;
  return stmt(
    db,
    `INSERT INTO polls (id, kind, match_day_id, season_id, opens_at, closes_at, created_at)
     VALUES (?, 'matchday', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    newId(),
    dayId,
    seasonId,
    now.toISOString(),
    new Date(now.getTime() + hours * 3600_000).toISOString(),
    now.toISOString(),
  );
}

/** Who may vote, and who may receive votes. */
async function eligibility(db: D1Database, poll: PollRow) {
  if (poll.kind === "matchday") {
    const attendees = await all<{ player_id: string; display_name: string; avatar_updated_at: string | null; kind: string; user_id: string | null }>(
      db,
      `SELECT d.player_id, p.display_name, p.avatar_updated_at, p.kind, p.user_id FROM day_player_stats d JOIN players p ON p.id = d.player_id
        WHERE d.match_day_id = ? AND d.attended = 1 ORDER BY p.display_name COLLATE NOCASE`,
      poll.match_day_id,
    );
    return {
      candidates: attendees,
      voters: new Set(attendees.filter((a) => a.user_id).map((a) => a.player_id)),
    };
  }
  const [candidates, voters] = await Promise.all([
    all<{ player_id: string; display_name: string; avatar_updated_at: string | null; kind: string; user_id: string | null }>(
      db,
      `SELECT d.player_id, p.display_name, p.avatar_updated_at, p.kind, p.user_id FROM day_player_stats d
         JOIN match_days md ON md.id = d.match_day_id AND md.status = 'finalized' AND md.season_id = ?
         JOIN players p ON p.id = d.player_id
        GROUP BY d.player_id HAVING SUM(d.attended) > 0 ORDER BY p.display_name COLLATE NOCASE`,
      poll.season_id,
    ),
    all<{ id: string }>(db, "SELECT id FROM players WHERE user_id IS NOT NULL AND approved = 1 AND active = 1 AND kind = 'member'"),
  ]);
  return { candidates, voters: new Set(voters.map((v) => v.id)) };
}

async function myPlayerId(c: Ctx) {
  const u = c.get("user");
  if (!u) return null;
  return (await first<{ id: string }>(c.env.DB, "SELECT id FROM players WHERE user_id = ?", u.id))?.id ?? null;
}

const avatar = (id: string, v: string | null) => (v ? `/api/players/${id}/avatar?v=${encodeURIComponent(v)}` : null);

async function pollDetail(c: Ctx, poll: PollRow) {
  const db = c.env.DB;
  const now = new Date();
  const open = poll.day_status === "cancelled" ? false : pollOpen({ opensAt: poll.opens_at, closesAt: poll.closes_at, closedEarlyAt: poll.closed_early_at }, now);
  const me = await myPlayerId(c);
  const { candidates, voters } = await eligibility(db, poll);
  const votes = await all<{ voter_player_id: string; candidate_player_id: string }>(db, "SELECT voter_player_id, candidate_player_id FROM votes WHERE poll_id = ?", poll.id);
  const myVote = me ? votes.find((v) => v.voter_player_id === me)?.candidate_player_id ?? null : null;
  const names = new Map(candidates.map((p) => [p.player_id, p]));
  // Results stay hidden while voting is open, so early votes can't sway later ones.
  const tally = open ? null : tallyVotes(votes.map((v) => ({ candidatePlayerId: v.candidate_player_id })));
  return {
    id: poll.id,
    kind: poll.kind,
    matchDayId: poll.match_day_id,
    matchDayDate: poll.date ?? null,
    seasonId: poll.season_id,
    seasonName: poll.season_name,
    opensAt: poll.opens_at,
    closesAt: poll.closed_early_at ?? poll.closes_at,
    open,
    cancelled: poll.day_status === "cancelled",
    turnout: { voted: votes.length, eligible: voters.size },
    canVote: open && me !== null && voters.has(me),
    myVote,
    candidates: candidates
      .filter((p) => p.player_id !== me)
      .map((p) => ({ playerId: p.player_id, displayName: p.display_name, kind: p.kind, avatarUrl: avatar(p.player_id, p.avatar_updated_at) })),
    results: tally
      ? {
          total: tally.total,
          winners: tally.winners.map((id) => ({ playerId: id, displayName: names.get(id)?.display_name ?? "Unknown", avatarUrl: avatar(id, names.get(id)?.avatar_updated_at ?? null) })),
          ranked: tally.ranked.map((r) => ({ ...r, displayName: names.get(r.playerId)?.display_name ?? "Unknown" })),
        }
      : null,
  };
}

async function loadPoll(db: D1Database, id: string) {
  const poll = await first<PollRow>(db, `${POLL_SQL} WHERE p.id = ?`, id);
  if (!poll) throw new HttpError(404, "Vote not found.");
  return poll;
}

export async function pollForDay(c: Ctx, dayId: string) {
  const poll = await first<PollRow>(c.env.DB, `${POLL_SQL} WHERE p.match_day_id = ?`, dayId);
  return poll ? pollDetail(c, poll) : null;
}

/** Polls the current user can vote in right now (for the dashboard). */
export async function openPollsForMe(c: Ctx) {
  const now = nowIso();
  const polls = await all<PollRow>(
    c.env.DB,
    `${POLL_SQL} WHERE p.closed_early_at IS NULL AND p.opens_at <= ? AND p.closes_at > ? AND (md.status IS NULL OR md.status <> 'cancelled') ORDER BY p.closes_at`,
    now,
    now,
  );
  const details = await Promise.all(polls.map((p) => pollDetail(c, p)));
  return details.filter((d) => d.canVote);
}

mvpRoutes.get("/polls", requireUser, async (c) => {
  const seasonId = c.req.query("seasonId") ?? null;
  const polls = await all<PollRow>(c.env.DB, `${POLL_SQL} WHERE (?1 IS NULL OR p.season_id = ?1) ORDER BY p.created_at DESC LIMIT 60`, seasonId);
  return c.json({ polls: await Promise.all(polls.map((p) => pollDetail(c, p))) });
});

mvpRoutes.get("/polls/:id", requireUser, async (c) => c.json({ poll: await pollDetail(c, await loadPoll(c.env.DB, c.req.param("id"))) }));

mvpRoutes.post("/polls/:id/vote", requireUser, async (c) => {
  const input = await body(c, z.object({ candidatePlayerId: zId }));
  const db = c.env.DB;
  const poll = await loadPoll(db, c.req.param("id"));
  if (poll.day_status === "cancelled" || !pollOpen({ opensAt: poll.opens_at, closesAt: poll.closes_at, closedEarlyAt: poll.closed_early_at }, new Date())) {
    throw new HttpError(409, "Voting has closed.");
  }
  const me = await myPlayerId(c);
  if (!me) throw new HttpError(409, "Your login isn't linked to a player.");
  const { candidates, voters } = await eligibility(db, poll);
  const err = validateVote(me, input.candidatePlayerId, voters, new Set(candidates.map((p) => p.player_id)));
  if (err) throw new HttpError(err.includes("eligible") ? 403 : 422, err);
  const now = nowIso();
  // Upsert: one vote per voter, changeable while open. The closing check is repeated in SQL.
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO votes (poll_id, voter_player_id, candidate_player_id, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?4 FROM polls WHERE id = ?1 AND closed_early_at IS NULL AND closes_at > ?4
       ON CONFLICT (poll_id, voter_player_id) DO UPDATE SET candidate_player_id = excluded.candidate_player_id, updated_at = excluded.updated_at`,
      poll.id,
      me,
      input.candidatePlayerId,
      now,
    ),
    guard(db),
  ], "Voting has closed.");
  return c.json({ poll: await pollDetail(c, poll) });
});

mvpRoutes.post("/seasons/:id/mvp-poll", requireAdmin, async (c) => {
  const input = await body(c, z.object({ days: z.number().int().min(1).max(30).default(7) }));
  const db = c.env.DB;
  const season = await first<{ id: string; status: string }>(db, "SELECT id, status FROM seasons WHERE id = ?", c.req.param("id"));
  if (!season) throw new HttpError(404, "Season not found.");
  const now = new Date();
  const id = newId();
  await atomic(
    db,
    [
      stmt(
        db,
        "INSERT INTO polls (id, kind, season_id, opens_at, closes_at, created_by, created_at) VALUES (?, 'season', ?, ?, ?, ?, ?)",
        id,
        season.id,
        now.toISOString(),
        new Date(now.getTime() + input.days * 86400_000).toISOString(),
        c.get("user")!.id,
        now.toISOString(),
      ),
      auditStmt(c, { action: "poll.season_open", entityType: "poll", entityId: id, after: { seasonId: season.id, days: input.days } }),
    ],
    "This season already has an MVP vote.",
  );
  return c.json({ poll: await pollDetail(c, await loadPoll(db, id)) }, 201);
});

mvpRoutes.post("/polls/:id/close", requireAdmin, async (c) => {
  const db = c.env.DB;
  const poll = await loadPoll(db, c.req.param("id"));
  await atomic(db, [
    stmt(db, "UPDATE polls SET closed_early_at = ? WHERE id = ? AND closed_early_at IS NULL AND closes_at > ?", nowIso(), poll.id, nowIso()),
    guard(db),
    auditStmt(c, { action: "poll.close", entityType: "poll", entityId: poll.id }),
  ], "This vote is already closed.");
  return c.json({ poll: await pollDetail(c, await loadPoll(db, poll.id)) });
});

/** MVP award counts per player (closed polls only), for stats and profiles. */
export async function mvpAwards(c: Ctx, seasonId: string | null) {
  const polls = await all<PollRow>(
    c.env.DB,
    `${POLL_SQL} WHERE (?1 IS NULL OR p.season_id = ?1) AND (md.status IS NULL OR md.status <> 'cancelled') AND (p.closed_early_at IS NOT NULL OR p.closes_at <= ?2)`,
    seasonId,
    nowIso(),
  );
  const weekly = new Map<string, number>();
  const season = new Map<string, string[]>();
  for (const p of polls) {
    const votes = await all<{ candidate_player_id: string }>(c.env.DB, "SELECT candidate_player_id FROM votes WHERE poll_id = ?", p.id);
    const { winners } = tallyVotes(votes.map((v) => ({ candidatePlayerId: v.candidate_player_id })));
    for (const w of winners) {
      if (p.kind === "matchday") weekly.set(w, (weekly.get(w) ?? 0) + 1);
      else season.set(p.season_id, [...(season.get(p.season_id) ?? []), w]);
    }
  }
  return { weekly, season };
}


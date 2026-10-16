import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { all, atomic, auditStmt, first, guard, HttpError, newId, nowIso, stmt } from "../lib/db";
import { isAdmin, requireAdmin, requireUser } from "../lib/guards";
import { commitDay, loadDayFull, toDayState } from "../lib/matchday";
import { body, zName, zReason } from "../lib/validate";

export const playerRoutes = new Hono<AppEnv>();

export interface PlayerRow {
  id: string;
  display_name: string;
  kind: "member" | "guest";
  user_id: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  skill_rating: number;
  gk_preference: "none" | "can" | "prefers";
  active: number;
  member_since: string | null;
  created_at: string;
}

/** Public shape: no contact details or ratings. */
export const publicPlayer = (p: PlayerRow) => ({
  id: p.id,
  displayName: p.display_name,
  kind: p.kind,
  active: p.active === 1,
  hasAccount: Boolean(p.user_id),
});

/** Admin shape: includes private fields. */
export const adminPlayer = (p: PlayerRow & { email?: string | null }) => ({
  ...publicPlayer(p),
  contactEmail: p.contact_email,
  contactPhone: p.contact_phone,
  skillRating: p.skill_rating,
  gkPreference: p.gk_preference,
  memberSince: p.member_since,
  accountEmail: p.email ?? null,
  createdAt: p.created_at,
});

async function loadPlayer(db: D1Database, id: string) {
  const p = await first<PlayerRow & { email: string | null }>(
    db,
    "SELECT p.*, u.email FROM players p LEFT JOIN user u ON u.id = p.user_id WHERE p.id = ?",
    id,
  );
  if (!p) throw new HttpError(404, "Player not found.");
  return p;
}

playerRoutes.get("/players", requireUser, async (c) => {
  const rows = await all<PlayerRow & { email: string | null }>(
    c.env.DB,
    "SELECT p.*, u.email FROM players p LEFT JOIN user u ON u.id = p.user_id ORDER BY p.active DESC, p.kind DESC, p.display_name COLLATE NOCASE",
  );
  const admin = isAdmin(c);
  return c.json({ players: rows.map((p) => (admin ? adminPlayer(p) : publicPlayer(p))) });
});

playerRoutes.get("/players/:id", requireUser, async (c) => {
  const db = c.env.DB;
  const p = await loadPlayer(db, c.req.param("id"));
  const [seasons, history] = await Promise.all([
    all(
      db,
      `SELECT s.id AS seasonId, s.name, s.status, SUM(d.points) AS points, SUM(d.daily_win) AS dailyWins,
              SUM(d.attended) AS appearances, SUM(d.goals) AS goals, SUM(d.assists) AS assists, SUM(d.own_goals) AS ownGoals
         FROM day_player_stats d
         JOIN match_days md ON md.id = d.match_day_id AND md.status = 'finalized'
         JOIN seasons s ON s.id = md.season_id
        WHERE d.player_id = ? GROUP BY s.id ORDER BY s.start_date DESC`,
      p.id,
    ),
    all(
      db,
      `SELECT md.id AS matchDayId, md.date, md.venue, st.name AS setName, st.color AS setColor, st.is_daily_winner AS setWon,
              d.attended, d.eligible, d.points, d.goals, d.assists, d.own_goals AS ownGoals
         FROM day_player_stats d
         JOIN match_days md ON md.id = d.match_day_id AND md.status = 'finalized'
         LEFT JOIN sets st ON st.id = d.set_id
        WHERE d.player_id = ? ORDER BY md.date DESC LIMIT 100`,
      p.id,
    ),
  ]);
  const self = c.get("user")?.id === p.user_id;
  return c.json({ player: isAdmin(c) ? adminPlayer(p) : publicPlayer(p), isSelf: self, seasons, history });
});

const zPlayerFields = {
  displayName: zName,
  contactEmail: z.union([z.string().trim().toLowerCase().email(), z.literal("")]).nullable().optional(),
  contactPhone: z.string().trim().max(30).nullable().optional(),
  skillRating: z.number().int().min(1).max(10).optional(),
  gkPreference: z.enum(["none", "can", "prefers"]).optional(),
};

playerRoutes.post("/players", requireAdmin, async (c) => {
  const input = await body(c, z.object({ ...zPlayerFields, kind: z.enum(["member", "guest"]).default("member") }));
  const db = c.env.DB;
  const id = newId();
  const now = nowIso();
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO players (id, display_name, kind, contact_email, contact_phone, skill_rating, gk_preference, member_since, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.displayName,
      input.kind,
      input.contactEmail || null,
      input.contactPhone || null,
      input.skillRating ?? 5,
      input.gkPreference ?? "none",
      input.kind === "member" ? now : null,
      now,
      now,
    ),
    auditStmt(c, { action: "player.create", entityType: "player", entityId: id, after: { displayName: input.displayName, kind: input.kind } }),
  ]);
  return c.json({ player: adminPlayer(await loadPlayer(db, id)) }, 201);
});

playerRoutes.patch("/players/:id", requireAdmin, async (c) => {
  const input = await body(c, z.object({ ...zPlayerFields, displayName: zName.optional(), active: z.boolean().optional() }));
  const db = c.env.DB;
  const p = await loadPlayer(db, c.req.param("id"));
  const next = {
    display_name: input.displayName ?? p.display_name,
    contact_email: input.contactEmail === undefined ? p.contact_email : input.contactEmail || null,
    contact_phone: input.contactPhone === undefined ? p.contact_phone : input.contactPhone || null,
    skill_rating: input.skillRating ?? p.skill_rating,
    gk_preference: input.gkPreference ?? p.gk_preference,
    active: input.active === undefined ? p.active : input.active ? 1 : 0,
  };
  await atomic(db, [
    stmt(
      db,
      `UPDATE players SET display_name = ?, contact_email = ?, contact_phone = ?, skill_rating = ?, gk_preference = ?, active = ?, updated_at = ? WHERE id = ?`,
      next.display_name,
      next.contact_email,
      next.contact_phone,
      next.skill_rating,
      next.gk_preference,
      next.active,
      nowIso(),
      p.id,
    ),
    auditStmt(c, {
      action: "player.update",
      entityType: "player",
      entityId: p.id,
      before: { displayName: p.display_name, skillRating: p.skill_rating, gkPreference: p.gk_preference, active: p.active },
      after: { displayName: next.display_name, skillRating: next.skill_rating, gkPreference: next.gk_preference, active: next.active },
    }),
  ]);
  return c.json({ player: adminPlayer(await loadPlayer(db, p.id)) });
});

/**
 * Convert a guest to a member, keeping the same player id (so goals/assists/history stay attached).
 * Default is prospective: only rosters locked after conversion count for points. `retroactive`
 * re-evaluates this player's finalized days in the active season (audited correction).
 */
playerRoutes.post("/players/:id/convert", requireAdmin, async (c) => {
  const input = await body(c, z.object({ retroactive: z.boolean().default(false), reason: zReason }));
  const db = c.env.DB;
  const p = await loadPlayer(db, c.req.param("id"));
  if (p.kind === "member") throw new HttpError(409, "This player is already a member.");
  if (input.retroactive && (!input.reason || input.reason.length < 3)) {
    throw new HttpError(422, "Give a reason for applying the conversion retroactively.");
  }
  const now = nowIso();
  await atomic(db, [
    stmt(db, "UPDATE players SET kind = 'member', member_since = ?, updated_at = ? WHERE id = ? AND kind = 'guest'", now, now, p.id),
    guard(db),
    auditStmt(c, {
      action: "player.convert_to_member",
      entityType: "player",
      entityId: p.id,
      reason: input.reason,
      before: { kind: "guest" },
      after: { kind: "member", retroactive: input.retroactive },
    }),
  ]);
  let recomputedDays = 0;
  if (input.retroactive) recomputedDays = await applyRetroactiveMembership(c, p.id, input.reason!);
  return c.json({ player: adminPlayer(await loadPlayer(db, p.id)), recomputedDays });
});

async function applyRetroactiveMembership(c: Ctx, playerId: string, reason: string) {
  const db = c.env.DB;
  const days = await all<{ id: string }>(
    db,
    `SELECT md.id FROM roster_entries r JOIN match_days md ON md.id = r.match_day_id JOIN seasons s ON s.id = md.season_id
      WHERE r.player_id = ? AND s.status = 'active' AND md.status IN ('in_progress', 'finalized') AND r.member_at_lock = 0`,
    playerId,
  );
  for (const { id } of days) {
    const loaded = await loadDayFull(db, id);
    const state = toDayState(loaded);
    state.roster = state.roster.map((r) => (r.playerId === playerId ? { ...r, memberAtLock: true } : r));
    await commitDay(
      c,
      loaded.day,
      [stmt(db, "UPDATE roster_entries SET member_at_lock = 1 WHERE match_day_id = ? AND player_id = ?", id, playerId)],
      {
        recompute: loaded.day.status === "finalized" ? state : undefined,
        audit: { action: "correction.retroactive_membership", entityType: "player", entityId: playerId, reason, before: { memberAtLock: false }, after: { memberAtLock: true } },
      },
    );
  }
  return days.length;
}

playerRoutes.post("/players/:id/invite", requireAdmin, async (c) => {
  const db = c.env.DB;
  const p = await loadPlayer(db, c.req.param("id"));
  if (p.user_id) throw new HttpError(409, "This player already has a login.");
  const token = randomToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 86400_000).toISOString();
  await atomic(db, [
    // Only one live invite per player.
    stmt(db, "DELETE FROM player_invites WHERE player_id = ? AND used_at IS NULL", p.id),
    stmt(
      db,
      "INSERT INTO player_invites (token_hash, player_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      await sha256Hex(token),
      p.id,
      c.get("user")!.id,
      expiresAt,
      now.toISOString(),
    ),
    auditStmt(c, { action: "player.invite", entityType: "player", entityId: p.id, after: { expiresAt } }),
  ]);
  const origin = c.env.BETTER_AUTH_URL || new URL(c.req.url).origin;
  return c.json({ url: `${origin}/invite/${token}`, expiresAt });
});

playerRoutes.post("/players/:id/unlink", requireAdmin, async (c) => {
  const input = await body(c, z.object({ reason: zReason }));
  const db = c.env.DB;
  const p = await loadPlayer(db, c.req.param("id"));
  if (!p.user_id) throw new HttpError(409, "This player has no linked login.");
  if (p.user_id === c.get("user")!.id) throw new HttpError(409, "You cannot unlink your own login.");
  await atomic(db, [
    stmt(db, "UPDATE players SET user_id = NULL, updated_at = ? WHERE id = ?", nowIso(), p.id),
    stmt(db, "DELETE FROM session WHERE userId = ?", p.user_id),
    auditStmt(c, { action: "player.account_unlinked", entityType: "player", entityId: p.id, reason: input.reason, before: { userId: p.user_id } }),
  ]);
  return c.json({ ok: true });
});

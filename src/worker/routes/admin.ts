import { Hono } from "hono";
import { z } from "zod";
import { isValidTimeZone } from "../../shared/time";
import type { AppEnv } from "../env";
import { all, atomic, auditStmt, first, guard, HttpError, nowIso, stmt } from "../lib/db";
import { requireAdmin } from "../lib/guards";
import { body, zId, zReason } from "../lib/validate";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("/admin/*", requireAdmin);

const SETTINGS_KEYS = ["group_name", "timezone", "default_capacity", "default_team_size", "default_set_count", "default_venue"] as const;

adminRoutes.get("/admin/settings", async (c) => {
  const rows = await all<{ key: string; value: string }>(c.env.DB, "SELECT key, value FROM settings");
  return c.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

adminRoutes.put("/admin/settings", async (c) => {
  const input = await body(
    c,
    z.object({
      group_name: z.string().trim().min(1).max(60).optional(),
      timezone: z.string().max(64).optional(),
      default_capacity: z.coerce.number().int().min(2).max(200).optional(),
      default_team_size: z.coerce.number().int().min(1).max(30).optional(),
      default_set_count: z.coerce.number().int().min(2).max(12).optional(),
      default_venue: z.string().trim().max(120).optional(),
    }),
  );
  if (input.timezone && !isValidTimeZone(input.timezone)) throw new HttpError(422, "Unknown timezone.");
  const db = c.env.DB;
  const before = Object.fromEntries((await all<{ key: string; value: string }>(db, "SELECT key, value FROM settings")).map((r) => [r.key, r.value]));
  const now = nowIso();
  const statements = SETTINGS_KEYS.filter((k) => input[k] !== undefined).map((k) =>
    stmt(db, "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", k, String(input[k]), now),
  );
  if (statements.length) {
    await atomic(db, [...statements, auditStmt(c, { action: "settings.update", entityType: "settings", entityId: "global", before, after: input })]);
  }
  const rows = await all<{ key: string; value: string }>(db, "SELECT key, value FROM settings");
  return c.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

adminRoutes.get("/admin/audit", async (c) => {
  const matchDayId = c.req.query("matchDayId") ?? null;
  const before = c.req.query("before") ?? null;
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const rows = await all<Record<string, string | null>>(
    c.env.DB,
    `SELECT * FROM audit_log WHERE (?1 IS NULL OR match_day_id = ?1) AND (?2 IS NULL OR created_at < ?2) ORDER BY created_at DESC LIMIT ?3`,
    matchDayId,
    before,
    limit,
  );
  return c.json({
    entries: rows.map((r) => ({
      id: r.id,
      actorName: r.actor_name,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      matchDayId: r.match_day_id,
      reason: r.reason,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
      createdAt: r.created_at,
    })),
  });
});

adminRoutes.get("/admin/users", async (c) => {
  const rows = await all<{ id: string; name: string; email: string; role: string; createdAt: string; player_id: string | null; player_name: string | null }>(
    c.env.DB,
    `SELECT u.id, u.name, u.email, u.role, u.createdAt, p.id AS player_id, p.display_name AS player_name
       FROM user u LEFT JOIN players p ON p.user_id = u.id ORDER BY u.role, u.name COLLATE NOCASE`,
  );
  return c.json({
    users: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, createdAt: r.createdAt, playerId: r.player_id, playerName: r.player_name })),
  });
});

adminRoutes.post("/admin/users/:id/role", async (c) => {
  const input = await body(c, z.object({ role: z.enum(["admin", "member"]), reason: zReason }));
  const db = c.env.DB;
  const target = await first<{ id: string; role: string; name: string }>(db, "SELECT id, role, name FROM user WHERE id = ?", c.req.param("id"));
  if (!target) throw new HttpError(404, "User not found.");
  if (target.role === input.role) return c.json({ ok: true });
  await atomic(
    db,
    [
      // Never remove the last admin.
      stmt(
        db,
        `UPDATE user SET role = ?1, updatedAt = ?3 WHERE id = ?2
          AND (?1 = 'admin' OR (SELECT COUNT(*) FROM user WHERE role = 'admin' AND id <> ?2) > 0)`,
        input.role,
        target.id,
        nowIso(),
      ),
      guard(db),
      auditStmt(c, { action: "user.role", entityType: "user", entityId: target.id, reason: input.reason, before: { role: target.role }, after: { role: input.role } }),
    ],
    "There must always be at least one admin.",
  );
  return c.json({ ok: true });
});

/** Link an existing login (without a player) to a player record. */
adminRoutes.post("/admin/users/:id/link", async (c) => {
  const input = await body(c, z.object({ playerId: zId }));
  const db = c.env.DB;
  const userId = c.req.param("id");
  if (!(await first(db, "SELECT 1 FROM user WHERE id = ?", userId))) throw new HttpError(404, "User not found.");
  if (await first(db, "SELECT 1 FROM players WHERE user_id = ?", userId)) throw new HttpError(409, "This login is already linked to a player.");
  await atomic(
    db,
    [
      stmt(db, "UPDATE players SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS NULL", userId, nowIso(), input.playerId),
      guard(db),
      auditStmt(c, { action: "player.account_linked", entityType: "player", entityId: input.playerId, after: { userId } }),
    ],
    "That player already has a login.",
  );
  return c.json({ ok: true });
});

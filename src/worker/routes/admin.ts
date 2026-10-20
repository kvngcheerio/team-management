import { Hono } from "hono";
import { z } from "zod";
import { isValidTimeZone } from "../../shared/time";
import type { AppEnv, Ctx } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { all, atomic, auditStmt, first, guard, HttpError, nowIso, stmt } from "../lib/db";
import { requireAdmin } from "../lib/guards";
import { runSchedule } from "../lib/schedule";
import { body, zId, zReason } from "../lib/validate";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("/admin/*", requireAdmin);

const SETTINGS_KEYS = [
  "group_name",
  "timezone",
  "default_capacity",
  "default_team_size",
  "default_set_count",
  "default_venue",
  "team_sheet_time",
  "fine_yellow",
  "fine_red",
  "signup_enabled",
  "membership_fee",
  "membership_months",
  "guest_fee",
  "guest_free_after",
  "referral_credit",
  "payment_mode",
  "bank_name",
  "bank_account_number",
  "bank_account_name",
  "match_weekdays",
  "schedule_kickoff",
  "schedule_open_days_before",
  "schedule_close_hours_before",
  "schedule_weeks_ahead",
] as const;

/** Settings safe to return to admins (the signup token is returned as a full URL instead). */
async function readSettings(c: Ctx) {
  const rows = await all<{ key: string; value: string }>(c.env.DB, "SELECT key, value FROM settings");
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const origin = c.env.BETTER_AUTH_URL || new URL(c.req.url).origin;
  const { signup_token, ...rest } = map;
  return { settings: rest, signupUrl: signup_token ? `${origin}/join/${signup_token}` : null };
}

adminRoutes.get("/admin/settings", async (c) => c.json(await readSettings(c)));

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
      team_sheet_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)").optional(),
      fine_yellow: z.coerce.number().int().min(0).max(1_000_000).optional(),
      fine_red: z.coerce.number().int().min(0).max(1_000_000).optional(),
      signup_enabled: z.enum(["0", "1"]).optional(),
      membership_fee: z.coerce.number().int().min(0).max(10_000_000).optional(),
      membership_months: z.coerce.number().int().min(1).max(24).optional(),
      guest_fee: z.coerce.number().int().min(0).max(1_000_000).optional(),
      guest_free_after: z.coerce.number().int().min(0).max(100).optional(),
      referral_credit: z.coerce.number().int().min(0).max(1_000_000).optional(),
      payment_mode: z.enum(["transfer", "test"]).optional(),
      bank_name: z.string().trim().max(60).optional(),
      bank_account_number: z.string().trim().regex(/^\d{6,20}$/, "Account number should be digits only").optional(),
      bank_account_name: z.string().trim().max(80).optional(),
      match_weekdays: z.string().regex(/^([1-7](,[1-7])*)?$/, "Pick weekdays").optional(),
      schedule_kickoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)").optional(),
      schedule_open_days_before: z.coerce.number().int().min(0).max(14).optional(),
      schedule_close_hours_before: z.coerce.number().int().min(0).max(72).optional(),
      schedule_weeks_ahead: z.coerce.number().int().min(1).max(8).optional(),
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
  return c.json(await readSettings(c));
});

/** Replace the shareable signup link; the old link stops working immediately. */
adminRoutes.post("/admin/signup-link/rotate", async (c) => {
  const db = c.env.DB;
  await atomic(db, [
    stmt(db, "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'signup_token'", randomToken(16), nowIso()),
    auditStmt(c, { action: "settings.signup_link_rotated", entityType: "settings", entityId: "signup_token" }),
  ]);
  return c.json(await readSettings(c));
});

// Admin invites ----------------------------------------------------------------

adminRoutes.get("/admin/admin-invites", async (c) => {
  const rows = await all<{ token_hash: string; note: string | null; expires_at: string; used_at: string | null; created_at: string; used_by_email: string | null }>(
    c.env.DB,
    `SELECT i.token_hash, i.note, i.expires_at, i.used_at, i.created_at, u.email AS used_by_email
       FROM admin_invites i LEFT JOIN user u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 50`,
  );
  return c.json({
    invites: rows.map((r) => ({ id: r.token_hash.slice(0, 16), note: r.note, expiresAt: r.expires_at, usedAt: r.used_at, usedByEmail: r.used_by_email, createdAt: r.created_at })),
  });
});

adminRoutes.post("/admin/admin-invites", async (c) => {
  const input = await body(c, z.object({ note: z.string().trim().max(100).optional() }));
  const db = c.env.DB;
  const token = randomToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 86400_000).toISOString();
  await atomic(db, [
    stmt(db, "INSERT INTO admin_invites (token_hash, note, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)", await sha256Hex(token), input.note || null, c.get("user")!.id, expiresAt, now.toISOString()),
    auditStmt(c, { action: "user.admin_invite_created", entityType: "admin_invite", entityId: "new", after: { note: input.note, expiresAt } }),
  ]);
  const origin = c.env.BETTER_AUTH_URL || new URL(c.req.url).origin;
  return c.json({ url: `${origin}/admin-invite/${token}`, expiresAt }, 201);
});

adminRoutes.delete("/admin/admin-invites/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(404, "Invite not found.");
  await atomic(db, [
    stmt(db, "DELETE FROM admin_invites WHERE substr(token_hash, 1, 16) = ? AND used_at IS NULL", id),
    guard(db),
    auditStmt(c, { action: "user.admin_invite_revoked", entityType: "admin_invite", entityId: id }),
  ], "Invite not found or already used.");
  return c.json({ ok: true });
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

/** Run the weekly schedule now (the cron also runs it daily). */
adminRoutes.post("/admin/schedule/run", async (c) => {
  const result = await runSchedule(c.env.DB);
  return c.json(result);
});

import { Hono } from "hono";
import { z } from "zod";
import { selfCheckInOpen } from "../../shared/rules";
import { createAuth } from "../auth";
import type { AppEnv, Ctx } from "../env";
import { safeStringEqual, sha256Hex } from "../lib/crypto";
import { atomic, auditStmt, first, getSetting, guard, HttpError, newId, nowIso, stmt } from "../lib/db";
import { rateLimit } from "../lib/rate-limit";
import { body, zName } from "../lib/validate";

export const publicRoutes = new Hono<AppEnv>();

const zPassword = z.string().min(10, "Password must be at least 10 characters").max(128);
const zEmail = z.string().trim().toLowerCase().email("Enter a valid email").max(200);

/** Create a Better Auth email/password account server-side; returns the user id and Set-Cookie headers. */
async function createAccount(c: Ctx, name: string, email: string, password: string) {
  const auth = createAuth(c.env, c.req.url);
  let res: Response;
  try {
    res = await auth.api.signUpEmail({ body: { name, email, password }, headers: c.req.raw.headers, asResponse: true });
  } catch (err) {
    throw new HttpError(422, (err as Error).message || "Could not create the account.");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    const msg = data.code === "USER_ALREADY_EXISTS" || /exist/i.test(data.message ?? "")
      ? "An account with that email already exists."
      : data.message || "Could not create the account.";
    throw new HttpError(422, msg);
  }
  const data = (await res.clone().json()) as { user: { id: string } };
  return { userId: data.user.id, cookies: res.headers.getSetCookie() };
}

async function deleteUser(db: D1Database, userId: string) {
  await db.batch([
    stmt(db, "DELETE FROM session WHERE userId = ?", userId),
    stmt(db, "DELETE FROM account WHERE userId = ?", userId),
    stmt(db, "DELETE FROM user WHERE id = ?", userId),
  ]);
}

function withCookies(c: Ctx, payload: unknown, cookies: string[]) {
  const res = c.json(payload);
  for (const cookie of cookies) res.headers.append("Set-Cookie", cookie);
  return res;
}

// ---------------------------------------------------------------------------
// First-admin setup
// ---------------------------------------------------------------------------

publicRoutes.get("/setup/status", async (c) => {
  const admin = await first(c.env.DB, "SELECT 1 FROM user WHERE role = 'admin' LIMIT 1");
  return c.json({ needsSetup: !admin, setupTokenConfigured: Boolean(c.env.SETUP_TOKEN) });
});

publicRoutes.post("/setup", async (c) => {
  await rateLimit(c, "setup", 5, 600);
  const input = await body(
    c,
    z.object({
      token: z.string().min(1),
      name: zName,
      email: zEmail,
      password: zPassword,
      alsoPlayer: z.boolean().default(true),
    }),
  );
  if (!c.env.SETUP_TOKEN) throw new HttpError(403, "Setup is disabled: set the SETUP_TOKEN secret first.");
  if (!safeStringEqual(input.token, c.env.SETUP_TOKEN)) throw new HttpError(403, "Invalid setup token.");
  if (await first(c.env.DB, "SELECT 1 FROM user WHERE role = 'admin' LIMIT 1")) {
    throw new HttpError(409, "Setup is already complete.");
  }
  const { userId, cookies } = await createAccount(c, input.name, input.email, input.password);
  const db = c.env.DB;
  const now = nowIso();
  const statements = [
    // Promote only if there is still no admin (guards against two concurrent setups).
    stmt(db, "UPDATE user SET role = 'admin' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM user WHERE role = 'admin')", userId),
    guard(db),
  ];
  if (input.alsoPlayer) {
    statements.push(
      stmt(
        db,
        `INSERT INTO players (id, display_name, kind, user_id, contact_email, member_since, created_at, updated_at)
         VALUES (?, ?, 'member', ?, ?, ?, ?, ?)`,
        newId(),
        input.name,
        userId,
        input.email,
        now,
        now,
        now,
      ),
    );
  }
  try {
    await atomic(db, statements, "Setup is already complete.");
  } catch (err) {
    await deleteUser(db, userId);
    throw err;
  }
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_user_id, actor_name, action, entity_type, entity_id, created_at) VALUES (?, ?, ?, 'setup.first_admin', 'user', ?, ?)`,
    )
    .bind(newId(), userId, input.name, userId, now)
    .run();
  return withCookies(c, { ok: true }, cookies);
});

// ---------------------------------------------------------------------------
// Guest registration via a shareable match-day link
// ---------------------------------------------------------------------------

interface PublicDay {
  id: string;
  date: string;
  kickoff_time: string;
  venue: string;
  status: string;
  checkin_deadline: string;
  capacity: number;
  timezone: string;
  confirmed: number;
}

async function publicDay(db: D1Database, token: string) {
  const day = await first<PublicDay>(
    db,
    `SELECT md.id, md.date, md.kickoff_time, md.venue, md.status, md.checkin_deadline, md.capacity, s.timezone,
       (SELECT COUNT(*) FROM registrations r WHERE r.match_day_id = md.id AND r.status = 'confirmed') AS confirmed
     FROM match_days md JOIN seasons s ON s.id = md.season_id WHERE md.public_token = ?`,
    token,
  );
  if (!day) throw new HttpError(404, "This registration link is not valid.");
  return day;
}

publicRoutes.get("/public/matchdays/:token", async (c) => {
  const day = await publicDay(c.env.DB, c.req.param("token"));
  return c.json({
    groupName: await getSetting(c.env.DB, "group_name", "Matchday"),
    date: day.date,
    kickoffTime: day.kickoff_time,
    venue: day.venue,
    status: day.status,
    timezone: day.timezone,
    checkinDeadline: day.checkin_deadline,
    spotsLeft: Math.max(0, day.capacity - day.confirmed),
    open: selfCheckInOpen(day.status as never, day.checkin_deadline, new Date()),
  });
});

publicRoutes.post("/public/matchdays/:token/guests", async (c) => {
  await rateLimit(c, "guest-form", 5, 600);
  const input = await body(
    c,
    z.object({
      name: zName,
      email: z.union([zEmail, z.literal("")]).optional(),
      phone: z.string().trim().max(30).regex(/^[+\d\s()-]*$/, "Enter a valid phone number").optional(),
      note: z.string().trim().max(200).optional(),
      // Spam traps: a hidden field humans leave empty, and the time spent on the form.
      website: z.string().max(200).optional(),
      elapsedMs: z.number().int().nonnegative().optional(),
    }),
  );
  const day = await publicDay(c.env.DB, c.req.param("token"));
  const looksLikeBot = Boolean(input.website) || (input.elapsedMs ?? 0) < 2500;
  if (looksLikeBot) {
    // Pretend success so bots get no signal.
    return c.json({ ok: true, status: "pending" });
  }
  if (!selfCheckInOpen(day.status as never, day.checkin_deadline, new Date())) {
    throw new HttpError(409, "Registration for this match day is closed.");
  }
  const db = c.env.DB;
  const pendingCount = await first<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM registrations WHERE match_day_id = ? AND source = 'guest_form' AND status = 'pending'",
    day.id,
  );
  if ((pendingCount?.n ?? 0) >= 40) throw new HttpError(429, "Too many pending guest requests for this day. Contact the organiser.");
  const duplicate = await first(
    db,
    `SELECT 1 FROM registrations r JOIN players p ON p.id = r.player_id
     WHERE r.match_day_id = ? AND lower(p.display_name) = lower(?) AND r.status IN ('pending', 'confirmed', 'waitlist')`,
    day.id,
    input.name,
  );
  if (duplicate) throw new HttpError(409, "Someone with that name is already registered for this match day.");
  const now = nowIso();
  const playerId = newId();
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO players (id, display_name, kind, contact_email, contact_phone, created_at, updated_at)
       VALUES (?, ?, 'guest', ?, ?, ?, ?)`,
      playerId,
      input.name,
      input.email || null,
      input.phone || null,
      now,
      now,
    ),
    stmt(
      db,
      `INSERT INTO registrations (id, match_day_id, player_id, status, source, guest_note, queued_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'guest_form', ?, ?, ?, ?)`,
      newId(),
      day.id,
      playerId,
      input.note || null,
      now,
      now,
      now,
    ),
  ]);
  return c.json({ ok: true, status: "pending" });
});

// ---------------------------------------------------------------------------
// Player invites: link a login to an existing player record (keeps their history)
// ---------------------------------------------------------------------------

async function loadInvite(db: D1Database, token: string) {
  const invite = await first<{ token_hash: string; player_id: string; expires_at: string; used_at: string | null; display_name: string; user_id: string | null }>(
    db,
    `SELECT i.*, p.display_name, p.user_id FROM player_invites i JOIN players p ON p.id = i.player_id WHERE i.token_hash = ?`,
    await sha256Hex(token),
  );
  if (!invite || invite.used_at || invite.user_id || Date.parse(invite.expires_at) < Date.now()) {
    throw new HttpError(410, "This invite link has expired or was already used. Ask an admin for a new one.");
  }
  return invite;
}

publicRoutes.get("/public/invites/:token", async (c) => {
  const invite = await loadInvite(c.env.DB, c.req.param("token"));
  return c.json({ playerName: invite.display_name, groupName: await getSetting(c.env.DB, "group_name", "Matchday") });
});

publicRoutes.post("/public/invites/:token/accept", async (c) => {
  await rateLimit(c, "invite", 10, 600);
  const input = await body(c, z.object({ email: zEmail, password: zPassword }));
  const db = c.env.DB;
  const invite = await loadInvite(db, c.req.param("token"));
  const { userId, cookies } = await createAccount(c, invite.display_name, input.email, input.password);
  const now = nowIso();
  try {
    await atomic(
      db,
      [
        stmt(db, "UPDATE player_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", now, invite.token_hash, now),
        guard(db),
        stmt(db, "UPDATE players SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS NULL", userId, now, invite.player_id),
        guard(db),
        auditStmt(c, { action: "player.account_linked", entityType: "player", entityId: invite.player_id, after: { userId } }),
      ],
      "This invite was already used.",
    );
  } catch (err) {
    await deleteUser(db, userId);
    throw err;
  }
  return withCookies(c, { ok: true }, cookies);
});

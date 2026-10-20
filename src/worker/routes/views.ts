import { Hono } from "hono";
import { renewalStatus, RULES_SUMMARY } from "../../shared/rules";
import { walletBalance } from "../lib/access";
import { todayInZone } from "../../shared/time";
import type { AppEnv } from "../env";
import { all, first, getSetting } from "../lib/db";
import { isAdmin, requireUser } from "../lib/guards";
import { loadDayFull } from "../lib/matchday";
import { seasonTables } from "../lib/standings";
import { latestAnnouncements } from "./announcements";
import { buildDetail } from "./matchdays";
import { openPollsForMe } from "./mvp";

export const viewRoutes = new Hono<AppEnv>();

/** Session bootstrap: works signed-out too so the client can route to sign-in or setup. */
viewRoutes.get("/me", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const [groupName, timezone, admin] = await Promise.all([
    getSetting(db, "group_name", "Matchday"),
    getSetting(db, "timezone", "Africa/Lagos"),
    first(db, "SELECT 1 FROM user WHERE role = 'admin' LIMIT 1"),
  ]);
  const player = user
    ? await first<{ id: string; display_name: string; kind: "member" | "guest"; approved: number; avatar_updated_at: string | null; contact_phone: string | null; membership_paid_until: string | null }>(
        db,
        "SELECT id, display_name, kind, approved, avatar_updated_at, contact_phone, membership_paid_until FROM players WHERE user_id = ?",
        user.id,
      )
    : null;
  const outstanding = player
    ? ((await first<{ n: number }>(db, "SELECT COALESCE(SUM(fine_amount), 0) AS n FROM cards WHERE player_id = ? AND fine_status = 'unpaid' AND voided_at IS NULL", player.id))?.n ?? 0)
    : 0;
  return c.json({
    user,
    player: player
      ? {
          id: player.id,
          displayName: player.display_name,
          kind: player.kind,
          approved: player.approved === 1,
          contactPhone: player.contact_phone,
          avatarUrl: player.avatar_updated_at ? `/api/players/${player.id}/avatar?v=${encodeURIComponent(player.avatar_updated_at)}` : null,
          outstandingFines: outstanding,
          membershipPaidUntil: player.membership_paid_until,
          renewal: renewalStatus(player.kind, player.membership_paid_until, todayInZone(timezone)),
          wallet: await walletBalance(db, player.id),
        }
      : null,
    currency: await getSetting(db, "currency", "NGN"),
    groupName,
    timezone,
    needsSetup: !admin,
    rules: RULES_SUMMARY,
  });
});

viewRoutes.get("/dashboard", requireUser, async (c) => {
  const db = c.env.DB;
  const tz = await getSetting(db, "timezone", "Africa/Lagos");
  const today = todayInZone(tz);
  const season =
    (await first<{ id: string; name: string; start_date: string; end_date: string; timezone: string }>(
      db,
      "SELECT * FROM seasons WHERE status = 'active' AND start_date <= ?1 AND end_date >= ?1 ORDER BY start_date DESC LIMIT 1",
      today,
    )) ?? (await first<{ id: string; name: string; start_date: string; end_date: string; timezone: string }>(db, "SELECT * FROM seasons WHERE status = 'active' ORDER BY start_date DESC LIMIT 1"));

  const next = await first<{ id: string }>(
    db,
    `SELECT id FROM match_days WHERE status IN ('in_progress', 'locked', 'checkin_open') OR (status = 'draft' AND ?2 = 1)
      ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END, CASE WHEN date >= ?1 THEN 0 ELSE 1 END, date, kickoff_time LIMIT 1`,
    today,
    isAdmin(c) ? 1 : 0,
  );
  const nextDay = next ? await buildDetail(c, await loadDayFull(db, next.id)) : null;

  const recentRows = await all<{ id: string; date: string; venue: string; winners: string | null; matches: number }>(
    db,
    `SELECT md.id, md.date, md.venue,
        (SELECT json_group_array(json_object('name', s.name, 'color', s.color)) FROM sets s WHERE s.match_day_id = md.id AND s.is_daily_winner = 1) AS winners,
        (SELECT COUNT(*) FROM matches m WHERE m.match_day_id = md.id AND m.status = 'completed') AS matches
       FROM match_days md WHERE md.status = 'finalized' ORDER BY md.date DESC LIMIT 4`,
  );
  const tables = season ? await seasonTables(db, season.id) : null;
  const pendingGuests = isAdmin(c)
    ? ((await first<{ n: number }>(
        db,
        "SELECT COUNT(*) AS n FROM registrations r JOIN match_days md ON md.id = r.match_day_id WHERE r.status = 'pending' AND md.status IN ('draft', 'checkin_open', 'locked')",
      ))?.n ?? 0)
    : undefined;

  const announcements = await latestAnnouncements(db, 3);
  const cancelled = await all<{ id: string; date: string; cancel_reason: string | null }>(
    db,
    "SELECT id, date, cancel_reason FROM match_days WHERE status = 'cancelled' AND date >= ? ORDER BY date LIMIT 3",
    today,
  );
  const mePlayer = await first<{ id: string }>(db, "SELECT id FROM players WHERE user_id = ?", c.get("user")!.id);
  const myStanding = mePlayer && tables ? tables.table.find((r) => r.playerId === mePlayer.id) ?? null : null;
  const openPolls = await openPollsForMe(c);
  const pendingTransfers = isAdmin(c) ? ((await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM payments WHERE status = 'submitted'"))?.n ?? 0) : undefined;
  const pendingApprovals = isAdmin(c) ? ((await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM players WHERE approved = 0"))?.n ?? 0) : undefined;
  return c.json({
    announcements,
    cancelled: cancelled.map((x) => ({ id: x.id, date: x.date, reason: x.cancel_reason })),
    myStanding,
    openPolls,
    pendingTransfers,
    pendingApprovals,
    season: season ? { id: season.id, name: season.name, startDate: season.start_date, endDate: season.end_date } : null,
    nextDay,
    recent: recentRows.map((r) => ({ id: r.id, date: r.date, venue: r.venue, matches: r.matches, winners: JSON.parse(r.winners ?? "[]") })),
    leaders: tables ? { table: tables.table.slice(0, 5), topScorers: tables.goals.slice(0, 3), topAssists: tables.assists.slice(0, 3) } : null,
    pendingGuests,
  });
});

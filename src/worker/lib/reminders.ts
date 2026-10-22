import { addDays, isLateCheckIn } from "../../shared/rules";
import { utcToZoned, zonedToUtcIso } from "../../shared/time";
import type { Bindings } from "../env";
import { all, first, getSetting, newId } from "./db";
import { escapeHtml, sendEmail } from "./email";
import { emailButton, emailLayout } from "./email-layout";

/** Reminders go out on match day, this long before kick-off (the reminder cron runs every 15 minutes). */
export const REMINDER_LEAD_MS = 2 * 3600_000;

type ReminderEnv = Pick<Bindings, "DB" | "EMAIL_FROM" | "RESEND_API_KEY" | "BETTER_AUTH_URL">;

interface DayRow {
  id: string;
  date: string;
  kickoff_time: string;
  venue: string;
  checkin_deadline: string;
  timezone: string;
}

/**
 * Email active players who haven't responded (no registration of any status) to a match day that
 * kicks off within the next 2 hours, while check-in is open (late check-ins are allowed past the deadline). Each player is reminded at most once
 * per day; a failed send is retried by the next run. Pass `dayId` to remind for one open day right now.
 */
export async function sendCheckinReminders(env: ReminderEnv, opts: { now?: Date; dayId?: string } = {}) {
  const db = env.DB;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const result = { days: 0, sent: 0, failed: 0, skipped: null as string | null };
  if (!opts.dayId && (await getSetting(db, "checkin_reminders_enabled", "1")) !== "1") {
    result.skipped = "disabled";
    return result;
  }
  // Candidate dates span ±1 day of UTC "today" so any timezone is covered; the exact window is checked below.
  const utcToday = nowIso.slice(0, 10);
  const days = (
    await all<DayRow>(
      db,
      `SELECT md.id, md.date, md.kickoff_time, md.venue, md.checkin_deadline, s.timezone
         FROM match_days md JOIN seasons s ON s.id = md.season_id
        WHERE md.status = 'checkin_open'
          AND (?1 IS NULL AND md.date BETWEEN ?2 AND ?3 OR md.id = ?1)
        ORDER BY md.date`,
      opts.dayId ?? null,
      addDays(utcToday, -1),
      addDays(utcToday, 1),
    )
  ).filter((d) => {
    if (opts.dayId) return true;
    const kickoff = Date.parse(zonedToUtcIso(d.date, d.kickoff_time, d.timezone));
    return now.getTime() >= kickoff - REMINDER_LEAD_MS && now.getTime() < kickoff;
  });
  result.days = days.length;
  if (!days.length) return result;
  const groupName = await getSetting(db, "group_name", "Matchday");
  const origin = (env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");

  for (const day of days) {
    // Claim recipients atomically: a new row, or a retry of an earlier failure. Concurrent runs can't both claim.
    const claims = await all<{ id: string; player_id: string }>(
      db,
      `INSERT INTO email_log (id, match_day_id, player_id, kind, status, created_at)
       SELECT lower(hex(randomblob(16))), ?1, p.id, 'checkin_reminder', 'sending', ?2
         FROM players p JOIN user u ON u.id = p.user_id
        WHERE p.active = 1 AND p.approved = 1 AND p.email_reminders = 1
          AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.match_day_id = ?1 AND r.player_id = p.id)
       ON CONFLICT (match_day_id, player_id, kind) DO UPDATE SET status = 'sending', error = NULL, created_at = excluded.created_at
         WHERE email_log.status = 'failed'
       RETURNING id, player_id`,
      day.id,
      nowIso,
    );
    if (!claims.length) continue;
    const contacts = new Map(
      (
        await all<{ id: string; display_name: string; email: string }>(
          db,
          `SELECT p.id, p.display_name, u.email FROM players p JOIN user u ON u.id = p.user_id
            WHERE p.id IN (SELECT player_id FROM email_log WHERE match_day_id = ? AND kind = 'checkin_reminder' AND status = 'sending')`,
          day.id,
        )
      ).map((p) => [p.id, p]),
    );
    for (const claim of claims) {
      const p = contacts.get(claim.player_id)!;
      const sent = await sendEmail(env, reminderEmail(p.email, p.display_name, day, groupName, origin, now));
      if (sent.ok) result.sent++;
      else {
        result.failed++;
        console.error("checkin reminder failed", claim.player_id, sent.provider, sent.error);
      }
      await db
        .prepare("UPDATE email_log SET status = ?, provider = ?, error = ? WHERE id = ?")
        .bind(sent.ok ? "sent" : "failed", sent.provider, sent.ok ? null : sent.error.slice(0, 500), claim.id)
        .run();
    }
  }
  if (result.sent || result.failed) {
    await db
      .prepare(`INSERT INTO audit_log (id, actor_name, action, entity_type, entity_id, after_json, created_at) VALUES (?, 'schedule', 'email.checkin_reminders', 'match_day', ?, ?, ?)`)
      .bind(newId(), days.map((d) => d.id).join(","), JSON.stringify(result), nowIso)
      .run();
  }
  return result;
}

/**
 * The reminder exactly as a player would get it, addressed to `to`, for the next upcoming match day
 * (or a sample one when none is scheduled). Used by Admin → Schedule to preview and test-send.
 */
export async function previewReminder(env: Pick<Bindings, "DB" | "BETTER_AUTH_URL">, to: { name: string; email: string }, now = new Date()) {
  const db = env.DB;
  const day =
    (await first<DayRow>(
      db,
      `SELECT md.id, md.date, md.kickoff_time, md.venue, md.checkin_deadline, s.timezone
         FROM match_days md JOIN seasons s ON s.id = md.season_id
        WHERE md.status IN ('draft', 'checkin_open', 'locked') AND md.date >= ?
        ORDER BY md.date LIMIT 1`,
      now.toISOString().slice(0, 10),
    )) ?? (await sampleDay(db, now));
  const origin = (env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
  // Render as of the moment it would really go out: 2 hours before kick-off.
  const sendAt = new Date(Date.parse(zonedToUtcIso(day.date, day.kickoff_time, day.timezone)) - REMINDER_LEAD_MS);
  return { matchDayDate: day.id ? day.date : null, ...reminderEmail(to.email, to.name, day, await getSetting(db, "group_name", "Matchday"), origin, sendAt) };
}

/** Made-up day from the schedule settings, for previews when nothing is scheduled (empty id → links to /matchdays). */
async function sampleDay(db: D1Database, now: Date): Promise<DayRow> {
  const timezone = await getSetting(db, "timezone", "Africa/Lagos");
  const date = now.toISOString().slice(0, 10);
  const kickoff_time = await getSetting(db, "schedule_kickoff", "20:00");
  const closeHours = Number(await getSetting(db, "schedule_close_hours_before", "1"));
  const checkin_deadline = new Date(Date.parse(zonedToUtcIso(date, kickoff_time, timezone)) - closeHours * 3600_000).toISOString();
  return { id: "", date, kickoff_time, venue: await getSetting(db, "default_venue", ""), checkin_deadline, timezone };
}

function reminderEmail(to: string, name: string, day: DayRow, groupName: string, origin: string, sendAt: Date) {
  const dateLabel = new Date(`${day.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const deadline = utcToZoned(day.checkin_deadline, day.timezone);
  const deadlineLabel = `${deadline.time}${deadline.date !== day.date ? ` on ${new Date(`${deadline.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}` : ""}`;
  const deadlinePassed = isLateCheckIn(day.checkin_deadline, sendAt);
  const link = day.id ? `${origin}/matchdays/${day.id}` : `${origin}/matchdays`;
  const where = day.venue ? ` at ${day.venue}` : "";
  const first = name.split(/\s+/)[0] || name;
  const subject = `Kick-off ${day.kickoff_time} ${dateLabel} — you haven't checked in`;
  const text = [
    `Hi ${first},`,
    "",
    `You haven't checked in for ${groupName} today, ${dateLabel} (kick-off ${day.kickoff_time}${where}).`,
    deadlinePassed ? "The check-in deadline has passed, but you can still check in (it'll be marked late):" : `Check-in closes at ${deadlineLabel}. Check in or mark yourself unavailable here:`,
    link,
    "",
    `Don't want these reminders? Turn them off on your profile: ${origin}/me`,
  ].join("\n");
  const muted = "color:rgba(6,32,16,0.6)";
  const html = emailLayout({
    title: subject,
    preheader: `Kick-off ${day.kickoff_time}${where}. ${deadlinePassed ? "You can still check in (late)." : `Check-in closes at ${deadlineLabel}.`}`,
    brand: groupName,
    brandUrl: origin || "#",
    bodyHtml: `<p style="margin:0 0 13px;">Hi ${escapeHtml(first)},</p>
<p>You haven't checked in for <b>${escapeHtml(groupName)}</b> today, <b>${escapeHtml(dateLabel)}</b> (kick-off ${escapeHtml(day.kickoff_time)}${escapeHtml(where)}).</p>
<p>${deadlinePassed ? "The check-in deadline has passed, but you can still check in. It'll be marked late." : `Check-in closes at <b>${escapeHtml(deadlineLabel)}</b>.`}</p>
${emailButton(link, "Check in")}
<p style="margin:13px 0 0;font-size:13px;${muted};">Can't make it? Tap “Can't make it” on the same page so the admins know.</p>`,
    footerHtml: `You're receiving this because you play with <a href="${escapeHtml(origin || "#")}" style="${muted};font-weight:500;">${escapeHtml(groupName)}</a> on Matchday.<br>
<a href="${escapeHtml(origin)}/me" style="${muted};">Turn off reminders</a> &nbsp;·&nbsp; <a href="${escapeHtml(link)}" style="${muted};">Open match day</a><br>
© ${sendAt.getUTCFullYear()} ${escapeHtml(groupName)}`,
  });
  return { to, subject, html, text };
}

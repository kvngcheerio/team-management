import { addDays, DEFAULT_TEAM_SHEET_TIME, isDateInSeason, parseWeekdays, scheduledDates } from "../../shared/rules";
import { todayInZone, zonedToUtcIso } from "../../shared/time";
import { randomToken } from "./crypto";
import { all, getSetting, newId, stmt } from "./db";

/**
 * Create upcoming match days on the scheduled weekdays and open check-in when it's time.
 * Runs daily from the cron trigger and on demand from Admin → Schedule. Idempotent: a date that
 * already has a match day (including a cancelled one) is never recreated.
 */
export async function runSchedule(db: D1Database, now = new Date()) {
  const s = async (k: string, d: string) => getSetting(db, k, d);
  const weekdays = parseWeekdays(await s("match_weekdays", ""));
  const result = { created: [] as string[], opened: [] as string[] };
  const tz = await s("timezone", "Africa/Lagos");
  const today = todayInZone(tz, now);
  const openDays = Number(await s("schedule_open_days_before", "3"));
  const nowIso = now.toISOString();

  if (weekdays.length > 0) {
    const [kickoff, closeHours, weeks, capacity, teamSize, setCount, venue, sheetTime] = await Promise.all([
      s("schedule_kickoff", "07:00"),
      s("schedule_close_hours_before", "11"),
      s("schedule_weeks_ahead", "2"),
      s("default_capacity", "20"),
      s("default_team_size", "5"),
      s("default_set_count", "4"),
      s("default_venue", ""),
      s("team_sheet_time", DEFAULT_TEAM_SHEET_TIME),
    ]);
    const seasons = await all<{ id: string; start_date: string; end_date: string; timezone: string }>(db, "SELECT id, start_date, end_date, timezone FROM seasons WHERE status = 'active'");
    const statements: D1PreparedStatement[] = [];
    for (const date of scheduledDates(today, Math.max(1, Number(weeks)) * 7, weekdays)) {
      const season = seasons.find((x) => isDateInSeason(date, { startDate: x.start_date, endDate: x.end_date }));
      if (!season) continue;
      const kickoffUtc = zonedToUtcIso(date, kickoff, season.timezone);
      const deadline = new Date(Date.parse(kickoffUtc) - Number(closeHours) * 3600_000).toISOString();
      if (deadline <= nowIso) continue; // too late to open check-in for this one
      const status = date <= addDays(today, openDays) ? "checkin_open" : "draft";
      const id = newId();
      statements.push(
        stmt(
          db,
          `INSERT INTO match_days (id, season_id, date, kickoff_time, venue, capacity, checkin_deadline, team_size, set_count, status, tie_policy, public_token, notes, team_sheet_at, auto_created, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shared', ?, '', ?, 1, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM match_days WHERE date = ?)`,
          id,
          season.id,
          date,
          kickoff,
          venue,
          Number(capacity),
          deadline,
          Number(teamSize),
          Number(setCount),
          status,
          randomToken(12),
          zonedToUtcIso(date, sheetTime, season.timezone),
          nowIso,
          nowIso,
          date,
        ),
      );
    }
    if (statements.length) {
      await db.batch(statements);
      // Re-read which dates this run actually created (a concurrent run may have beaten us to some).
      const created = await all<{ date: string }>(db, "SELECT date FROM match_days WHERE auto_created = 1 AND created_at = ? ORDER BY date", nowIso);
      result.created = created.map((r) => r.date);
    }
  }

  // Open check-in on scheduled drafts whose opening day has arrived.
  const opened = await all<{ id: string; date: string }>(
    db,
    `UPDATE match_days SET status = 'checkin_open', version = version + 1, updated_at = ?
      WHERE auto_created = 1 AND status = 'draft' AND date <= ? AND checkin_deadline > ?
      RETURNING id, date`,
    nowIso,
    addDays(today, openDays),
    nowIso,
  );
  result.opened = opened.map((o) => o.date);

  if (result.created.length || result.opened.length) {
    await db
      .prepare(`INSERT INTO audit_log (id, actor_name, action, entity_type, entity_id, after_json, created_at) VALUES (?, 'schedule', 'schedule.run', 'schedule', 'weekly', ?, ?)`)
      .bind(newId(), JSON.stringify(result), nowIso)
      .run();
  }
  return result;
}

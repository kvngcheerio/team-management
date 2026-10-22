import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { sendCheckinReminders } from "../src/worker/lib/reminders";
import { Client, createMatchDay, createPlayer, createSeason, setupAdmin } from "./helpers";

let admin: Client;
let seasonId: string;
const players: { playerId: string; client: Client }[] = [];

// Kick-off 07:30 Africa/Lagos = 06:30Z, so reminders go out from 04:30Z. Check-in stays open until kick-off.
const OPEN_UNTIL_KICKOFF = { checkinDeadlineTime: "07:30" };
const TWO_HOURS_BEFORE = new Date("2026-11-07T04:45:00Z");

function fakeMailer(fail = false) {
  const sent: { to: string; subject: string; html: string; text: string; from: string }[] = [];
  const EMAIL = {
    async send(msg: any) {
      if (fail) throw Object.assign(new Error("Sender domain not verified"), { code: "E_SENDER_NOT_VERIFIED" });
      sent.push(msg);
      return { messageId: String(sent.length) };
    },
  } as unknown as SendEmail;
  return { sent, env: { DB: env.DB, EMAIL, EMAIL_FROM: "Matchday <noreply@example.com>", BETTER_AUTH_URL: "https://game.example.com" } };
}

beforeAll(async () => {
  ({ admin } = await setupAdmin());
  seasonId = (await createSeason(admin)).id;
  for (let i = 0; i < 4; i++) {
    const p = await createPlayer(admin, `Player ${i + 1}`, { login: true });
    players.push({ playerId: p.playerId, client: p.client! });
  }
  await createPlayer(admin, "No Login"); // no account → no email address → never emailed
});

describe("check-in reminder emails", () => {
  let dayId: string;

  it("emails only players who haven't responded, once", async () => {
    dayId = (await createMatchDay(admin, seasonId, { checkinDeadlineDate: "2026-11-07", ...OPEN_UNTIL_KICKOFF })).day.id;
    await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
    expect((await players[0]!.client.post(`/matchdays/${dayId}/checkin`)).status).toBe(200);
    expect((await players[1]!.client.post(`/matchdays/${dayId}/unavailable`)).status).toBe(200);
    expect((await players[2]!.client.patch("/me/player", { emailReminders: false })).status).toBe(200);
    expect((await players[2]!.client.get("/me")).body.player.emailReminders).toBe(false);

    // Too early (more than 2h before kick-off), the day before, and after kick-off: nothing.
    const early = fakeMailer();
    for (const t of ["2026-11-07T04:15:00Z", "2026-11-06T05:00:00Z", "2026-11-07T06:30:00Z"]) {
      expect(await sendCheckinReminders(early.env, { now: new Date(t) })).toMatchObject({ days: 0, sent: 0 });
    }

    const m = fakeMailer();
    const r = await sendCheckinReminders(m.env, { now: TWO_HOURS_BEFORE });
    expect(r).toMatchObject({ days: 1, sent: 2, failed: 0 }); // player 4 + the admin (also a player)
    const p4email = (await players[3]!.client.get("/me")).body.user.email;
    expect(m.sent.map((e) => e.to).sort()).toEqual(["admin@example.com", p4email].sort());
    const mail = m.sent.find((e) => e.to === p4email)!;
    expect(mail.from).toBe("Matchday <noreply@example.com>");
    expect(mail.subject).toContain("Saturday 7 November");
    expect(mail.subject).toContain("Kick-off 07:30");
    expect(mail.text).toContain("today, Saturday 7 November");
    expect(mail.html).toContain(`https://game.example.com/matchdays/${dayId}`);
    expect(mail.text).toContain("Hi Player");

    // The next run (or a concurrent one) doesn't re-send.
    const again = fakeMailer();
    expect(await sendCheckinReminders(again.env, { now: new Date("2026-11-07T05:00:00Z") })).toMatchObject({ sent: 0 });
    expect(again.sent).toHaveLength(0);
  });

  it("records failures and retries them on the next run", async () => {
    const day = (await createMatchDay(admin, seasonId, { date: "2026-11-14", checkinDeadlineDate: "2026-11-14", ...OPEN_UNTIL_KICKOFF })).day.id;
    await admin.post(`/matchdays/${day}/transition`, { to: "checkin_open" });
    const now = new Date("2026-11-14T05:00:00Z");
    const broken = fakeMailer(true);
    expect(await sendCheckinReminders(broken.env, { now })).toMatchObject({ sent: 0, failed: 4 });
    const failed = await env.DB.prepare("SELECT status, provider, error FROM email_log WHERE match_day_id = ?").bind(day).all<{ status: string; provider: string; error: string }>();
    expect(failed.results.every((r) => r.status === "failed" && r.error.includes("E_SENDER_NOT_VERIFIED"))).toBe(true);

    const fixed = fakeMailer();
    expect(await sendCheckinReminders(fixed.env, { now })).toMatchObject({ sent: 4, failed: 0 });
  });

  it("does nothing when reminders are turned off, or when no provider is configured", async () => {
    const day = (await createMatchDay(admin, seasonId, { date: "2026-11-21", checkinDeadlineDate: "2026-11-21", ...OPEN_UNTIL_KICKOFF })).day.id;
    await admin.post(`/matchdays/${day}/transition`, { to: "checkin_open" });
    const now = new Date("2026-11-21T05:00:00Z");
    expect((await admin.put("/admin/settings", { checkin_reminders_enabled: "0" })).status).toBe(200);
    const m = fakeMailer();
    expect(await sendCheckinReminders(m.env, { now })).toMatchObject({ skipped: "disabled", sent: 0 });
    await admin.put("/admin/settings", { checkin_reminders_enabled: "1" });

    const r = await sendCheckinReminders({ DB: env.DB, EMAIL_FROM: "x@example.com" }, { now });
    expect(r).toMatchObject({ sent: 0, failed: 4 });
  });

  it("still reminds after the (soft) deadline, but not once an admin closes check-in", async () => {
    // Deadline the evening before: late check-in is still allowed, so the reminder is still useful.
    const day = (await createMatchDay(admin, seasonId, { date: "2026-12-05", checkinDeadlineDate: "2026-12-04" })).day.id;
    await admin.post(`/matchdays/${day}/transition`, { to: "checkin_open" });
    const m = fakeMailer();
    expect(await sendCheckinReminders(m.env, { now: new Date("2026-12-05T05:00:00Z") })).toMatchObject({ days: 1, sent: 4 });

    const closed = (await createMatchDay(admin, seasonId, { date: "2026-12-12", checkinDeadlineDate: "2026-12-11" })).day.id;
    await admin.post(`/matchdays/${closed}/transition`, { to: "checkin_open" });
    await admin.post(`/matchdays/${closed}/transition`, { to: "locked" });
    expect(await sendCheckinReminders(fakeMailer().env, { now: new Date("2026-12-12T05:00:00Z") })).toMatchObject({ days: 0, sent: 0 });
  });

  it("lets admins send reminders for an open day through the real binding", async () => {
    const day = (await createMatchDay(admin, seasonId, { date: "2026-11-28", checkinDeadlineDate: "2026-11-27" })).day.id;
    expect((await admin.post(`/admin/matchdays/${day}/reminders`)).status).toBe(409); // still draft
    await admin.post(`/matchdays/${day}/transition`, { to: "checkin_open" });
    expect((await players[0]!.client.post(`/admin/matchdays/${day}/reminders`)).status).toBe(403);
    const res = await admin.post(`/admin/matchdays/${day}/reminders`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 1, failed: 0, sent: 4 });
    expect((await admin.post(`/admin/matchdays/${day}/reminders`)).body).toMatchObject({ sent: 0 });
  });

  it("previews the reminder for admins only, worded as at send time", async () => {
    expect((await players[0]!.client.get("/admin/email-preview")).status).toBe(403);
    const res = await admin.get("/admin/email-preview");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ to: "admin@example.com", subject: expect.stringContaining("you haven't checked in") });
    expect(res.body.html).toContain("Check in</a>");
  });

  it("tells players they can still check in late once the deadline has passed", async () => {
    // Deadline the evening before; reminder 2h before kick-off.
    const day = (await createMatchDay(admin, seasonId, { date: "2026-12-19", checkinDeadlineDate: "2026-12-18" })).day.id;
    await admin.post(`/matchdays/${day}/transition`, { to: "checkin_open" });
    const m = fakeMailer();
    await sendCheckinReminders(m.env, { now: new Date("2026-12-19T05:00:00Z") });
    expect(m.sent[0]!.text).toContain("you can still check in");
    expect(m.sent[0]!.text).not.toContain("Check-in closes at");
  });
});


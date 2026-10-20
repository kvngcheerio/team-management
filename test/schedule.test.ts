import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createPlayer, setupAdmin } from "./helpers";
import { addDays, isoWeekday } from "../src/shared/rules";
import { todayInZone } from "../src/shared/time";

let admin: Client;
const today = todayInZone("Africa/Lagos");

beforeAll(async () => {
  ({ admin } = await setupAdmin());
  await admin.post("/seasons", { name: "Now", startDate: addDays(today, -10) });
});

describe("weekly schedule", () => {
  it("does nothing until weekdays are chosen", async () => {
    expect((await admin.post("/admin/schedule/run", {})).body).toEqual({ created: [], opened: [] });
  });

  it("creates match days on the chosen weekdays and opens check-in when due", async () => {
    // Play on the weekday 2 days from now, and the one 5 days from now.
    const d1 = addDays(today, 2);
    const d2 = addDays(today, 5);
    const weekdays = [...new Set([isoWeekday(d1), isoWeekday(d2)])].sort().join(",");
    expect((await admin.put("/admin/settings", { match_weekdays: weekdays, schedule_open_days_before: 3, schedule_weeks_ahead: 1, schedule_kickoff: "08:00" })).status).toBe(200);
    const run = (await admin.post("/admin/schedule/run", {})).body;
    expect(run.created).toEqual(expect.arrayContaining([d1, d2]));
    const days = (await admin.get("/matchdays")).body.matchDays;
    const day1 = days.find((d: any) => d.date === d1);
    const day2 = days.find((d: any) => d.date === d2);
    expect(day1).toMatchObject({ status: "checkin_open", kickoffTime: "08:00" }); // within 3 days
    expect(day2).toMatchObject({ status: "draft" }); // opens later
    // Running again (or the cron firing) never duplicates.
    expect((await admin.post("/admin/schedule/run", {})).body.created).toEqual([]);
    expect(days.filter((d: any) => d.date === d1)).toHaveLength(1);
  });

  it("opens check-in on scheduled drafts once their opening day arrives", async () => {
    await admin.put("/admin/settings", { schedule_open_days_before: 7 });
    const run = (await admin.post("/admin/schedule/run", {})).body;
    expect(run.opened).toContain(addDays(today, 5));
  });

  it("the cron handler runs the same schedule", async () => {
    const { default: worker } = await import("../src/worker/index");
    await worker.scheduled({ cron: "0 5 * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, env as never, {
      waitUntil: async (p: Promise<unknown>) => p,
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM match_days WHERE auto_created = 1").first<number>("n");
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it("members can't change the schedule", async () => {
    const m = await createPlayer(admin, "Sched Member", { login: true });
    expect((await m.client!.post("/admin/schedule/run", {})).status).toBe(403);
    expect((await m.client!.put("/admin/settings", { match_weekdays: "1" })).status).toBe(403);
  });
});

describe("cancelling a match day", () => {
  it("requires a reason, shows it to players, and posts a pinned announcement", async () => {
    const day = (await admin.get("/matchdays")).body.matchDays.find((d: any) => d.status === "checkin_open");
    const m = await createPlayer(admin, "Notified Member", { login: true });
    expect((await admin.post(`/matchdays/${day.id}/transition`, { to: "cancelled" })).status).toBe(422);
    const res = await admin.post(`/matchdays/${day.id}/transition`, { to: "cancelled", reason: "Pitch is flooded" });
    expect(res.body.day).toMatchObject({ status: "cancelled", cancelReason: "Pitch is flooded" });
    const dash = (await m.client!.get("/dashboard")).body;
    expect(dash.cancelled[0]).toMatchObject({ id: day.id, reason: "Pitch is flooded" });
    expect(dash.announcements[0]).toMatchObject({ pinned: true, body: expect.stringContaining("Pitch is flooded") });
    // The schedule never recreates a cancelled date.
    expect((await admin.post("/admin/schedule/run", {})).body.created).not.toContain(day.date);
  });
});

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createMatchDay, createPlayer, createSeason, setupAdmin } from "./helpers";

let admin: Client;
let seasonId: string;
const members: { playerId: string; client: Client }[] = [];

beforeAll(async () => {
  ({ admin } = await setupAdmin());
  seasonId = (await createSeason(admin)).id;
  for (let i = 0; i < 16; i++) {
    const p = await createPlayer(admin, `Player ${i + 1}`, { login: true });
    members.push({ playerId: p.playerId, client: p.client! });
  }
});

const counts = async (dayId: string) =>
  Object.fromEntries(
    (await env.DB.prepare("SELECT status, COUNT(*) AS n FROM registrations WHERE match_day_id = ? GROUP BY status").bind(dayId).all<{ status: string; n: number }>()).results.map(
      (r) => [r.status, r.n],
    ),
  );

describe("registration capacity", () => {
  it("never overbooks under concurrent check-ins", async () => {
    const day = await createMatchDay(admin, seasonId, { capacity: 10 });
    const dayId = day.day.id;
    await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
    const results = await Promise.all(members.map((m) => m.client.post(`/matchdays/${dayId}/checkin`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await counts(dayId)).toEqual({ confirmed: 10, waitlist: 6 });
  });

  it("dedupes concurrent duplicate check-ins from the same player", async () => {
    const day = await createMatchDay(admin, seasonId, { capacity: 10, date: "2026-11-14", checkinDeadlineDate: "2026-11-13" });
    const dayId = day.day.id;
    await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
    const m = members[0]!;
    const results = await Promise.all(Array.from({ length: 8 }, () => m.client.post(`/matchdays/${dayId}/checkin`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await counts(dayId)).toEqual({ confirmed: 1 });
  });

  it("uses a waiting list with explicit promotion when a place opens", async () => {
    const day = await createMatchDay(admin, seasonId, { capacity: 2, date: "2026-11-21", checkinDeadlineDate: "2026-11-20" });
    const dayId = day.day.id;
    await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
    for (const m of members.slice(0, 4)) await m.client.post(`/matchdays/${dayId}/checkin`);
    let d = (await admin.get(`/matchdays/${dayId}`)).body;
    expect(d.counts).toMatchObject({ confirmed: 2, waitlist: 2 });
    const firstWaiting = d.registrations.find((r: any) => r.waitlistPosition === 1);
    expect(firstWaiting.playerId).toBe(members[2]!.playerId);

    // Full: promotion is refused.
    expect((await admin.post(`/registrations/${firstWaiting.id}/promote`)).status).toBe(409);

    // A confirmed player withdraws: nobody is auto-promoted…
    const w = await members[0]!.client.post(`/matchdays/${dayId}/withdraw`);
    expect(w.body.me.registrationStatus).toBe("withdrawn");
    d = (await admin.get(`/matchdays/${dayId}`)).body;
    expect(d.counts).toMatchObject({ confirmed: 1, waitlist: 2 });
    // …until the admin promotes explicitly.
    const p = await admin.post(`/registrations/${firstWaiting.id}/promote`);
    expect(p.status).toBe(200);
    expect(p.body.counts).toMatchObject({ confirmed: 2, waitlist: 1 });

    // Re-checking in after withdrawing goes to the back of the queue.
    const back = await members[0]!.client.post(`/matchdays/${dayId}/checkin`);
    expect(back.body.me.registrationStatus).toBe("waitlist");

    // Capacity can't be lowered below the confirmed count.
    const bigger = await admin.patch(`/matchdays/${dayId}`, { capacity: 3 });
    expect(bigger.status).toBe(200);
    const waiting = bigger.body.registrations.find((r: any) => r.waitlistPosition === 1);
    expect((await admin.post(`/registrations/${waiting.id}/promote`)).body.counts.confirmed).toBe(3);
    expect((await admin.patch(`/matchdays/${dayId}`, { capacity: 2 })).status).toBe(409);
  });

  it("refuses check-in when closed or past the deadline", async () => {
    const day = await createMatchDay(admin, seasonId, { date: "2026-11-28", checkinDeadlineDate: "2026-11-27" });
    expect((await members[0]!.client.post(`/matchdays/${day.day.id}/checkin`)).status).toBe(409);
    // Deadline in the past (Oct 1 2026 is before "today" in tests).
    const past = await createMatchDay(admin, seasonId, { date: "2026-10-10", checkinDeadlineDate: "2026-10-09" });
    await admin.post(`/matchdays/${past.day.id}/transition`, { to: "checkin_open" });
    expect((await members[0]!.client.post(`/matchdays/${past.day.id}/checkin`)).status).toBe(409);
  });

  it("rejects match days outside the season and deadlines after kickoff", async () => {
    expect((await admin.post("/matchdays", { seasonId, date: "2027-04-01", kickoffTime: "08:00", capacity: 10, checkinDeadlineDate: "2027-03-31", checkinDeadlineTime: "20:00", teamSize: 5, setCount: 2 })).status).toBe(422);
    expect((await admin.post("/matchdays", { seasonId, date: "2026-12-05", kickoffTime: "08:00", capacity: 10, checkinDeadlineDate: "2026-12-05", checkinDeadlineTime: "09:00", teamSize: 5, setCount: 2 })).status).toBe(422);
  });
});

describe("guest registration", () => {
  let token: string;
  let dayId: string;
  beforeAll(async () => {
    const day = await createMatchDay(admin, seasonId, { capacity: 3, date: "2026-12-12", checkinDeadlineDate: "2026-12-11" });
    dayId = day.day.id;
    token = day.day.guestLink.split("/g/")[1];
    await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
  });

  it("silently drops honeypot and too-fast submissions", async () => {
    const c = new Client();
    expect((await c.post(`/public/matchdays/${token}/guests`, { name: "Bot", website: "http://spam", elapsedMs: 9000 })).body.status).toBe("pending");
    expect((await c.post(`/public/matchdays/${token}/guests`, { name: "Fast Bot", elapsedMs: 100 })).body.status).toBe("pending");
    expect(await counts(dayId)).toEqual({});
  });

  it("rate-limits the public form per client", async () => {
    const c = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await c.post(`/public/matchdays/${token}/guests`, { name: `Spammy ${i}`, elapsedMs: 5000 })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("supports approve, reject and admin-added guests, with capacity", async () => {
    for (const name of ["Guest One", "Guest Two"]) {
      expect((await new Client().post(`/public/matchdays/${token}/guests`, { name, elapsedMs: 5000 })).status).toBe(200);
    }
    // Duplicate name for the same day is refused.
    expect((await new Client().post(`/public/matchdays/${token}/guests`, { name: "guest one", elapsedMs: 5000 })).status).toBe(409);
    let d = (await admin.get(`/matchdays/${dayId}`)).body;
    const g1 = d.registrations.find((r: any) => r.displayName === "Guest One");
    const g2 = d.registrations.find((r: any) => r.displayName === "Guest Two");
    expect(g1.kind).toBe("guest");
    expect((await admin.post(`/registrations/${g2.id}/reject`)).body.registrations.find((r: any) => r.id === g2.id).status).toBe("rejected");
    // Clean slate for capacity: remove the rate-limit test's pending spam.
    for (const r of d.registrations.filter((r: any) => r.displayName.startsWith("Spammy"))) await admin.post(`/registrations/${r.id}/reject`);
    expect((await admin.post(`/registrations/${g1.id}/approve`)).body.counts.confirmed).toBe(1);

    const manual = await createPlayer(admin, "Walk-in Guest", { kind: "guest" });
    d = (await admin.post(`/matchdays/${dayId}/registrations`, { playerId: manual.playerId })).body;
    expect(d.registrations.find((r: any) => r.playerId === manual.playerId).status).toBe("confirmed");
    await members[0]!.client.post(`/matchdays/${dayId}/checkin`);
    // Capacity 3 reached; next approval goes to the waiting list.
    const late = await createPlayer(admin, "Late Guest", { kind: "guest" });
    d = (await admin.post(`/matchdays/${dayId}/registrations`, { playerId: late.playerId })).body;
    expect(d.registrations.find((r: any) => r.playerId === late.playerId).status).toBe("waitlist");
    // Admin withdrawal of a guest.
    const lateReg = d.registrations.find((r: any) => r.playerId === late.playerId);
    expect((await admin.post(`/registrations/${lateReg.id}/withdraw`)).status).toBe(200);
  });

  it("closes the public form once check-in is locked", async () => {
    await admin.post(`/matchdays/${dayId}/transition`, { to: "locked" });
    expect((await new Client().get(`/public/matchdays/${token}`)).body.open).toBe(false);
    expect((await new Client().post(`/public/matchdays/${token}/guests`, { name: "Too Late", elapsedMs: 5000 })).status).toBe(409);
  });
});

describe("cancellation", () => {
  it("cancelled days award no points and can't be finalized", async () => {
    const day = await createMatchDay(admin, seasonId, { date: "2026-12-19", checkinDeadlineDate: "2026-12-18" });
    expect((await admin.post(`/matchdays/${day.day.id}/transition`, { to: "cancelled" })).status).toBe(422);
    const res = await admin.post(`/matchdays/${day.day.id}/transition`, { to: "cancelled", reason: "Pitch waterlogged" });
    expect(res.body.day.status).toBe("cancelled");
    expect((await admin.post(`/matchdays/${day.day.id}/finalize`)).status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM day_player_stats WHERE match_day_id = ?").bind(day.day.id).first("n")).toBe(0);
  });
});

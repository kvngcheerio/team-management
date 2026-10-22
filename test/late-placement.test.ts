import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { chooseSetForLatePlayer } from "../src/shared/rules";
import { Client, createMatchDay, createPlayer, createSeason, setupAdmin } from "./helpers";

let admin: Client;
let dayId: string;
const late: { playerId: string; client: Client }[] = [];

const rosterOf = async (playerId: string) =>
  env.DB.prepare("SELECT s.idx, r.role FROM roster_entries r JOIN sets s ON s.id = r.set_id WHERE r.match_day_id = ? AND r.player_id = ?")
    .bind(dayId, playerId)
    .first<{ idx: number; role: string }>();

// 2 sets of 3-a-side published with 3 and 2 players, then more people check in.
beforeAll(async () => {
  ({ admin } = await setupAdmin("Ada Admin"));
  const seasonId = (await createSeason(admin)).id;
  dayId = (await createMatchDay(admin, seasonId, { capacity: 9, teamSize: 3, setCount: 2 })).day.id;
  await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
  const early: string[] = [];
  for (let i = 0; i < 5; i++) {
    const p = await createPlayer(admin, `Early ${i}`, { login: true });
    await p.client!.post(`/matchdays/${dayId}/checkin`);
    early.push(p.playerId);
  }
  for (let i = 0; i < 4; i++) late.push((await createPlayer(admin, `Late ${i}`, { login: true })) as { playerId: string; client: Client });
  const pub = await admin.post(`/matchdays/${dayId}/teams/publish`, {
    sets: [
      { idx: 1, players: early.slice(0, 3).map((playerId) => ({ playerId })) },
      { idx: 2, players: early.slice(3).map((playerId) => ({ playerId })) },
    ],
  });
  expect(pub.status).toBe(200);
});

describe("players confirmed after teams are published", () => {
  it("fill the smallest team as starters, then join as subs once every team is full", async () => {
    await late[0]!.client.post(`/matchdays/${dayId}/checkin`);
    expect(await rosterOf(late[0]!.playerId)).toEqual({ idx: 2, role: "starter" }); // set 2 had room

    // Both sets now have 3 (= team size): the next one is a sub, in the lower-rated / lower-numbered set.
    await late[1]!.client.post(`/matchdays/${dayId}/checkin`);
    expect(await rosterOf(late[1]!.playerId)).toMatchObject({ role: "sub" });
    const detail = (await admin.get(`/matchdays/${dayId}`)).body;
    expect(detail.sets.map((s: any) => s.players.length).sort()).toEqual([3, 4]);
  });

  it("leaves the team on withdrawal and rejoins on check-in", async () => {
    expect((await late[0]!.client.post(`/matchdays/${dayId}/withdraw`)).status).toBe(200);
    expect(await rosterOf(late[0]!.playerId)).toBeNull();
    await late[0]!.client.post(`/matchdays/${dayId}/checkin`);
    expect(await rosterOf(late[0]!.playerId)).not.toBeNull();
  });

  it("places admin-added and promoted players too, but not the waiting list", async () => {
    expect((await admin.post(`/matchdays/${dayId}/registrations`, { playerId: late[2]!.playerId })).status).toBe(200);
    expect(await rosterOf(late[2]!.playerId)).not.toBeNull();

    // 8 confirmed: cap the day at 8 so the next check-in waits.
    expect((await admin.patch(`/matchdays/${dayId}`, { capacity: 8 })).status).toBe(200);
    const wait = await late[3]!.client.post(`/matchdays/${dayId}/checkin`);
    expect(wait.body.me.registrationStatus).toBe("waitlist");
    expect(await rosterOf(late[3]!.playerId)).toBeNull();

    // A place opens up and the admin promotes them: they join a team.
    expect((await admin.patch(`/matchdays/${dayId}`, { capacity: 9 })).status).toBe(200);
    const reg = (await admin.get(`/matchdays/${dayId}`)).body.registrations.find((r: any) => r.playerId === late[3]!.playerId);
    expect((await admin.post(`/registrations/${reg.id}/promote`)).status).toBe(200);
    expect(await rosterOf(late[3]!.playerId)).not.toBeNull();
  });

  it("does nothing once play has started", async () => {
    const fresh = await createPlayer(admin, "Too Late", { login: true });
    expect((await admin.post(`/matchdays/${dayId}/start`)).status).toBe(200);
    expect((await fresh.client!.post(`/matchdays/${dayId}/checkin`)).status).toBe(409); // check-in closed by start
    expect(await rosterOf(fresh.playerId)).toBeNull();
  });
});

describe("guests confirmed by paying after teams are published", () => {
  it("join a team once the fee is paid online or marked paid by an admin", async () => {
    await admin.put("/admin/settings", { payment_mode: "test" });
    const seasonId = (await admin.get("/seasons")).body.seasons[0].id;
    const day = (await createMatchDay(admin, seasonId, { date: "2026-11-14", checkinDeadlineDate: "2026-11-13", capacity: 10, teamSize: 3, setCount: 2 })).day.id;
    await admin.post(`/matchdays/${day}/transition`, { to: "checkin_open" });
    const regulars: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await createPlayer(admin, `Reg ${i}`, { login: true });
      await p.client!.post(`/matchdays/${day}/checkin`);
      regulars.push(p.playerId);
    }
    await admin.post(`/matchdays/${day}/teams/publish`, { sets: [{ idx: 1, players: regulars.slice(0, 2).map((playerId) => ({ playerId })) }, { idx: 2, players: regulars.slice(2).map((playerId) => ({ playerId })) }] });
    const inRoster = (playerId: string) => env.DB.prepare("SELECT 1 AS x FROM roster_entries WHERE match_day_id = ? AND player_id = ?").bind(day, playerId).first();

    const online = await createPlayer(admin, "Online Guest", { login: true, kind: "guest" });
    expect((await online.client!.post(`/matchdays/${day}/checkin`)).body.me.registrationStatus).toBe("pending");
    expect(await inRoster(online.playerId)).toBeNull(); // unpaid: not placed
    const co = await online.client!.post(`/matchdays/${day}/guest-fee/checkout`, {});
    expect((await online.client!.post(`/payments/${co.body.paymentId}/simulate`, { outcome: "success" })).status).toBe(200);
    expect(await inRoster(online.playerId)).not.toBeNull();

    const cash = await createPlayer(admin, "Cash Guest", { login: true, kind: "guest" });
    await cash.client!.post(`/matchdays/${day}/checkin`);
    const reg = (await admin.get(`/matchdays/${day}`)).body.registrations.find((r: any) => r.playerId === cash.playerId);
    expect((await admin.post(`/registrations/${reg.id}/fee/mark-paid`, {})).status).toBe(200);
    expect(await inRoster(cash.playerId)).not.toBeNull();
  });
});

describe("chooseSetForLatePlayer", () => {
  it("prefers a set with room, then the smallest/weakest as a sub, and handles no sets", () => {
    const sets = [
      { setId: "a", idx: 1, size: 3, totalRating: 15 },
      { setId: "b", idx: 2, size: 2, totalRating: 9 },
    ];
    expect(chooseSetForLatePlayer(sets, 3)).toMatchObject({ set: { setId: "b" }, role: "starter" });
    expect(chooseSetForLatePlayer([{ ...sets[0]! }, { ...sets[1]!, size: 3, totalRating: 20 }], 3)).toMatchObject({ set: { setId: "a" }, role: "sub" });
    expect(chooseSetForLatePlayer([], 3)).toBeNull();
  });
});

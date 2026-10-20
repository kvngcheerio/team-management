import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createMatchDay, createPlayer, createSeason, setupAdmin } from "./helpers";

let admin: Client;
let member: Client;
let memberId: string;
let dayId: string;

// 2 sets of 5-a-side with 8 players: 2 guest spots.
beforeAll(async () => {
  ({ admin } = await setupAdmin());
  const seasonId = (await createSeason(admin)).id;
  const day = await createMatchDay(admin, seasonId, { capacity: 12, teamSize: 5, setCount: 2 });
  dayId = day.day.id;
  await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
  for (let i = 0; i < 8; i++) {
    const p = await createPlayer(admin, `Regular ${i}`, { login: true, skillRating: 4 + (i % 4) });
    if (i === 0) {
      member = p.client!;
      memberId = p.playerId;
    }
    await p.client!.post(`/matchdays/${dayId}/checkin`);
  }
  const gen = await admin.post(`/matchdays/${dayId}/teams/generate`, { mode: "balanced", seed: 5 });
  // Make the sets uneven: 5 and 3.
  const all = gen.body.sets.flatMap((s: any) => s.players.map((p: any) => p.playerId));
  await admin.post(`/matchdays/${dayId}/teams/publish`, {
    sets: [
      { idx: 1, players: all.slice(0, 5).map((id: string) => ({ playerId: id })) },
      { idx: 2, players: all.slice(5).map((id: string) => ({ playerId: id })) },
    ],
  });
  await admin.post(`/matchdays/${dayId}/start`);
});

describe("adding guests on the pitch", () => {
  it("shows the guest limit to admins only", async () => {
    expect((await admin.get(`/matchdays/${dayId}`)).body.guestSlots).toBe(2);
    expect((await member.get(`/matchdays/${dayId}`)).body.guestSlots).toBeNull();
  });

  it("auto-assigns a new guest to the team with room, present and ineligible for points", async () => {
    const res = await admin.post(`/matchdays/${dayId}/pitch-guests`, { name: "Walk-in Wale", phone: "+234 803 333 3333" });
    expect(res.status).toBe(201);
    const blue = res.body.sets.find((s: any) => s.idx === 2);
    expect(res.body.added).toMatchObject({ displayName: "Walk-in Wale", setId: blue.id, setName: blue.name });
    const entry = blue.players.find((p: any) => p.displayName === "Walk-in Wale");
    expect(entry).toMatchObject({ kind: "guest", attended: true, memberAtLock: false });
    expect(res.body.guestSlots).toBe(1);
    // Nobody else moved.
    expect(res.body.sets.find((s: any) => s.idx === 1).players).toHaveLength(5);
  });

  it("reuses a previous guest record instead of duplicating it", async () => {
    const prev = await createPlayer(admin, "Returning Ruth", { kind: "guest" });
    const res = await admin.post(`/matchdays/${dayId}/pitch-guests`, { existingPlayerId: prev.playerId });
    expect(res.status).toBe(201);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE display_name = 'Returning Ruth'").first("n")).toBe(1);
    expect(res.body.guestSlots).toBe(0);
  });

  it("refuses once every team has 5", async () => {
    const res = await admin.post(`/matchdays/${dayId}/pitch-guests`, { name: "One Too Many" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No guest spots left/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE display_name = 'One Too Many'").first("n")).toBe(0);
  });

  it("only allows guests (not members), only for admins", async () => {
    expect((await member.post(`/matchdays/${dayId}/pitch-guests`, { name: "Sneaky" })).status).toBe(403);
    expect((await admin.post(`/matchdays/${dayId}/pitch-guests`, { existingPlayerId: memberId })).status).toBe(409);
  });

  it("late guests can score but never earn points when their team wins", async () => {
    const d = (await admin.get(`/matchdays/${dayId}`)).body;
    const [A, B] = d.sets;
    const wale = B.players.find((p: any) => p.displayName === "Walk-in Wale").playerId;
    const m = await admin.post(`/matchdays/${dayId}/matches`, { homeSetId: B.id, awaySetId: A.id });
    expect((await admin.post(`/matches/${m.body.matches[0].id}/goals`, { setId: B.id, kind: "normal", scorerPlayerId: wale })).status).toBe(201);
    await admin.patch(`/matches/${m.body.matches[0].id}`, { status: "completed" });
    const all = d.sets.flatMap((s: any) => s.players.map((p: any) => p.playerId));
    await admin.post(`/matchdays/${dayId}/attendance`, { entries: all.map((id: string) => ({ playerId: id, attended: true })) });
    const fin = await admin.post(`/matchdays/${dayId}/finalize`);
    expect(fin.status).toBe(200);
    const stat = await env.DB.prepare("SELECT points, goals FROM day_player_stats WHERE match_day_id = ? AND player_id = ?").bind(dayId, wale).first<{ points: number; goals: number }>();
    expect(stat).toEqual({ points: 0, goals: 1 });
    // Their member teammates did get 3.
    const teammates = B.players.filter((p: any) => p.kind === "member").map((p: any) => p.playerId);
    const pts = await env.DB.prepare(`SELECT SUM(points) AS s FROM day_player_stats WHERE match_day_id = ? AND player_id IN (SELECT value FROM json_each(?))`).bind(dayId, JSON.stringify(teammates)).first("s");
    expect(pts).toBe(3 * teammates.length);
    // No more pitch additions once finalized.
    expect((await admin.post(`/matchdays/${dayId}/pitch-guests`, { name: "Too Late" })).status).toBe(409);
  });
});

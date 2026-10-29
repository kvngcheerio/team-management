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

  it("shows a guest's contact details to admins only", async () => {
    const reg = (b: any) => b.registrations.find((r: any) => r.displayName === "Walk-in Wale");
    expect(reg((await admin.get(`/matchdays/${dayId}`)).body).contactPhone).toBe("+234 803 333 3333");
    const guestId = reg((await admin.get(`/matchdays/${dayId}`)).body).playerId;
    for (const path of [`/matchdays/${dayId}`, "/dashboard", "/players", `/players/${guestId}`]) {
      const res = await member.get(path);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toContain("803 333 3333");
      expect(JSON.stringify(res.body), path).not.toMatch(/"contact(Email|Phone)"/);
    }
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

  it("keeps guest stats off members' shared boards but on the guest's profile", async () => {
    const seasonId = (await admin.get(`/matchdays/${dayId}`)).body.day.seasonId;
    const wale = (await admin.get(`/players`)).body.players.find((p: any) => p.displayName === "Walk-in Wale").id;
    const memberStats = (await member.get(`/seasons/${seasonId}/stats`)).body;
    expect(memberStats.players.some((r: any) => r.playerId === wale)).toBe(false);
    expect(memberStats.totals.goals).toBe(1); // the guest's goal still counts in the season total
    const memberBoards = (await member.get(`/seasons/${seasonId}/standings`)).body;
    expect(memberBoards.goals.some((r: any) => r.playerId === wale)).toBe(false);
    expect((await member.get(`/dashboard`)).body.leaders.topScorers.some((r: any) => r.playerId === wale)).toBe(false);
    // Admins still see them; anyone can open the guest's own profile.
    expect((await admin.get(`/seasons/${seasonId}/stats`)).body.players.some((r: any) => r.playerId === wale)).toBe(true);
    expect((await admin.get(`/seasons/${seasonId}/standings`)).body.goals.find((r: any) => r.playerId === wale).goals).toBe(1);
    expect((await member.get(`/players/${wale}`)).body.seasons[0].goals).toBe(1);
  });
});

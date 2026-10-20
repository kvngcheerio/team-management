import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createMatchDay, createPlayer, createSeason, setupAdmin } from "./helpers";

let admin: Client;
let seasonId: string;
let dayId: string;
const ps: { playerId: string; client: Client }[] = [];
let absentee: { playerId: string; client: Client };

/** Plays a quick 2-set day (one 1–0 match) and finalizes it. */
beforeAll(async () => {
  ({ admin } = await setupAdmin());
  seasonId = (await createSeason(admin)).id;
  const day = await createMatchDay(admin, seasonId, { capacity: 10 });
  dayId = day.day.id;
  await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
  for (let i = 0; i < 5; i++) {
    const p = await createPlayer(admin, `Voter ${i}`, { login: true });
    ps.push({ playerId: p.playerId, client: p.client! });
    await p.client!.post(`/matchdays/${dayId}/checkin`);
  }
  const gen = await admin.post(`/matchdays/${dayId}/teams/generate`, { mode: "random", setCount: 2, teamSize: 2, seed: 9 });
  const pub = await admin.post(`/matchdays/${dayId}/teams/publish`, {
    sets: gen.body.sets.map((s: any) => ({ idx: s.idx, players: s.players.map((p: any) => ({ playerId: p.playerId, role: p.role })) })),
  });
  await admin.post(`/matchdays/${dayId}/start`);
  absentee = ps[4]!;
  const roster = pub.body.sets.flatMap((s: any) => s.players.map((p: any) => p.playerId));
  await admin.post(`/matchdays/${dayId}/attendance`, { entries: roster.map((id: string) => ({ playerId: id, attended: id !== absentee.playerId })) });
  const [A, B] = pub.body.sets;
  const m = await admin.post(`/matchdays/${dayId}/matches`, { homeSetId: A.id, awaySetId: B.id });
  await admin.post(`/matches/${m.body.matches[0].id}/goals`, { setId: A.id, kind: "unattributed" });
  await admin.patch(`/matches/${m.body.matches[0].id}`, { status: "completed" });
  const fin = await admin.post(`/matchdays/${dayId}/finalize`);
  if (fin.status !== 200) throw new Error(JSON.stringify(fin.body));
});

async function closePoll(pollId: string) {
  const t = Date.now();
  await env.DB.prepare("UPDATE polls SET opens_at = ?, closes_at = ? WHERE id = ?").bind(new Date(t - 3600_000).toISOString(), new Date(t - 1000).toISOString(), pollId).run();
}

describe("weekly MVP vote", () => {
  let pollId: string;

  it("opens automatically when the match day is finalized, for 48 hours", async () => {
    const d = (await ps[0]!.client.get(`/matchdays/${dayId}`)).body;
    expect(d.mvp).toMatchObject({ kind: "matchday", open: true, canVote: true, results: null });
    pollId = d.mvp.id;
    const hours = (Date.parse(d.mvp.closesAt) - Date.parse(d.mvp.opensAt)) / 3600_000;
    expect(Math.round(hours)).toBe(48);
    // The voter isn't offered themselves.
    expect(d.mvp.candidates.some((c: any) => c.playerId === ps[0]!.playerId)).toBe(false);
    expect((await ps[0]!.client.get("/dashboard")).body.openPolls.map((p: any) => p.id)).toContain(pollId);
    // Finalizing again doesn't create a second poll.
    await admin.post(`/matchdays/${dayId}/finalize`);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM polls WHERE match_day_id = ?").bind(dayId).first("n")).toBe(1);
  });

  it("enforces eligibility: attendees only, no self-votes, absent players can't be voted for", async () => {
    expect((await absentee.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[0]!.playerId })).status).toBe(403);
    expect((await ps[0]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[0]!.playerId })).status).toBe(422);
    expect((await ps[0]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: absentee.playerId })).status).toBe(422);
  });

  it("keeps one changeable vote per voter and hides results until closed", async () => {
    await ps[0]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[2]!.playerId });
    const changed = await ps[0]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[1]!.playerId });
    expect(changed.body.poll).toMatchObject({ myVote: ps[1]!.playerId, results: null, turnout: { voted: 1, eligible: 4 } });
    await ps[2]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[1]!.playerId });
    await ps[1]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[3]!.playerId });
    // Even admins can't peek at results while open.
    expect((await admin.get(`/polls/${pollId}`)).body.poll.results).toBeNull();
  });

  it("reveals the winner after closing and refuses late votes", async () => {
    await closePoll(pollId);
    const p = (await ps[3]!.client.get(`/polls/${pollId}`)).body.poll;
    expect(p.open).toBe(false);
    expect(p.results.winners.map((w: any) => w.playerId)).toEqual([ps[1]!.playerId]);
    expect(p.results.ranked[0]).toMatchObject({ playerId: ps[1]!.playerId, votes: 2 });
    expect((await ps[3]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[0]!.playerId })).status).toBe(409);
    const stats = (await ps[0]!.client.get(`/seasons/${seasonId}/stats`)).body;
    expect(stats.players.find((r: any) => r.playerId === ps[1]!.playerId).mvpAwards).toBe(1);
  });
});

describe("season MVP vote", () => {
  it("is opened by an admin, open to approved members, and closable early", async () => {
    expect((await ps[0]!.client.post(`/seasons/${seasonId}/mvp-poll`, { days: 3 })).status).toBe(403);
    const res = await admin.post(`/seasons/${seasonId}/mvp-poll`, { days: 3 });
    expect(res.status).toBe(201);
    const pollId = res.body.poll.id;
    expect((await admin.post(`/seasons/${seasonId}/mvp-poll`, { days: 3 })).status).toBe(409);
    // Absent-on-the-day members can still vote in the season poll, for players who appeared.
    expect((await absentee.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[0]!.playerId })).status).toBe(200);
    expect((await ps[1]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[2]!.playerId })).status).toBe(200);
    // Tie → shared MVP.
    const closed = await admin.post(`/polls/${pollId}/close`, {});
    expect(closed.body.poll.results.winners.map((w: any) => w.playerId).sort()).toEqual([ps[0]!.playerId, ps[2]!.playerId].sort());
    expect((await ps[3]!.client.post(`/polls/${pollId}/vote`, { candidatePlayerId: ps[0]!.playerId })).status).toBe(409);
    const stats = (await admin.get(`/seasons/${seasonId}/stats`)).body;
    expect(stats.players.filter((r: any) => r.seasonMvp).map((r: any) => r.playerId).sort()).toEqual([ps[0]!.playerId, ps[2]!.playerId].sort());
  });
});

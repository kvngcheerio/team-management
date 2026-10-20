import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createMatchDay, createPlayer, createSeason, setupAdmin } from "./helpers";

let admin: Client;
let dayId: string;
let A: any, B: any;

beforeAll(async () => {
  ({ admin } = await setupAdmin());
  const seasonId = (await createSeason(admin)).id;
  const day = await createMatchDay(admin, seasonId, { capacity: 10, teamSize: 2, setCount: 2 });
  dayId = day.day.id;
  await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
  for (let i = 0; i < 4; i++) {
    const p = await createPlayer(admin, `Result Player ${i}`, { login: true });
    await p.client!.post(`/matchdays/${dayId}/checkin`);
  }
  const gen = await admin.post(`/matchdays/${dayId}/teams/generate`, { mode: "random", seed: 4 });
  await admin.post(`/matchdays/${dayId}/teams/publish`, { sets: gen.body.sets.map((s: any) => ({ idx: s.idx, players: s.players.map((p: any) => ({ playerId: p.playerId })) })) });
  const started = await admin.post(`/matchdays/${dayId}/start`);
  [A, B] = started.body.sets;
});

describe("recording results", () => {
  it("records a finished match with a final score in one step, reconciled", async () => {
    const res = await admin.post(`/matchdays/${dayId}/matches`, { homeSetId: A.id, awaySetId: B.id, final: { homeScore: 3, awayScore: 1 } });
    expect(res.status).toBe(201);
    const m = res.body.matches[0];
    expect(m).toMatchObject({ homeScore: 3, awayScore: 1, status: "completed", reconciled: true });
    expect(m.goals.filter((g: any) => g.kind === "unattributed")).toHaveLength(4);
    expect(res.body.sets.find((s: any) => s.id === A.id).record).toMatchObject({ wins: 1, goalsFor: 3, goalsAgainst: 1 });
    // Another final score can follow straight away (no "finish current match" block).
    expect((await admin.post(`/matchdays/${dayId}/matches`, { homeSetId: B.id, awaySetId: A.id, final: { homeScore: 0, awayScore: 0 } })).status).toBe(201);
  });

  it("lets admins name scorers afterwards without changing the score", async () => {
    const d = (await admin.get(`/matchdays/${dayId}`)).body;
    const m = d.matches[0];
    const goal = m.goals.find((g: any) => g.setId === A.id);
    const [a1, a2] = A.players.map((p: any) => p.playerId);
    const b1 = B.players[0].playerId;
    // Validation still applies: a B player can't score A's normal goal.
    expect((await admin.post(`/goals/${goal.id}/attribute`, { kind: "normal", scorerPlayerId: b1 })).status).toBe(422);
    const ok = await admin.post(`/goals/${goal.id}/attribute`, { kind: "normal", scorerPlayerId: a1, assistPlayerId: a2 });
    expect(ok.status).toBe(200);
    const updated = ok.body.matches[0];
    expect(updated).toMatchObject({ homeScore: 3, awayScore: 1, reconciled: true });
    expect(updated.goals.find((g: any) => g.id === goal.id)).toMatchObject({ kind: "normal", scorerPlayerId: a1, assistPlayerId: a2 });
    // Own goal by a B player credited to A also works.
    const another = updated.goals.find((g: any) => g.setId === A.id && g.kind === "unattributed");
    expect((await admin.post(`/goals/${another.id}/attribute`, { kind: "own_goal", scorerPlayerId: b1 })).status).toBe(200);
    // Can't attribute the same goal twice.
    expect((await admin.post(`/goals/${goal.id}/attribute`, { kind: "normal", scorerPlayerId: a2 })).status).toBe(409);
  });

  it("finalizes with the recorded results and counts named goals", async () => {
    const d = (await admin.get(`/matchdays/${dayId}`)).body;
    const roster = d.sets.flatMap((s: any) => s.players.map((p: any) => p.playerId));
    await admin.post(`/matchdays/${dayId}/attendance`, { entries: roster.map((id: string) => ({ playerId: id, attended: true })) });
    const fin = await admin.post(`/matchdays/${dayId}/finalize`);
    expect(fin.status).toBe(200);
    expect(fin.body.winner).toMatchObject({ status: "decided", winnerSetIds: [A.id] });
    const a1 = A.players[0].playerId;
    const stat = await env.DB.prepare("SELECT goals, points FROM day_player_stats WHERE match_day_id = ? AND player_id = ?").bind(dayId, a1).first<{ goals: number; points: number }>();
    expect(stat).toEqual({ goals: 1, points: 3 });
  });
});

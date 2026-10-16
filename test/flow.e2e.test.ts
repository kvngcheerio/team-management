/**
 * End-to-end flow through the real Worker, real auth sessions and D1:
 * create season → create match day → member check-in → approve guest → generate/publish teams →
 * confirm attendance → record matches and goals → finalize → verify standings,
 * then repeat finalization, apply an audited correction, and close the season.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createMatchDay, createPlayer, createSeason, setupAdmin } from "./helpers";

let admin: Client;

let seasonId: string;
let dayId: string;
const members: { name: string; playerId: string; client: Client }[] = [];
let guestPlayerId: string;
let detail: any;

const pts = async () => {
  const rows = await env.DB.prepare("SELECT player_id, points FROM day_player_stats WHERE match_day_id = ?").bind(dayId).all<{ player_id: string; points: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.player_id, r.points]));
};

describe("match day end-to-end", () => {
  beforeAll(async () => {
    ({ admin } = await setupAdmin());
    const names = ["Bola", "Chidi", "Dayo", "Emeka", "Funmi", "Gbenga", "Ifeanyi"];
    for (const [i, name] of names.entries()) {
      const p = await createPlayer(admin, name, { login: true, skillRating: 3 + i, gkPreference: i === 0 || i === 1 ? "prefers" : "none" });
      members.push({ name, playerId: p.playerId, client: p.client! });
    }
  });

  it("creates a six-month season", async () => {
    const season = await createSeason(admin, "2026-10-01");
    expect(season.endDate).toBe("2027-03-31");
    seasonId = season.id;
  });

  it("creates a match day and opens check-in", async () => {
    detail = await createMatchDay(admin, seasonId);
    dayId = detail.day.id;
    expect(detail.day.status).toBe("draft");
    // Members cannot see draft days.
    expect((await members[0]!.client.get(`/matchdays/${dayId}`)).status).toBe(404);
    const open = await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
    expect(open.status).toBe(200);
    expect(open.body.day.status).toBe("checkin_open");
  });

  it("lets members check in (idempotently) and the admin check themselves in", async () => {
    for (const m of members) {
      const r = await m.client.post(`/matchdays/${dayId}/checkin`);
      expect(r.status).toBe(200);
      expect(r.body.me.registrationStatus).toBe("confirmed");
    }
    const again = await members[0]!.client.post(`/matchdays/${dayId}/checkin`);
    expect(again.status).toBe(200);
    expect(again.body.counts.confirmed).toBe(7);
    const self = await admin.post(`/matchdays/${dayId}/checkin`);
    expect(self.body.counts.confirmed).toBe(8);
  });

  it("accepts a guest via the public link and requires admin approval", async () => {
    const token = (detail.day.guestLink as string).split("/g/")[1]!;
    const guest = new Client();
    const info = await guest.get(`/public/matchdays/${token}`);
    expect(info.status).toBe(200);
    expect(info.body.open).toBe(true);
    const reg = await guest.post(`/public/matchdays/${token}/guests`, { name: "Gift Guest", phone: "+234 800 000 0000", elapsedMs: 6000 });
    expect(reg.status).toBe(200);
    expect(reg.body.status).toBe("pending");

    const d = await admin.get(`/matchdays/${dayId}`);
    const pending = d.body.registrations.find((r: any) => r.status === "pending");
    expect(pending.displayName).toBe("Gift Guest");
    expect(pending.contactPhone).toBe("+234 800 000 0000");
    guestPlayerId = pending.playerId;

    // Members never see pending guests or contact details.
    const asMember = await members[0]!.client.get(`/matchdays/${dayId}`);
    expect(asMember.body.registrations.some((r: any) => r.status === "pending")).toBe(false);
    expect(JSON.stringify(asMember.body)).not.toContain("+234");

    // Unapproved guests are not in the team pool.
    const gen = await admin.post(`/matchdays/${dayId}/teams/generate`, { mode: "balanced", seed: 7 });
    expect(gen.body.sets.flatMap((s: any) => s.players.map((p: any) => p.playerId))).not.toContain(guestPlayerId);

    const approved = await admin.post(`/registrations/${pending.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.counts.confirmed).toBe(9);
  });

  it("generates balanced teams and publishes them", async () => {
    const gen = await admin.post(`/matchdays/${dayId}/teams/generate`, { mode: "balanced", seed: 11 });
    expect(gen.status).toBe(200);
    const ids = gen.body.sets.flatMap((s: any) => s.players.map((p: any) => p.playerId));
    expect(new Set(ids).size).toBe(9);
    expect(ids).toContain(guestPlayerId);
    expect(gen.body.warnings.join(" ")).toMatch(/substitute/);

    // A member cannot publish.
    const sets = gen.body.sets.map((s: any) => ({ idx: s.idx, players: s.players.map((p: any) => ({ playerId: p.playerId, role: p.role, isGoalkeeper: p.isGoalkeeper })) }));
    expect((await members[0]!.client.post(`/matchdays/${dayId}/teams/publish`, { sets })).status).toBe(403);

    // Duplicates are rejected server-side.
    const dup = structuredClone(sets);
    dup[1].players.push(dup[0].players[0]);
    expect((await admin.post(`/matchdays/${dayId}/teams/publish`, { sets: dup })).status).toBe(422);

    const pub = await admin.post(`/matchdays/${dayId}/teams/publish`, { sets });
    expect(pub.status).toBe(200);
    expect(pub.body.sets).toHaveLength(2);
    expect(pub.body.day.teamsPublishedAt).toBeTruthy();
    // Republishing requires explicit confirmation.
    expect((await admin.post(`/matchdays/${dayId}/teams/publish`, { sets })).status).toBe(409);
    detail = pub.body;
  });

  it("locks, starts play and refuses roster changes afterwards", async () => {
    expect((await admin.post(`/matchdays/${dayId}/transition`, { to: "locked" })).body.day.status).toBe("locked");
    // Members can no longer check in or withdraw.
    expect((await members[0]!.client.post(`/matchdays/${dayId}/withdraw`)).status).toBe(409);
    const started = await admin.post(`/matchdays/${dayId}/start`);
    expect(started.body.day.status).toBe("in_progress");
    const sets = started.body.sets.map((s: any) => ({ idx: s.idx, players: s.players.map((p: any) => ({ playerId: p.playerId })) }));
    const republish = await admin.post(`/matchdays/${dayId}/teams/publish`, { sets, replace: true });
    expect(republish.status).toBe(409);
    expect(republish.body.error).toMatch(/locked/);
    // Membership snapshot at lock: guest is not eligible.
    const guestEntry = started.body.sets.flatMap((s: any) => s.players).find((p: any) => p.playerId === guestPlayerId);
    expect(guestEntry.memberAtLock).toBe(false);
    detail = started.body;
  });

  let A: any, B: any, absentId: string, a1: string, a2: string, b1: string;

  it("confirms attendance with one absentee", async () => {
    [A, B] = detail.sets;
    const aMembers = A.players.filter((p: any) => p.playerId !== guestPlayerId);
    const bMembers = B.players.filter((p: any) => p.playerId !== guestPlayerId);
    [a1, a2, absentId] = aMembers.map((p: any) => p.playerId);
    b1 = bMembers[0].playerId;
    const all = detail.sets.flatMap((s: any) => s.players.map((p: any) => p.playerId));
    const res = await admin.post(`/matchdays/${dayId}/attendance`, { entries: all.map((id: string) => ({ playerId: id, attended: id !== absentId })) });
    expect(res.status).toBe(200);
    const absent = res.body.sets.flatMap((s: any) => s.players).find((p: any) => p.playerId === absentId);
    expect(absent.attended).toBe(false);
  });

  it("records matches and goals with validation", async () => {
    const m1 = await admin.post(`/matchdays/${dayId}/matches`, { id: crypto.randomUUID(), homeSetId: A.id, awaySetId: B.id });
    expect(m1.status).toBe(201);
    const match1 = m1.body.matches[0];
    // Only one match at a time.
    expect((await admin.post(`/matchdays/${dayId}/matches`, { homeSetId: A.id, awaySetId: B.id })).status).toBe(409);

    // Validation: self-assist, wrong-team scorer, own goal by own player.
    expect((await admin.post(`/matches/${match1.id}/goals`, { setId: A.id, kind: "normal", scorerPlayerId: a1, assistPlayerId: a1 })).status).toBe(422);
    expect((await admin.post(`/matches/${match1.id}/goals`, { setId: A.id, kind: "normal", scorerPlayerId: b1 })).status).toBe(422);
    expect((await admin.post(`/matches/${match1.id}/goals`, { setId: A.id, kind: "own_goal", scorerPlayerId: a2 })).status).toBe(422);

    const goalId = crypto.randomUUID();
    const g1 = await admin.post(`/matches/${match1.id}/goals`, { id: goalId, setId: A.id, kind: "normal", scorerPlayerId: a1, assistPlayerId: a2 });
    expect(g1.status).toBe(201);
    // Double submission with the same id is idempotent.
    const g1again = await admin.post(`/matches/${match1.id}/goals`, { id: goalId, setId: A.id, kind: "normal", scorerPlayerId: a1, assistPlayerId: a2 });
    expect(g1again.body.matches[0].homeScore).toBe(1);
    const g2 = await admin.post(`/matches/${match1.id}/goals`, { setId: A.id, kind: "own_goal", scorerPlayerId: b1 });
    expect(g2.body.matches[0]).toMatchObject({ homeScore: 2, awayScore: 0, reconciled: true });
    expect((await admin.patch(`/matches/${match1.id}`, { status: "completed" })).status).toBe(200);

    // Match 2: B 1–1 A. The guest scores for their set.
    const m2 = await admin.post(`/matchdays/${dayId}/matches`, { homeSetId: B.id, awaySetId: A.id });
    const match2 = m2.body.matches[1];
    const guestInA = A.players.some((p: any) => p.playerId === guestPlayerId);
    await admin.post(`/matches/${match2.id}/goals`, { setId: B.id, kind: guestInA ? "unattributed" : "normal", scorerPlayerId: guestInA ? null : guestPlayerId });
    await admin.post(`/matches/${match2.id}/goals`, { setId: A.id, kind: "normal", scorerPlayerId: guestInA ? guestPlayerId : a1 });
    const done = await admin.patch(`/matches/${match2.id}`, { status: "completed" });
    expect(done.body.matches[1]).toMatchObject({ homeScore: 1, awayScore: 1, status: "completed" });
    const rec = done.body.sets.find((s: any) => s.id === A.id).record;
    expect(rec).toMatchObject({ played: 2, wins: 1, draws: 1, losses: 0, goalsFor: 3, goalsAgainst: 1 });
  });

  it("blocks finalization while scores don't reconcile", async () => {
    const match2 = detail.matches?.[1] ?? (await admin.get(`/matchdays/${dayId}`)).body.matches[1];
    await admin.patch(`/matches/${match2.id}`, { homeScore: 3 });
    const blocked = await admin.post(`/matchdays/${dayId}/finalize`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.details.map((i: any) => i.code)).toContain("score_mismatch");
    await admin.patch(`/matches/${match2.id}`, { homeScore: 1 });
  });

  it("finalizes once, even with concurrent duplicate requests", async () => {
    const [r1, r2] = await Promise.all([admin.post(`/matchdays/${dayId}/finalize`), admin.post(`/matchdays/${dayId}/finalize`)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.day.status).toBe("finalized");
    expect(r1.body.winner).toMatchObject({ status: "decided", winnerSetIds: [A.id], method: "outright" });
    const again = await admin.post(`/matchdays/${dayId}/finalize`);
    expect(again.body.alreadyFinalized).toBe(true);

    const p = await pts();
    const total = Object.values(p).reduce((s, v) => s + v, 0);
    const eligibleA = A.players.filter((x: any) => x.playerId !== guestPlayerId && x.playerId !== absentId).length;
    expect(total).toBe(3 * eligibleA);
    expect(p[a1]).toBe(3);
    expect(p[absentId]).toBe(0);
    expect(p[guestPlayerId]).toBe(0);
    expect(p[b1]).toBe(0);
  });

  it("shows correct standings and leaderboards", async () => {
    const res = await members[3]!.client.get(`/seasons/${seasonId}/standings`);
    expect(res.status).toBe(200);
    const row = (id: string) => res.body.table.find((r: any) => r.playerId === id);
    expect(row(a1)).toMatchObject({ points: 3, dailyWins: 1, appearances: 1, position: 1 });
    expect(row(absentId)).toMatchObject({ points: 0, appearances: 0 });
    expect(row(b1)).toMatchObject({ points: 0, appearances: 1 });
    // Guests are not in the league table but do appear in the scorers list.
    expect(row(guestPlayerId)).toBeUndefined();
    expect(res.body.goals.find((r: any) => r.playerId === guestPlayerId)).toMatchObject({ goals: 1 });
    // Own goals do not count as scored goals.
    expect(res.body.goals.find((r: any) => r.playerId === b1)).toBeUndefined();
    expect(res.body.assists.find((r: any) => r.playerId === a2)).toMatchObject({ assists: 1 });
    // Ordering: points desc, then daily wins, goals, assists.
    const ptsCol = res.body.table.map((r: any) => r.points);
    expect([...ptsCol].sort((x: number, y: number) => y - x)).toEqual(ptsCol);
  });

  it("applies an audited correction and recalculates standings without duplicates", async () => {
    const d = (await admin.get(`/matchdays/${dayId}`)).body;
    const match2 = d.matches[1];
    // A reason is required on a finalized day.
    expect((await admin.post(`/matches/${match2.id}/goals`, { setId: B.id, kind: "unattributed" })).status).toBe(422);
    // B actually won match 2 → 1 win each → shared first place.
    const fix = await admin.post(`/matches/${match2.id}/goals`, { setId: B.id, kind: "unattributed", reason: "Missed a late B goal" });
    expect(fix.status).toBe(201);
    expect(fix.body.winner).toMatchObject({ status: "decided", method: "shared" });
    const p = await pts();
    expect(p[a1]).toBe(3);
    expect(p[b1]).toBe(3);
    expect(Math.max(...Object.values(p))).toBe(3);
    const standings = (await admin.get(`/seasons/${seasonId}/standings`)).body;
    expect(standings.table.find((r: any) => r.playerId === b1)).toMatchObject({ points: 3, dailyWins: 1 });
    expect(standings.table.find((r: any) => r.playerId === a1)).toMatchObject({ points: 3, dailyWins: 1 });

    // Attendance correction: the absentee actually played → now eligible.
    const att = await admin.post(`/matchdays/${dayId}/attendance`, { entries: [{ playerId: absentId, attended: true }], reason: "Arrived late, played" });
    expect(att.status).toBe(200);
    expect((await pts())[absentId]).toBe(3);

    const audit = await admin.get(`/admin/audit?matchDayId=${dayId}`);
    const entry = audit.body.entries.find((e: any) => e.action === "correction.goal.create");
    expect(entry).toMatchObject({ reason: "Missed a late B goal", actorName: "Ada Admin" });
    expect(entry.after).toMatchObject({ setId: B.id, kind: "unattributed" });
    expect(audit.body.entries.find((e: any) => e.action === "correction.attendance").before).toEqual({ [absentId]: 0 });
    // Members cannot read the audit log.
    expect((await members[0]!.client.get("/admin/audit")).status).toBe(403);
  });

  it("shows the player profile with season stats and history", async () => {
    const res = await members[0]!.client.get(`/players/${a1}`);
    expect(res.status).toBe(200);
    expect(res.body.seasons[0]).toMatchObject({ points: 3, dailyWins: 1 });
    expect(res.body.history[0]).toMatchObject({ matchDayId: dayId, points: 3 });
    // Private fields are hidden from members.
    expect(res.body.player.skillRating).toBeUndefined();
  });

  it("converts the guest to a member prospectively, preserving history", async () => {
    const res = await admin.post(`/players/${guestPlayerId}/convert`, {});
    expect(res.status).toBe(200);
    expect(res.body.player.kind).toBe("member");
    expect((await pts())[guestPlayerId]).toBe(0);
    const profile = await admin.get(`/players/${guestPlayerId}`);
    expect(profile.body.seasons[0].goals).toBe(1);
  });

  it("closes the season and freezes the table", async () => {
    const close = await admin.post(`/seasons/${seasonId}/close`, {});
    expect(close.status).toBe(200);
    const s = (await admin.get(`/seasons/${seasonId}/standings`)).body;
    expect(s.frozen).toBe(true);
    expect(s.table.find((r: any) => r.playerId === a1).points).toBe(3);
    // Corrections are refused after closing.
    const d = (await admin.get(`/matchdays/${dayId}`)).body;
    expect((await admin.post(`/matches/${d.matches[0].id}/goals`, { setId: A.id, kind: "unattributed", reason: "late fix" })).status).toBe(409);
  });
});

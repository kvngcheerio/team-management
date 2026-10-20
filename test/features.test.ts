import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createMatchDay, createPlayer, createSeason, PASSWORD, setupAdmin } from "./helpers";

let admin: Client;
let seasonId: string;

// 1×1 JPEG / PNG (valid magic bytes)
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

beforeAll(async () => {
  ({ admin } = await setupAdmin());
  await admin.put("/admin/settings", { payment_mode: "test" });
  seasonId = (await createSeason(admin)).id;
});

async function signupUrl() {
  const s = await admin.get("/admin/settings");
  return s.body.signupUrl as string;
}

describe("shareable signup link", () => {
  it("creates an unpaid guest account who must pay the guest fee to play", async () => {
    const token = (await signupUrl()).split("/join/")[1]!;
    const c = new Client();
    expect((await c.get(`/public/signup/${token}`)).status).toBe(200);
    const res = await c.post(`/public/signup/${token}`, { name: "Sam Signup", email: "sam@example.com", password: PASSWORD, phone: "+234 801 111 1111" });
    expect(res.status).toBe(200);
    const me = (await c.get("/me")).body;
    expect(me.user.role).toBe("member");
    expect(me.player).toMatchObject({ displayName: "Sam Signup", kind: "guest", approved: true });

    const day = await createMatchDay(admin, seasonId);
    await admin.post(`/matchdays/${day.day.id}/transition`, { to: "checkin_open" });
    const ci = await c.post(`/matchdays/${day.day.id}/checkin`);
    expect(ci.status).toBe(200);
    // Not confirmed until the ₦5,000 guest fee is paid.
    expect(ci.body.me).toMatchObject({ registrationStatus: "pending", feeStatus: "unpaid", feeAmount: 5000 });
  });

  it("rotating or disabling kills the old link", async () => {
    const oldToken = (await signupUrl()).split("/join/")[1]!;
    const rotated = await admin.post("/admin/signup-link/rotate", {});
    const newToken = rotated.body.signupUrl.split("/join/")[1];
    expect(newToken).not.toBe(oldToken);
    expect((await new Client().get(`/public/signup/${oldToken}`)).status).toBe(410);
    expect((await new Client().get(`/public/signup/${newToken}`)).status).toBe(200);
    await admin.put("/admin/settings", { signup_enabled: "0" });
    expect((await new Client().post(`/public/signup/${newToken}`, { name: "X", email: "x@example.com", password: PASSWORD })).status).toBe(410);
    await admin.put("/admin/settings", { signup_enabled: "1" });
  });

  it("never exposes the signup token to members", async () => {
    const p = await createPlayer(admin, "Nosy Member", { login: true });
    expect((await p.client!.get("/admin/settings")).status).toBe(403);
    expect(JSON.stringify((await p.client!.get("/me")).body)).not.toContain("join/");
  });
});

describe("admin invites", () => {
  it("creates a single-use link that makes a new admin", async () => {
    const inv = await admin.post("/admin/admin-invites", { note: "Co-organiser" });
    expect(inv.status).toBe(201);
    const token = inv.body.url.split("/admin-invite/")[1];
    const c = new Client();
    expect((await c.get(`/public/admin-invites/${token}`)).status).toBe(200);
    expect((await c.post(`/public/admin-invites/${token}/accept`, { name: "Co Admin", email: "co@example.com", password: PASSWORD })).status).toBe(200);
    const me = (await c.get("/me")).body;
    expect(me.user.role).toBe("admin");
    expect(me.player.approved).toBe(true);
    expect((await new Client().post(`/public/admin-invites/${token}/accept`, { name: "Again", email: "again@example.com", password: PASSWORD })).status).toBe(410);
    const list = (await admin.get("/admin/admin-invites")).body.invites;
    expect(list[0]).toMatchObject({ note: "Co-organiser", usedByEmail: "co@example.com" });
  });

  it("only admins can create invites, and unused invites can be revoked", async () => {
    const m = await createPlayer(admin, "Member Mo", { login: true });
    expect((await m.client!.post("/admin/admin-invites", {})).status).toBe(403);
    const inv = await admin.post("/admin/admin-invites", {});
    const token = inv.body.url.split("/admin-invite/")[1];
    const id = (await admin.get("/admin/admin-invites")).body.invites.find((i: any) => !i.usedAt).id;
    expect((await admin.req("DELETE", `/admin/admin-invites/${id}`)).status).toBe(200);
    expect((await new Client().get(`/public/admin-invites/${token}`)).status).toBe(410);
  });
});

describe("profile photos", () => {
  it("lets players upload their own photo, not someone else's; validates images", async () => {
    const a = await createPlayer(admin, "Photo A", { login: true });
    const b = await createPlayer(admin, "Photo B", { login: true });
    const up = await a.client!.req("PUT", `/players/${a.playerId}/avatar`, { dataUrl: JPEG });
    expect(up.status).toBe(200);
    expect(up.body.player.avatarUrl).toMatch(/\/api\/players\/.+\/avatar\?v=/);
    expect((await b.client!.req("PUT", `/players/${a.playerId}/avatar`, { dataUrl: JPEG })).status).toBe(403);
    expect((await a.client!.req("PUT", `/players/${a.playerId}/avatar`, { dataUrl: "data:image/png;base64,PHN2Zz48L3N2Zz4=" })).status).toBe(422);
    expect((await a.client!.req("PUT", `/players/${a.playerId}/avatar`, { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })).status).toBe(422);
    // Admin can set anyone's photo.
    expect((await admin.req("PUT", `/players/${b.playerId}/avatar`, { dataUrl: JPEG })).status).toBe(200);
    // Signed-in users can view; anonymous can't.
    const img = await b.client!.req("GET", up.body.player.avatarUrl.replace("/api", ""));
    expect(img.status).toBe(200);
    expect((await new Client().get(`/players/${a.playerId}/avatar`)).status).toBe(401);
  });

  it("lets players edit their own name and phone", async () => {
    const a = await createPlayer(admin, "Old Name", { login: true });
    const res = await a.client!.patch("/me/player", { displayName: "New Name", contactPhone: "+234 802 222 2222" });
    expect(res.status).toBe(200);
    expect((await a.client!.get("/me")).body.player).toMatchObject({ displayName: "New Name", contactPhone: "+234 802 222 2222" });
  });
});

describe("availability and team sheet reveal", () => {
  it("records 'can't make it', frees places, and lets the player change their mind", async () => {
    const day = await createMatchDay(admin, seasonId, { date: "2026-11-14", checkinDeadlineDate: "2026-11-13", capacity: 2 });
    const id = day.day.id;
    await admin.post(`/matchdays/${id}/transition`, { to: "checkin_open" });
    const [a, b, c] = [await createPlayer(admin, "Av A", { login: true }), await createPlayer(admin, "Av B", { login: true }), await createPlayer(admin, "Av C", { login: true })];
    await a.client!.post(`/matchdays/${id}/checkin`);
    await b.client!.post(`/matchdays/${id}/checkin`);
    expect((await c.client!.post(`/matchdays/${id}/checkin`)).body.me.registrationStatus).toBe("waitlist");
    const out = await a.client!.post(`/matchdays/${id}/unavailable`);
    expect(out.body.me.registrationStatus).toBe("unavailable");
    expect(out.body.counts).toMatchObject({ confirmed: 1, unavailable: 1 });
    // Admin sees who hasn't responded at all.
    const d = (await admin.get(`/matchdays/${id}`)).body;
    expect(d.noResponse.some((p: any) => p.playerId === a.playerId)).toBe(false);
    // Changing their mind: back in, respecting capacity (one place free).
    expect((await a.client!.post(`/matchdays/${id}/checkin`)).body.me.registrationStatus).toBe("confirmed");
  });

  it("hides the team sheet from players until 07:50 WAT on match day", async () => {
    const day = await createMatchDay(admin, seasonId, { date: "2026-11-21", checkinDeadlineDate: "2026-11-20", capacity: 10 });
    const id = day.day.id;
    expect(day.day.teamSheetAt).toBe("2026-11-21T06:50:00.000Z"); // 07:50 Africa/Lagos
    await admin.post(`/matchdays/${id}/transition`, { to: "checkin_open" });
    const players = [];
    for (let i = 0; i < 4; i++) players.push(await createPlayer(admin, `Sheet ${i}`, { login: true }));
    for (const p of players) await p.client!.post(`/matchdays/${id}/checkin`);
    const gen = await admin.post(`/matchdays/${id}/teams/generate`, { mode: "random", setCount: 2, teamSize: 2, seed: 1 });
    await admin.post(`/matchdays/${id}/teams/publish`, { sets: gen.body.sets.map((s: any) => ({ idx: s.idx, players: s.players.map((p: any) => ({ playerId: p.playerId })) })) });

    const asPlayer = (await players[0]!.client!.get(`/matchdays/${id}`)).body;
    expect(asPlayer.sets).toEqual([]);
    expect(asPlayer.day.teamsVisible).toBe(false);
    expect((await admin.get(`/matchdays/${id}`)).body.sets).toHaveLength(2);
    expect((await players[0]!.client!.get("/matchdays")).body.matchDays.find((m: any) => m.id === id).teamsPublished).toBe(false);

    // Simulate reaching the reveal time.
    await env.DB.prepare("UPDATE match_days SET team_sheet_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), id).run();
    const after = (await players[0]!.client!.get(`/matchdays/${id}`)).body;
    expect(after.day.teamsVisible).toBe(true);
    expect(after.sets).toHaveLength(2);
  });

  it("admins can change the reveal time per match day", async () => {
    const day = await createMatchDay(admin, seasonId, { date: "2026-11-28", checkinDeadlineDate: "2026-11-27" });
    const res = await admin.patch(`/matchdays/${day.day.id}`, { teamSheetTime: "07:30" });
    expect(res.body.day.teamSheetAt).toBe("2026-11-28T06:30:00.000Z");
    expect(res.body.day.teamSheetLocal).toEqual({ date: "2026-11-28", time: "07:30" });
  });
});

describe("cards, fines and dummy payments", () => {
  let dayId: string;
  let p1: { playerId: string; client: Client | null };
  let p2: { playerId: string; client: Client | null };

  beforeAll(async () => {
    const day = await createMatchDay(admin, seasonId, { date: "2026-12-05", checkinDeadlineDate: "2026-12-04", capacity: 10 });
    dayId = day.day.id;
    await admin.post(`/matchdays/${dayId}/transition`, { to: "checkin_open" });
    p1 = await createPlayer(admin, "Card One", { login: true });
    p2 = await createPlayer(admin, "Card Two", { login: true });
    const p3 = await createPlayer(admin, "Card Three", { login: true });
    const p4 = await createPlayer(admin, "Card Four", { login: true });
    for (const p of [p1, p2, p3, p4]) await p.client!.post(`/matchdays/${dayId}/checkin`);
    const gen = await admin.post(`/matchdays/${dayId}/teams/generate`, { mode: "random", setCount: 2, teamSize: 2, seed: 3 });
    await admin.post(`/matchdays/${dayId}/teams/publish`, { sets: gen.body.sets.map((s: any) => ({ idx: s.idx, players: s.players.map((p: any) => ({ playerId: p.playerId })) })) });
  });

  it("only allows cards once play has started, for rostered players, by admins", async () => {
    expect((await admin.post(`/matchdays/${dayId}/cards`, { playerId: p1.playerId, color: "yellow" })).status).toBe(409);
    await admin.post(`/matchdays/${dayId}/start`);
    expect((await p2.client!.post(`/matchdays/${dayId}/cards`, { playerId: p1.playerId, color: "yellow" })).status).toBe(403);
    const outsider = await createPlayer(admin, "Not Playing");
    expect((await admin.post(`/matchdays/${dayId}/cards`, { playerId: outsider.playerId, color: "red" })).status).toBe(422);
  });

  it("charges ₦2,000 per yellow and ₦5,000 per red, fixed at the time of the card", async () => {
    const y = await admin.post(`/matchdays/${dayId}/cards`, { id: crypto.randomUUID(), playerId: p1.playerId, color: "yellow", reason: "Dissent" });
    expect(y.status).toBe(201);
    expect(y.body.card).toMatchObject({ fineAmount: 2000, fineStatus: "unpaid" });
    const r = await admin.post(`/matchdays/${dayId}/cards`, { playerId: p1.playerId, color: "red" });
    expect(r.body.card.fineAmount).toBe(5000);
    // Price change doesn't touch existing fines.
    await admin.put("/admin/settings", { fine_yellow: 3000 });
    const y2 = await admin.post(`/matchdays/${dayId}/cards`, { playerId: p2.playerId, color: "yellow" });
    expect(y2.body.card.fineAmount).toBe(3000);
    await admin.put("/admin/settings", { fine_yellow: 2000 });
    const fines = (await p1.client!.get("/me/fines")).body;
    expect(fines.outstanding).toBe(7000);
    expect((await p1.client!.get("/me")).body.player.outstandingFines).toBe(7000);
  });

  it("pays fines through the dummy checkout, atomically and once", async () => {
    const mine = (await p1.client!.get("/me/fines")).body.cards.filter((k: any) => k.fineStatus === "unpaid");
    const others = (await p2.client!.get("/me/fines")).body.cards;
    // Can't pay someone else's fines.
    expect((await p1.client!.post("/fines/checkout", { cardIds: [others[0].id] })).status).toBe(409);
    const checkout = await p1.client!.post("/fines/checkout", { cardIds: mine.map((k: any) => k.id) });
    expect(checkout.status).toBe(201);
    expect(checkout.body).toMatchObject({ completed: false, external: 7000, wallet: 0 });
    const pid = checkout.body.paymentId;
    expect((await p1.client!.get(`/payments/${pid}`)).body.payment).toMatchObject({ amount: 7000, status: "pending", provider: "dummy", purpose: "fines" });
    // Another player can't complete or view it.
    expect((await p2.client!.post(`/payments/${pid}/simulate`, { outcome: "success" })).status).toBe(404);
    // Failure leaves fines unpaid.
    const failed = await p1.client!.post("/fines/checkout", { cardIds: [mine[0].id] });
    expect((await p1.client!.post(`/payments/${failed.body.paymentId}/simulate`, { outcome: "failure" })).body.payment.status).toBe("failed");
    expect((await p1.client!.get("/me/fines")).body.outstanding).toBe(7000);
    // Concurrent double "success" clicks settle once.
    const [s1, s2] = await Promise.all([
      p1.client!.post(`/payments/${pid}/simulate`, { outcome: "success" }),
      p1.client!.post(`/payments/${pid}/simulate`, { outcome: "success" }),
    ]);
    expect([s1.status, s2.status].every((s) => s === 200 || s === 409)).toBe(true);
    const final = (await p1.client!.get(`/payments/${pid}`)).body.payment;
    expect(final.status).toBe("succeeded");
    expect(final.cards.every((k: any) => k.fineStatus === "paid" && k.paidVia === "online")).toBe(true);
    expect((await p1.client!.get("/me/fines")).body.outstanding).toBe(0);
    // Paying again is refused.
    expect((await p1.client!.post("/fines/checkout", { cardIds: [mine[0].id] })).status).toBe(409);
  });

  it("refuses a payment if a fine was waived after checkout started", async () => {
    const card = (await admin.post(`/matchdays/${dayId}/cards`, { playerId: p2.playerId, color: "red" })).body.card;
    const co = await p2.client!.post("/fines/checkout", { cardIds: [card.id] });
    expect((await admin.post(`/cards/${card.id}/waive`, { reason: "First offence" })).status).toBe(200);
    expect((await p2.client!.post(`/payments/${co.body.paymentId}/simulate`, { outcome: "success" })).status).toBe(409);
    expect((await p2.client!.get(`/payments/${co.body.paymentId}`)).body.payment.status).toBe("cancelled");
  });

  it("supports cash payment, void with reason, and an admin fines summary", async () => {
    const fines = (await p2.client!.get("/me/fines")).body.cards.filter((k: any) => k.fineStatus === "unpaid");
    expect((await admin.post(`/cards/${fines[0].id}/mark-paid`, {})).body.card).toMatchObject({ fineStatus: "paid", paidVia: "cash" });
    const extra = (await admin.post(`/matchdays/${dayId}/cards`, { playerId: p2.playerId, color: "yellow" })).body.card;
    expect((await admin.post(`/cards/${extra.id}/void`, {})).status).toBe(422);
    expect((await admin.post(`/cards/${extra.id}/void`, { reason: "Wrong player" })).body.card.voided).toBe(true);
    const summary = (await admin.get("/admin/fines")).body;
    expect(summary.totals).toMatchObject({ paid: 10000, waived: 5000, owed: 0 });
    expect(summary.perPlayer.find((r: any) => r.playerId === p1.playerId)).toMatchObject({ yellow: 1, red: 1, paid: 7000 });
    expect((await p2.client!.get("/admin/fines")).status).toBe(403);
    const audit = (await admin.get("/admin/audit")).body.entries.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["card.yellow", "card.red", "card.waive", "card.void", "card.mark-paid", "payment.fines.succeeded"]));
  });

  it("shows cards in season stats (fines totals only for admins)", async () => {
    const asMember = (await p1.client!.get(`/seasons/${seasonId}/stats`)).body;
    const row = asMember.players.find((p: any) => p.playerId === p1.playerId);
    expect(row).toMatchObject({ yellow: 1, red: 1 });
    expect(row.owed).toBeUndefined();
    expect(asMember.totals.owed).toBeUndefined();
    const asAdmin = (await admin.get(`/seasons/${seasonId}/stats`)).body;
    expect(asAdmin.totals).toMatchObject({ paid: 10000 });
    expect((await p1.client!.get(`/players/${p1.playerId}`)).body.cards[0]).toMatchObject({ yellow: 1, red: 1 });
  });
});

describe("announcements", () => {
  it("admins post, members read; pinned first", async () => {
    const m = await createPlayer(admin, "Reader", { login: true });
    expect((await m.client!.post("/announcements", { title: "x", body: "y" })).status).toBe(403);
    await admin.post("/announcements", { title: "Kit colours", body: "Bring white and dark." });
    const pinned = await admin.post("/announcements", { title: "Fines start now", body: "Yellow ₦2,000, red ₦5,000.", pinned: true });
    expect(pinned.status).toBe(201);
    const list = (await m.client!.get("/announcements")).body.announcements;
    expect(list[0]).toMatchObject({ title: "Fines start now", pinned: true });
    expect((await m.client!.get("/dashboard")).body.announcements[0].title).toBe("Fines start now");
    expect((await admin.req("DELETE", `/announcements/${pinned.body.announcement.id}`)).status).toBe(200);
  });
});

describe("finance", () => {
  it("shows fine payments, records expenditures/income, and computes the balance (admins only)", async () => {
    const before = (await admin.get("/admin/finance")).body;
    // From the cards tests above: ₦7,000 paid online + ₦3,000 cash.
    expect(before.totals.fineIncome).toBe(10000);
    expect(before.payments.some((p: any) => p.method === "online" && p.reference?.startsWith("TEST-"))).toBe(true);
    expect(before.payments.some((p: any) => p.method === "cash")).toBe(true);

    expect((await admin.post("/admin/finance/entries", { kind: "expense", date: "2026-11-07", category: "Pitch hire", description: "Astro 2 hours", amount: 25000 })).status).toBe(201);
    await admin.post("/admin/finance/entries", { kind: "income", date: "2026-11-07", category: "Match fees", description: "Weekly dues", amount: 40000 });
    expect((await admin.post("/admin/finance/entries", { kind: "expense", date: "2026-11-07", category: "Other", description: "x", amount: -5 })).status).toBe(422);
    const after = (await admin.get("/admin/finance")).body;
    expect(after.totals).toMatchObject({ fineIncome: 10000, otherIncome: 40000, expenses: 25000, balance: 25000 });
    expect(after.expensesByCategory[0]).toEqual({ category: "Pitch hire", amount: 25000 });

    const expense = after.entries.find((e: any) => e.kind === "expense");
    expect((await admin.post(`/admin/finance/entries/${expense.id}/void`, {})).status).toBe(422);
    expect((await admin.post(`/admin/finance/entries/${expense.id}/void`, { reason: "Duplicate" })).status).toBe(200);
    expect((await admin.get("/admin/finance")).body.totals.balance).toBe(50000);
    // Date filter.
    expect((await admin.get("/admin/finance?from=2026-11-08&to=2026-11-30")).body.totals.otherIncome).toBe(0);

    const m = await createPlayer(admin, "Curious Member", { login: true });
    expect((await m.client!.get("/admin/finance")).status).toBe(403);
    expect((await m.client!.post("/admin/finance/entries", { kind: "income", date: "2026-11-07", category: "Other", description: "x", amount: 1 })).status).toBe(403);
  });
});

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createMatchDay, createPlayer, createSeason, PASSWORD, setupAdmin } from "./helpers";
import { addDays, addMonthsClamped } from "../src/shared/rules";
import { todayInZone } from "../src/shared/time";

let admin: Client;
let seasonId: string;
let inviter: { playerId: string; client: Client };
let guest: Client;
let guestId: string;
let dayCounter = 0;

const wallet = async (c: Client) => (await c.get("/me/account")).body.wallet.balance as number;

async function openDay(extra: Record<string, unknown> = {}) {
  dayCounter++;
  const date = addDays("2026-11-01", dayCounter * 2);
  const day = await createMatchDay(admin, seasonId, { date, checkinDeadlineDate: addDays(date, -1), capacity: 10, ...extra });
  await admin.post(`/matchdays/${day.day.id}/transition`, { to: "checkin_open" });
  return day.day.id as string;
}

async function pay(c: Client, checkout: { body: any }) {
  return c.post(`/payments/${checkout.body.paymentId}/simulate`, { outcome: "success" });
}

beforeAll(async () => {
  ({ admin } = await setupAdmin());
  await admin.put("/admin/settings", { payment_mode: "test" });
  seasonId = (await createSeason(admin)).id;
  const p = await createPlayer(admin, "Inviter Ike", { login: true });
  inviter = { playerId: p.playerId, client: p.client! };
});

describe("referral links", () => {
  it("each player gets a personal link; signups through it are guests linked to the inviter", async () => {
    const acct = (await inviter.client.get("/me/account")).body;
    expect(acct.referral.url).toMatch(/\/r\/[a-z0-9x]+$/);
    expect(acct.wallet.balance).toBe(0);
    const code = acct.referral.url.split("/r/")[1];
    const info = (await new Client().get(`/public/r/${code}`)).body;
    expect(info).toMatchObject({ referrerName: "Inviter Ike", guestFee: 5000, guestFreeAfter: 5 });
    guest = new Client();
    expect((await guest.post(`/public/r/${code}`, { name: "Gina Guest", email: "gina@example.com", password: PASSWORD })).status).toBe(200);
    const me = (await guest.get("/me")).body.player;
    expect(me).toMatchObject({ kind: "guest" });
    guestId = me.id;
    expect((await inviter.client.get("/me/account")).body.referral.invited).toEqual([expect.objectContaining({ displayName: "Gina Guest", credited: false })]);
    // Signing up alone earns nothing.
    expect(await wallet(inviter.client)).toBe(0);
  });
});

describe("guest fees", () => {
  it("guest pays ₦5,000 to confirm a match day; the inviter gets ₦500 once", async () => {
    const dayId = await openDay();
    const ci = await guest.post(`/matchdays/${dayId}/checkin`);
    expect(ci.body.me).toMatchObject({ registrationStatus: "pending", feeStatus: "unpaid", feeAmount: 5000 });
    // Admins can't see unpaid guests in the team pool.
    const gen = await admin.post(`/matchdays/${dayId}/teams/generate`, { mode: "random", setCount: 2, teamSize: 1, seed: 1 });
    expect(gen.status).toBe(422);
    const co = await guest.post(`/matchdays/${dayId}/guest-fee/checkout`, {});
    expect(co.body).toMatchObject({ completed: false, external: 5000, wallet: 0 });
    expect((await pay(guest, co)).body.payment).toMatchObject({ status: "succeeded", purpose: "guest_fee", matchDay: { registrationStatus: "confirmed" } });
    expect((await guest.get(`/matchdays/${dayId}`)).body.me).toMatchObject({ registrationStatus: "confirmed", feeStatus: "paid" });
    expect(await wallet(inviter.client)).toBe(500);
    // Paying again (next day) doesn't credit again.
    const day2 = await openDay();
    await guest.post(`/matchdays/${day2}/checkin`);
    await pay(guest, await guest.post(`/matchdays/${day2}/guest-fee/checkout`, {}));
    expect(await wallet(inviter.client)).toBe(500);
    expect((await inviter.client.get("/me/account")).body.referral.invited[0].credited).toBe(true);
  });

  it("is free after 5 paid match days in the season", async () => {
    // Gina has paid 2 days. Pay 3 more.
    for (let i = 0; i < 3; i++) {
      const d = await openDay();
      await guest.post(`/matchdays/${d}/checkin`);
      await pay(guest, await guest.post(`/matchdays/${d}/guest-fee/checkout`, {}));
    }
    const sixth = await openDay();
    const ci = await guest.post(`/matchdays/${sixth}/checkin`);
    expect(ci.body.me).toMatchObject({ registrationStatus: "confirmed", feeStatus: "free", feeAmount: 0 });
    expect((await guest.post(`/matchdays/${sixth}/guest-fee/checkout`, {})).status).toBe(409);
  });

  it("admins can mark a guest fee paid in cash or waive it (with a reason)", async () => {
    const g = await createPlayer(admin, "Cash Carl", { login: true, kind: "guest" });
    const d = await openDay();
    await g.client!.post(`/matchdays/${d}/checkin`);
    const reg = (await admin.get(`/matchdays/${d}`)).body.registrations.find((r: any) => r.playerId === g.playerId);
    expect(reg).toMatchObject({ status: "pending", feeStatus: "unpaid" });
    expect((await g.client!.post(`/registrations/${reg.id}/fee/mark-paid`, {})).status).toBe(403);
    expect((await admin.post(`/registrations/${reg.id}/fee/waive`, {})).status).toBe(422);
    expect((await admin.post(`/registrations/${reg.id}/fee/mark-paid`, {})).status).toBe(200);
    expect((await admin.get(`/matchdays/${d}`)).body.registrations.find((r: any) => r.id === reg.id)).toMatchObject({ status: "confirmed", feeStatus: "paid" });
  });

  it("members pay nothing per match day", async () => {
    const d = await openDay();
    const ci = await inviter.client.post(`/matchdays/${d}/checkin`);
    expect(ci.body.me).toMatchObject({ registrationStatus: "confirmed", feeStatus: "none" });
  });
});

describe("membership", () => {
  it("paying membership (with wallet credit applied first) makes a guest a member for 6 months", async () => {
    // Give Gina some wallet credit via an admin adjustment, then pay.
    await admin.post(`/players/${guestId}/wallet/adjust`, { amount: 1500, note: "Welcome bonus" });
    const co = await guest.post("/membership/checkout", { useWallet: true });
    expect(co.body).toMatchObject({ completed: false, wallet: 1500, external: 98500 });
    const res = await pay(guest, co);
    expect(res.body.payment).toMatchObject({ status: "succeeded", purpose: "membership", total: 100000, walletAmount: 1500 });
    const acct = (await guest.get("/me/account")).body;
    const today = todayInZone("Africa/Lagos");
    expect(acct.membership).toMatchObject({ kind: "member", status: "current", paidUntil: addDays(addMonthsClamped(today, 6), -1) });
    expect(acct.wallet.balance).toBe(0);
    expect((await guest.get("/me")).body.player.kind).toBe("member");
  });

  it("refuses to complete if the wallet was spent in the meantime (never goes negative)", async () => {
    await admin.post(`/players/${guestId}/wallet/adjust`, { amount: 1000, note: "Bonus" });
    const co = await guest.post("/membership/checkout", { useWallet: true });
    expect(co.body.wallet).toBe(1000);
    await admin.post(`/players/${guestId}/wallet/adjust`, { amount: -1000, note: "Reversal" });
    expect((await pay(guest, co)).status).toBe(409);
    expect(await wallet(guest)).toBe(0);
    expect((await admin.post(`/players/${guestId}/wallet/adjust`, { amount: -1, note: "Overdraw" })).status).toBe(409);
  });

  it("renewal extends from the current expiry, not from today", async () => {
    const before = (await guest.get("/me/account")).body.membership.paidUntil;
    await pay(guest, await guest.post("/membership/checkout", { useWallet: false }));
    const after = (await guest.get("/me/account")).body.membership.paidUntil;
    expect(after).toBe(addDays(addMonthsClamped(addDays(before, 1), 6), -1));
  });

  it("admins can mark membership paid in cash", async () => {
    const g = await createPlayer(admin, "Walk-in Wura", { kind: "guest" });
    const res = await admin.post(`/players/${g.playerId}/membership/mark-paid`, {});
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT kind, membership_paid_until FROM players WHERE id = ?").bind(g.playerId).first<{ kind: string; membership_paid_until: string }>();
    expect(row!.kind).toBe("member");
    expect((await inviter.client.post(`/players/${g.playerId}/membership/mark-paid`, {})).status).toBe(403);
  });
});

describe("wallet for card relief", () => {
  it("pays a fine entirely from wallet credit, instantly and only once", async () => {
    const d = await openDay();
    const others = [];
    for (let i = 0; i < 3; i++) others.push(await createPlayer(admin, `Wallet Team ${i}`, { login: true }));
    for (const o of others) await o.client!.post(`/matchdays/${d}/checkin`);
    await inviter.client.post(`/matchdays/${d}/checkin`);
    const gen = await admin.post(`/matchdays/${d}/teams/generate`, { mode: "random", setCount: 2, teamSize: 2, seed: 2 });
    await admin.post(`/matchdays/${d}/teams/publish`, { sets: gen.body.sets.map((s: any) => ({ idx: s.idx, players: s.players.map((p: any) => ({ playerId: p.playerId })) })) });
    await admin.post(`/matchdays/${d}/start`);
    const card = (await admin.post(`/matchdays/${d}/cards`, { playerId: inviter.playerId, color: "yellow" })).body.card;
    await admin.post(`/players/${inviter.playerId}/wallet/adjust`, { amount: 1500, note: "Top-up for test" }); // 500 referral + 1500 = 2000
    expect(await wallet(inviter.client)).toBe(2000);
    const [a, b] = await Promise.all([
      inviter.client.post("/fines/checkout", { cardIds: [card.id], useWallet: true }),
      inviter.client.post("/fines/checkout", { cardIds: [card.id], useWallet: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await wallet(inviter.client)).toBe(0);
    const fines = (await inviter.client.get("/me/fines")).body;
    expect(fines.cards.find((k: any) => k.id === card.id)).toMatchObject({ fineStatus: "paid", paidVia: "wallet" });
  });
});

describe("finance includes guest fees and memberships", () => {
  it("counts cash income and shows wallet redemptions separately", async () => {
    const f = (await admin.get("/admin/finance")).body;
    expect(f.totals.guestFeeIncome).toBe(5 * 5000 + 5000); // Gina's 5 online + Carl's cash
    expect(f.totals.membershipIncome).toBe(98500 + 100000 + 100000);
    expect(f.totals.walletRedeemed).toBe(1500 + 2000);
    expect(f.totals.fineIncome).toBe(0); // the fine was paid from wallet
    expect(f.memberships.length).toBe(3);
  });
});

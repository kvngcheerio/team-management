import { beforeAll, describe, expect, it } from "vitest";
import { Client, createPlayer, createSeason, PASSWORD, setupAdmin } from "./helpers";

let admin: Client;
let inviter: { playerId: string; client: Client };
let guest: Client;

beforeAll(async () => {
  ({ admin } = await setupAdmin());
  await createSeason(admin);
  const p = await createPlayer(admin, "Inviter Ola", { login: true });
  inviter = { playerId: p.playerId, client: p.client! };
  const code = (await inviter.client.get("/me/account")).body.referral.url.split("/r/")[1];
  guest = new Client();
  await guest.post(`/public/r/${code}`, { name: "Transfer Tolu", email: "tolu@example.com", password: PASSWORD });
});

describe("bank transfer payments (default until Paystack)", () => {
  it("shows the group's bank details and a reference at checkout", async () => {
    const acct = (await guest.get("/me/account")).body;
    expect(acct.paymentMode).toBe("transfer");
    expect(acct.bank).toEqual({ bankName: "GTBank", accountNumber: "0160720733", accountName: "Onyekachi Edmond" });
    const co = await guest.post("/membership/checkout", {});
    expect(co.status).toBe(201);
    const pay = (await guest.get(`/payments/${co.body.paymentId}`)).body.payment;
    expect(pay).toMatchObject({ provider: "bank_transfer", status: "pending", amount: 100000, bank: { accountNumber: "0160720733" } });
    expect(pay.reference).toMatch(/^TA-[A-Z0-9]{6,}$/);
    // The simulator is disabled for transfers.
    expect((await guest.post(`/payments/${co.body.paymentId}/simulate`, { outcome: "success" })).status).toBe(409);
  });

  it("player submits, admin confirms: membership granted and inviter credited once", async () => {
    const co = await guest.post("/membership/checkout", {});
    const id = co.body.paymentId;
    expect((await guest.post(`/payments/${id}/submit`, {})).body.payment.status).toBe("submitted");
    // Not a member until confirmed.
    expect((await guest.get("/me")).body.player.kind).toBe("guest");
    const queue = (await admin.get("/admin/payments?status=submitted")).body.payments;
    expect(queue.map((q: any) => q.id)).toContain(id);
    expect(queue.find((q: any) => q.id === id)).toMatchObject({ displayName: "Transfer Tolu", purpose: "membership", amount: 100000 });
    expect((await admin.get("/dashboard")).body.pendingTransfers).toBe(1);
    // Members can't confirm.
    expect((await inviter.client.post(`/admin/payments/${id}/confirm`, {})).status).toBe(403);
    const [a, b] = await Promise.all([admin.post(`/admin/payments/${id}/confirm`, {}), admin.post(`/admin/payments/${id}/confirm`, {})]);
    expect([a.status, b.status].every((s) => s === 200)).toBe(true);
    expect((await guest.get("/me")).body.player.kind).toBe("member");
    expect((await inviter.client.get("/me/account")).body.wallet.balance).toBe(500);
    const fin = (await admin.get("/admin/finance")).body;
    expect(fin.totals.membershipIncome).toBe(100000);
  });

  it("admin can reject a transfer with a reason the player sees", async () => {
    const co = await guest.post("/membership/checkout", {});
    const id = co.body.paymentId;
    await guest.post(`/payments/${id}/submit`, {});
    expect((await admin.post(`/admin/payments/${id}/reject`, {})).status).toBe(422);
    expect((await admin.post(`/admin/payments/${id}/reject`, { reason: "No transfer received with this reference" })).status).toBe(200);
    const acct = (await guest.get("/me/account")).body;
    expect(acct.transfers.find((t: any) => t.id === id)).toMatchObject({ status: "failed", reviewNote: "No transfer received with this reference" });
    expect((await admin.post(`/admin/payments/${id}/confirm`, {})).status).toBe(409);
  });

  it("bank details are admin-editable", async () => {
    expect((await admin.put("/admin/settings", { bank_account_number: "12ab" })).status).toBe(422);
    await admin.put("/admin/settings", { bank_name: "Access Bank" });
    expect((await guest.get("/me/account")).body.bank.bankName).toBe("Access Bank");
  });
});

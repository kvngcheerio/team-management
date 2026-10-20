import { Hono } from "hono";
import { z } from "zod";
import { applyWallet, nextMembershipPeriod, renewalStatus } from "../../shared/rules";
import { todayInZone } from "../../shared/time";
import type { AppEnv, Ctx } from "../env";
import { accessSettings, myPlayerRow, referralCode, referralCreditStatement, walletBalance, walletDebitStatements } from "../lib/access";
import { randomToken } from "../lib/crypto";
import { all, atomic, auditStmt, first, getSetting, guard, HttpError, newId, nowIso, stmt } from "../lib/db";
import { isAdmin, requireAdmin, requireUser } from "../lib/guards";
import { body, zId, zReason } from "../lib/validate";
import { cardShape, type CardRow } from "./discipline";

/**
 * Payments for fines, membership and guest fees, with a DUMMY provider (Paystack later).
 *
 * Flow: checkout computes the amount on the server and applies wallet credit first. If wallet covers
 * everything, it completes immediately. Otherwise a pending payment is created and the (simulated)
 * provider confirms it; completion is one atomic batch that marks items paid, debits the wallet
 * (guarded so it can't go negative), credits the referrer once, and records the audit entry.
 */
export const paymentRoutes = new Hono<AppEnv>();

type Purpose = "fines" | "membership" | "guest_fee";

interface PaymentRow {
  id: string;
  player_id: string;
  user_id: string | null;
  amount: number;
  wallet_amount: number;
  currency: string;
  provider: string;
  status: "pending" | "submitted" | "succeeded" | "failed" | "cancelled";
  reference: string;
  submitted_at: string | null;
  review_note: string | null;
  card_ids: string;
  purpose: Purpose;
  registration_id: string | null;
  created_at: string;
  completed_at: string | null;
}

const CAPACITY_CASE = `CASE WHEN (SELECT COUNT(*) FROM registrations x WHERE x.match_day_id = registrations.match_day_id AND x.status = 'confirmed')
  < (SELECT capacity FROM match_days WHERE id = registrations.match_day_id) THEN 'confirmed' ELSE 'waitlist' END`;

async function tz(db: D1Database) {
  return getSetting(db, "timezone", "Africa/Lagos");
}

async function requirePlayer(c: Ctx) {
  const p = await myPlayerRow(c);
  if (!p) throw new HttpError(409, "Your login isn't linked to a player.");
  return p;
}

// ---------------------------------------------------------------------------
// Completion statements per purpose (shared by wallet-only and provider-confirmed paths)
// ---------------------------------------------------------------------------

interface Completion {
  purpose: Purpose;
  playerId: string;
  paymentId: string | null;
  external: number;
  wallet: number;
  cardIds?: string[];
  registrationId?: string;
}

async function completionStatements(c: Ctx, x: Completion): Promise<D1PreparedStatement[]> {
  const db = c.env.DB;
  const now = nowIso();
  const out: D1PreparedStatement[] = [];
  const via = x.external > 0 ? "online" : "wallet";
  if (x.purpose === "fines") {
    out.push(
      stmt(
        db,
        `UPDATE cards SET fine_status = 'paid', paid_via = ?, payment_id = ?, paid_at = ?
          WHERE id IN (SELECT value FROM json_each(?)) AND player_id = ? AND fine_status = 'unpaid' AND voided_at IS NULL`,
        via,
        x.paymentId,
        now,
        JSON.stringify(x.cardIds),
        x.playerId,
      ),
      // Every fine must flip, or nothing does.
      stmt(db, "INSERT INTO _batch_guard (ok) VALUES (CASE WHEN changes() = ? THEN 1 ELSE 0 END)", x.cardIds!.length),
    );
    if (x.wallet > 0) out.push(...walletDebitStatements(db, x.playerId, x.wallet, "fine_relief", `fines:${x.paymentId ?? [...x.cardIds!].sort().join(",")}`, "Card fine relief"));
  }
  if (x.purpose === "membership") {
    const s = await accessSettings(db);
    const p = (await first<{ membership_paid_until: string | null }>(db, "SELECT membership_paid_until FROM players WHERE id = ?", x.playerId))!;
    const period = nextMembershipPeriod(p.membership_paid_until, todayInZone(await tz(db)), s.membershipMonths);
    out.push(
      stmt(
        db,
        `INSERT INTO membership_payments (id, player_id, amount, wallet_amount, paid_via, period_start, period_end, payment_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        x.playerId,
        x.external + x.wallet,
        x.wallet,
        via,
        period.start,
        period.end,
        x.paymentId,
        now,
      ),
      stmt(
        db,
        `UPDATE players SET kind = 'member', member_since = COALESCE(member_since, ?), membership_paid_until = ?, updated_at = ? WHERE id = ?`,
        now,
        period.end,
        now,
        x.playerId,
      ),
    );
    // The ref includes the period start, so a double-submitted wallet renewal can't buy the same period twice.
    if (x.wallet > 0) out.push(...walletDebitStatements(db, x.playerId, x.wallet, "renewal", `renewal:${x.playerId}:${period.start}`, `Membership ${period.start} → ${period.end}`));
  }
  if (x.purpose === "guest_fee") {
    out.push(
      stmt(
        db,
        `UPDATE registrations SET fee_status = 'paid', fee_paid_via = 'online', fee_payment_id = ?, fee_paid_at = ?, updated_at = ?,
            status = CASE WHEN status = 'pending' THEN ${CAPACITY_CASE} ELSE status END
          WHERE id = ? AND player_id = ? AND fee_status = 'unpaid'`,
        x.paymentId,
        now,
        now,
        x.registrationId,
        x.playerId,
      ),
      guard(db),
    );
  }
  out.push(await referralCreditStatement(db, x.playerId));
  return out;
}

// ---------------------------------------------------------------------------
// Checkouts
// ---------------------------------------------------------------------------

async function startCheckout(c: Ctx, x: Omit<Completion, "paymentId" | "external" | "wallet">, total: number, useWallet: boolean) {
  const db = c.env.DB;
  if (total <= 0) throw new HttpError(422, "Nothing to pay.");
  const { wallet, external } = applyWallet(total, useWallet ? await walletBalance(db, x.playerId) : 0, useWallet);
  if (external === 0) {
    // Fully covered by wallet credit: complete now.
    await atomic(db, [
      ...(await completionStatements(c, { ...x, paymentId: null, external: 0, wallet })),
      auditStmt(c, { action: `payment.${x.purpose}.wallet`, entityType: "player", entityId: x.playerId, after: { wallet } }),
    ], "That was already paid, or your wallet balance changed. Refresh and try again.");
    return { completed: true as const, wallet, external: 0 };
  }
  const id = newId();
  const transfer = (await getSetting(db, "payment_mode", "transfer")) !== "test";
  // Short, typeable reference for the bank transfer narration.
  const reference = transfer ? `TA-${randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, "7")}` : `TEST-${randomToken(9).toUpperCase()}`;
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO payments (id, player_id, user_id, amount, wallet_amount, currency, provider, status, reference, card_ids, purpose, registration_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      id,
      x.playerId,
      c.get("user")!.id,
      external,
      wallet,
      (await accessSettings(db)).currency,
      transfer ? "bank_transfer" : "dummy",
      reference,
      JSON.stringify(x.cardIds ?? []),
      x.purpose,
      x.registrationId ?? null,
      nowIso(),
    ),
  ]);
  return { completed: false as const, paymentId: id, wallet, external };
}

paymentRoutes.post("/fines/checkout", requireUser, async (c) => {
  const input = await body(c, z.object({ cardIds: z.array(zId).min(1).max(50), useWallet: z.boolean().default(false) }));
  const db = c.env.DB;
  const me = await requirePlayer(c);
  const ids = [...new Set(input.cardIds)];
  const cards = await all<CardRow>(
    db,
    "SELECT * FROM cards WHERE id IN (SELECT value FROM json_each(?)) AND player_id = ? AND fine_status = 'unpaid' AND voided_at IS NULL",
    JSON.stringify(ids),
    me.id,
  );
  if (cards.length !== ids.length) throw new HttpError(409, "Some of those fines are already settled or aren't yours. Refresh and try again.");
  const total = cards.reduce((s, k) => s + k.fine_amount, 0);
  return c.json(await startCheckout(c, { purpose: "fines", playerId: me.id, cardIds: ids }, total, input.useWallet), 201);
});

paymentRoutes.post("/membership/checkout", requireUser, async (c) => {
  const input = await body(c, z.object({ useWallet: z.boolean().default(false) }));
  const me = await requirePlayer(c);
  const s = await accessSettings(c.env.DB);
  return c.json(await startCheckout(c, { purpose: "membership", playerId: me.id }, s.membershipFee, input.useWallet), 201);
});

/** Guests pay the per-match-day fee to confirm their place (wallet credit can't be used for this). */
paymentRoutes.post("/matchdays/:id/guest-fee/checkout", requireUser, async (c) => {
  const db = c.env.DB;
  const me = await requirePlayer(c);
  const reg = await first<{ id: string; status: string; fee_status: string; fee_amount: number; day_status: string }>(
    db,
    `SELECT r.id, r.status, r.fee_status, r.fee_amount, md.status AS day_status FROM registrations r JOIN match_days md ON md.id = r.match_day_id
      WHERE r.match_day_id = ? AND r.player_id = ?`,
    c.req.param("id"),
    me.id,
  );
  if (!reg || reg.fee_status !== "unpaid") throw new HttpError(409, "There's no guest fee to pay for this match day.");
  if (!["checkin_open", "locked", "in_progress"].includes(reg.day_status)) throw new HttpError(409, "This match day is closed.");
  if (reg.status === "pending") {
    const full = await first<{ full: number }>(
      db,
      "SELECT (SELECT COUNT(*) FROM registrations WHERE match_day_id = ? AND status = 'confirmed') >= (SELECT capacity FROM match_days WHERE id = ?) AS full",
      c.req.param("id"),
      c.req.param("id"),
    );
    if (full?.full) throw new HttpError(409, "The match day is full right now. You'll be able to pay if a place opens.");
  }
  return c.json(await startCheckout(c, { purpose: "guest_fee", playerId: me.id, registrationId: reg.id }, reg.fee_amount, false), 201);
});

// ---------------------------------------------------------------------------
// Payment page + simulated provider
// ---------------------------------------------------------------------------

async function loadPayment(c: Ctx, id: string) {
  const db = c.env.DB;
  const p = await first<PaymentRow>(db, "SELECT * FROM payments WHERE id = ?", id);
  if (!p) throw new HttpError(404, "Payment not found.");
  const me = await myPlayerRow(c);
  const mine = p.player_id === me?.id;
  if (!mine && !isAdmin(c)) throw new HttpError(404, "Payment not found.");
  return { p, mine };
}

async function paymentShape(c: Ctx, p: PaymentRow) {
  const db = c.env.DB;
  const cards =
    p.purpose === "fines"
      ? await all<CardRow>(db, "SELECT k.*, md.date FROM cards k JOIN match_days md ON md.id = k.match_day_id WHERE k.id IN (SELECT value FROM json_each(?))", p.card_ids)
      : [];
  const reg = p.registration_id
    ? await first<{ date: string; status: string }>(db, "SELECT md.date, r.status FROM registrations r JOIN match_days md ON md.id = r.match_day_id WHERE r.id = ?", p.registration_id)
    : null;
  const membership = p.purpose === "membership" ? await first<{ period_start: string; period_end: string }>(db, "SELECT period_start, period_end FROM membership_payments WHERE payment_id = ?", p.id) : null;
  return {
    id: p.id,
    purpose: p.purpose,
    amount: p.amount,
    walletAmount: p.wallet_amount,
    total: p.amount + p.wallet_amount,
    currency: p.currency,
    provider: p.provider,
    status: p.status,
    reference: p.reference,
    createdAt: p.created_at,
    completedAt: p.completed_at,
    cards: cards.map(cardShape),
    matchDay: reg ? { date: reg.date, registrationStatus: reg.status } : null,
    membership: membership ? { periodStart: membership.period_start, periodEnd: membership.period_end } : null,
    submittedAt: p.submitted_at,
    reviewNote: p.review_note,
    bank: p.provider === "bank_transfer" ? await bankDetails(db) : null,
  };
}

export async function bankDetails(db: D1Database) {
  const [bankName, accountNumber, accountName] = await Promise.all([
    getSetting(db, "bank_name", ""),
    getSetting(db, "bank_account_number", ""),
    getSetting(db, "bank_account_name", ""),
  ]);
  return { bankName, accountNumber, accountName };
}

/** Atomically mark a payment succeeded and apply its effects. Only one caller can win. */
async function completePayment(c: Ctx, p: PaymentRow, fromStatuses: string[], action: string) {
  const db = c.env.DB;
  const now = nowIso();
  await atomic(
    db,
    [
      stmt(
        db,
        `UPDATE payments SET status = 'succeeded', completed_at = ?, reviewed_by = ? WHERE id = ? AND status IN (SELECT value FROM json_each(?))`,
        now,
        action === "confirmed" ? c.get("user")!.id : null,
        p.id,
        JSON.stringify(fromStatuses),
      ),
      guard(db),
      ...(await completionStatements(c, {
        purpose: p.purpose,
        playerId: p.player_id,
        paymentId: p.id,
        external: p.amount,
        wallet: p.wallet_amount,
        cardIds: JSON.parse(p.card_ids),
        registrationId: p.registration_id ?? undefined,
      })),
      auditStmt(c, { action: `payment.${p.purpose}.${action}`, entityType: "payment", entityId: p.id, after: { amount: p.amount, wallet: p.wallet_amount, reference: p.reference, provider: p.provider } }),
    ],
    "Something changed since checkout started (already paid, waived, or wallet balance changed).",
  );
}

paymentRoutes.get("/payments/:id", requireUser, async (c) => {
  const { p } = await loadPayment(c, c.req.param("id"));
  return c.json({ payment: await paymentShape(c, p) });
});

paymentRoutes.post("/payments/:id/simulate", requireUser, async (c) => {
  const input = await body(c, z.object({ outcome: z.enum(["success", "failure", "cancel"]) }));
  const db = c.env.DB;
  const { p, mine } = await loadPayment(c, c.req.param("id"));
  if (!mine) throw new HttpError(403, "Only the player can complete their own payment.");
  if (p.status !== "pending") return c.json({ payment: await paymentShape(c, p) });
  if (p.provider !== "dummy" && input.outcome !== "cancel") throw new HttpError(409, "This is a bank transfer payment. Tap “I've made the transfer” once you've sent it.");
  const now = nowIso();
  if (input.outcome === "success") {
    try {
      await completePayment(c, p, ["pending"], "succeeded");
    } catch (err) {
      const fresh = await first<{ status: string }>(db, "SELECT status FROM payments WHERE id = ?", p.id);
      if (fresh?.status === "succeeded") return c.json({ payment: await paymentShape(c, (await loadPayment(c, p.id)).p) });
      await db.prepare("UPDATE payments SET status = 'cancelled', completed_at = ? WHERE id = ? AND status = 'pending'").bind(now, p.id).run();
      throw err;
    }
  } else {
    await atomic(db, [stmt(db, "UPDATE payments SET status = ?, completed_at = ? WHERE id = ? AND status = 'pending'", input.outcome === "failure" ? "failed" : "cancelled", now, p.id)]);
  }
  return c.json({ payment: await paymentShape(c, (await loadPayment(c, p.id)).p) });
});

/** The player says they've sent the bank transfer; an admin confirms it against the bank statement. */
paymentRoutes.post("/payments/:id/submit", requireUser, async (c) => {
  const db = c.env.DB;
  const { p, mine } = await loadPayment(c, c.req.param("id"));
  if (!mine) throw new HttpError(403, "Only the player can submit their own payment.");
  if (p.provider !== "bank_transfer") throw new HttpError(409, "This payment isn't a bank transfer.");
  if (p.status === "pending") {
    await atomic(db, [
      stmt(db, "UPDATE payments SET status = 'submitted', submitted_at = ? WHERE id = ? AND status = 'pending'", nowIso(), p.id),
      auditStmt(c, { action: `payment.${p.purpose}.transfer_submitted`, entityType: "payment", entityId: p.id, after: { amount: p.amount, reference: p.reference } }),
    ]);
  }
  return c.json({ payment: await paymentShape(c, (await loadPayment(c, p.id)).p) });
});

paymentRoutes.get("/admin/payments", requireAdmin, async (c) => {
  const status = c.req.query("status") ?? "submitted";
  const rows = await all<PaymentRow & { display_name: string }>(
    c.env.DB,
    `SELECT pay.*, p.display_name FROM payments pay JOIN players p ON p.id = pay.player_id
      WHERE (?1 = 'all' OR pay.status = ?1) ORDER BY COALESCE(pay.submitted_at, pay.created_at) DESC LIMIT 200`,
    status,
  );
  return c.json({
    payments: await Promise.all(rows.map(async (r) => ({ ...(await paymentShape(c, r)), playerId: r.player_id, displayName: r.display_name }))),
  });
});

paymentRoutes.post("/admin/payments/:id/confirm", requireAdmin, async (c) => {
  const db = c.env.DB;
  const { p } = await loadPayment(c, c.req.param("id"));
  if (p.status === "succeeded") return c.json({ payment: await paymentShape(c, p) });
  if (p.status !== "submitted" && p.status !== "pending") throw new HttpError(409, `This payment is ${p.status}.`);
  try {
    await completePayment(c, p, ["submitted", "pending"], "confirmed");
  } catch (err) {
    const fresh = await first<{ status: string }>(db, "SELECT status FROM payments WHERE id = ?", p.id);
    if (fresh?.status !== "succeeded") throw err;
  }
  return c.json({ payment: await paymentShape(c, (await loadPayment(c, p.id)).p) });
});

paymentRoutes.post("/admin/payments/:id/reject", requireAdmin, async (c) => {
  const input = await body(c, z.object({ reason: zReason }));
  if (!input.reason || input.reason.length < 3) throw new HttpError(422, "Give a reason (the player will see it).");
  const db = c.env.DB;
  const { p } = await loadPayment(c, c.req.param("id"));
  await atomic(
    db,
    [
      stmt(db, "UPDATE payments SET status = 'failed', completed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status IN ('pending', 'submitted')", nowIso(), c.get("user")!.id, input.reason, p.id),
      guard(db),
      auditStmt(c, { action: `payment.${p.purpose}.rejected`, entityType: "payment", entityId: p.id, reason: input.reason }),
    ],
    "This payment was already reviewed.",
  );
  return c.json({ payment: await paymentShape(c, (await loadPayment(c, p.id)).p) });
});

// ---------------------------------------------------------------------------
// My account: membership, wallet, referrals, guest fees owed
// ---------------------------------------------------------------------------

paymentRoutes.get("/me/account", requireUser, async (c) => {
  const db = c.env.DB;
  const me = await requirePlayer(c);
  const s = await accessSettings(db);
  const today = todayInZone(await tz(db));
  const [balance, txns, invited, owed, history] = await Promise.all([
    walletBalance(db, me.id),
    all(db, "SELECT amount, kind, note, created_at AS createdAt FROM wallet_transactions WHERE player_id = ? ORDER BY created_at DESC LIMIT 30", me.id),
    all<{ id: string; display_name: string; kind: string; credited: number }>(
      db,
      `SELECT p.id, p.display_name, p.kind, EXISTS (SELECT 1 FROM wallet_transactions w WHERE w.ref = 'referral:' || p.id) AS credited
         FROM players p WHERE p.referred_by = ? ORDER BY p.created_at DESC`,
      me.id,
    ),
    all<{ registration_id: string; match_day_id: string; date: string; fee_amount: number; status: string }>(
      db,
      `SELECT r.id AS registration_id, r.match_day_id, md.date, r.fee_amount, r.status FROM registrations r JOIN match_days md ON md.id = r.match_day_id
        WHERE r.player_id = ? AND r.fee_status = 'unpaid' AND md.status IN ('checkin_open', 'locked', 'in_progress') ORDER BY md.date`,
      me.id,
    ),
    all(db, "SELECT amount, wallet_amount AS walletAmount, paid_via AS paidVia, period_start AS periodStart, period_end AS periodEnd, created_at AS createdAt FROM membership_payments WHERE player_id = ? AND voided_at IS NULL ORDER BY created_at DESC LIMIT 10", me.id),
  ]);
  const origin = c.env.BETTER_AUTH_URL || new URL(c.req.url).origin;
  const awaiting = await all<{ id: string; purpose: string; amount: number; reference: string; status: string; review_note: string | null }>(
    db,
    "SELECT id, purpose, amount, reference, status, review_note FROM payments WHERE player_id = ? AND provider = 'bank_transfer' AND status IN ('pending', 'submitted', 'failed') ORDER BY created_at DESC LIMIT 10",
    me.id,
  );
  return c.json({
    paymentMode: await getSetting(db, "payment_mode", "transfer"),
    bank: await bankDetails(db),
    transfers: awaiting.map((a) => ({ id: a.id, purpose: a.purpose, amount: a.amount, reference: a.reference, status: a.status, reviewNote: a.review_note })),
    currency: s.currency,
    fees: { membership: s.membershipFee, membershipMonths: s.membershipMonths, guest: s.guestFee, guestFreeAfter: s.guestFreeAfter, referralCredit: s.referralCredit },
    membership: {
      kind: me.kind,
      paidUntil: me.membership_paid_until,
      status: renewalStatus(me.kind, me.membership_paid_until, today),
      next: nextMembershipPeriod(me.membership_paid_until, today, s.membershipMonths),
      history,
    },
    wallet: { balance, transactions: txns },
    referral: {
      url: `${origin}/r/${await referralCode(db, me.id)}`,
      invited: invited.map((i) => ({ playerId: i.id, displayName: i.display_name, kind: i.kind, credited: i.credited === 1 })),
    },
    guestFeesOwed: owed.map((o) => ({ registrationId: o.registration_id, matchDayId: o.match_day_id, date: o.date, amount: o.fee_amount, status: o.status })),
  });
});

// ---------------------------------------------------------------------------
// Admin: mark paid (cash), waive guest fees, wallet adjustments, membership overview
// ---------------------------------------------------------------------------

paymentRoutes.post("/players/:id/membership/mark-paid", requireAdmin, async (c) => {
  const input = await body(c, z.object({ amount: z.number().int().min(0).max(10_000_000).optional() }));
  const db = c.env.DB;
  const p = await first<{ id: string; display_name: string; membership_paid_until: string | null; kind: string }>(db, "SELECT id, display_name, membership_paid_until, kind FROM players WHERE id = ?", c.req.param("id"));
  if (!p) throw new HttpError(404, "Player not found.");
  const s = await accessSettings(db);
  const amount = input.amount ?? s.membershipFee;
  const period = nextMembershipPeriod(p.membership_paid_until, todayInZone(await tz(db)), s.membershipMonths);
  const now = nowIso();
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO membership_payments (id, player_id, amount, wallet_amount, paid_via, period_start, period_end, recorded_by, created_at) VALUES (?, ?, ?, 0, 'cash', ?, ?, ?, ?)`,
      newId(),
      p.id,
      amount,
      period.start,
      period.end,
      c.get("user")!.id,
      now,
    ),
    stmt(db, "UPDATE players SET kind = 'member', member_since = COALESCE(member_since, ?), membership_paid_until = ?, updated_at = ? WHERE id = ?", now, period.end, now, p.id),
    await referralCreditStatement(db, p.id),
    auditStmt(c, { action: "membership.mark_paid", entityType: "player", entityId: p.id, before: { kind: p.kind, paidUntil: p.membership_paid_until }, after: { amount, ...period } }),
  ]);
  return c.json({ ok: true, period });
});

paymentRoutes.post("/registrations/:id/fee/:action{mark-paid|waive}", requireAdmin, async (c) => {
  const action = c.req.param("action");
  const input = await body(c, z.object({ reason: zReason }));
  if (action === "waive" && (!input.reason || input.reason.length < 3)) throw new HttpError(422, "Give a reason for waiving the guest fee.");
  const db = c.env.DB;
  const reg = await first<{ id: string; player_id: string; match_day_id: string; fee_status: string; fee_amount: number }>(db, "SELECT id, player_id, match_day_id, fee_status, fee_amount FROM registrations WHERE id = ?", c.req.param("id"));
  if (!reg) throw new HttpError(404, "Registration not found.");
  if (reg.fee_status !== "unpaid") throw new HttpError(409, "There's no unpaid guest fee on this registration.");
  const now = nowIso();
  const statements = [
    stmt(
      db,
      `UPDATE registrations SET fee_status = ?, fee_paid_via = ?, fee_paid_at = ?, updated_at = ?,
          status = CASE WHEN status = 'pending' THEN ${CAPACITY_CASE} ELSE status END
        WHERE id = ? AND fee_status = 'unpaid'`,
      action === "waive" ? "waived" : "paid",
      action === "waive" ? null : "cash",
      action === "waive" ? null : now,
      now,
      reg.id,
    ),
    guard(db),
    auditStmt(c, { action: `guest_fee.${action}`, entityType: "registration", entityId: reg.id, matchDayId: reg.match_day_id, reason: input.reason, after: { amount: reg.fee_amount } }),
  ];
  if (action === "mark-paid") statements.push(await referralCreditStatement(db, reg.player_id));
  await atomic(db, statements);
  return c.json({ ok: true });
});

paymentRoutes.post("/players/:id/wallet/adjust", requireAdmin, async (c) => {
  const input = await body(c, z.object({ amount: z.number().int().refine((n) => n !== 0, "Amount can't be zero").refine((n) => Math.abs(n) <= 1_000_000), note: z.string().trim().min(3).max(200) }));
  const db = c.env.DB;
  const playerId = c.req.param("id");
  const statements: D1PreparedStatement[] = [];
  if (input.amount < 0) {
    statements.push(stmt(db, "INSERT INTO _batch_guard (ok) VALUES (CASE WHEN (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE player_id = ?) >= ? THEN 1 ELSE 0 END)", playerId, -input.amount));
  }
  statements.push(
    stmt(db, "INSERT INTO wallet_transactions (id, player_id, amount, kind, note, created_by, created_at) VALUES (?, ?, ?, 'adjustment', ?, ?, ?)", newId(), playerId, input.amount, input.note, c.get("user")!.id, nowIso()),
    auditStmt(c, { action: "wallet.adjust", entityType: "player", entityId: playerId, after: input }),
  );
  await atomic(db, statements, "The wallet doesn't have enough credit for that deduction.");
  return c.json({ ok: true, balance: await walletBalance(db, playerId) });
});

paymentRoutes.get("/admin/memberships", requireAdmin, async (c) => {
  const db = c.env.DB;
  const today = todayInZone(await tz(db));
  const rows = await all<{ id: string; display_name: string; kind: "member" | "guest"; membership_paid_until: string | null; wallet: number; referrer: string | null; has_account: number }>(
    db,
    `SELECT p.id, p.display_name, p.kind, p.membership_paid_until, p.user_id IS NOT NULL AS has_account,
            (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions w WHERE w.player_id = p.id) AS wallet,
            (SELECT r.display_name FROM players r WHERE r.id = p.referred_by) AS referrer
       FROM players p WHERE p.active = 1 ORDER BY p.kind DESC, p.display_name COLLATE NOCASE`,
  );
  return c.json({
    settings: await accessSettings(db),
    players: rows.map((r) => ({
      playerId: r.id,
      displayName: r.display_name,
      kind: r.kind,
      paidUntil: r.membership_paid_until,
      status: renewalStatus(r.kind, r.membership_paid_until, today),
      wallet: r.wallet,
      referredBy: r.referrer,
      hasAccount: r.has_account === 1,
    })),
  });
});

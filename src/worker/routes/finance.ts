import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, atomic, auditStmt, first, getSetting, guard, HttpError, newId, nowIso, stmt } from "../lib/db";
import { requireAdmin } from "../lib/guards";
import { body, zDate, zReason } from "../lib/validate";

/** Admin finance: payments received (fines), recorded expenditures and other income, and the balance. */
export const financeRoutes = new Hono<AppEnv>();
financeRoutes.use("/admin/finance/*", requireAdmin);
financeRoutes.use("/admin/finance", requireAdmin);

export const EXPENSE_CATEGORIES = ["Pitch hire", "Balls & equipment", "Kits & bibs", "Refreshments", "First aid", "Transport", "Other"] as const;
export const INCOME_CATEGORIES = ["Match fees", "Donation", "Sponsorship", "Other"] as const;

financeRoutes.get("/admin/finance", async (c) => {
  const db = c.env.DB;
  const from = c.req.query("from") || "0000-01-01";
  const to = c.req.query("to") || "9999-12-31";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new HttpError(422, "Dates must be YYYY-MM-DD.");
  const tz = await getSetting(db, "timezone", "Africa/Lagos");
  // Fine payments, dated by when they were paid (in the group's timezone, approximated by date of paid_at).
  const [fines, entries, guestFees, memberships] = await Promise.all([
    all<{ id: string; paid_at: string; color: string; fine_amount: number; paid_via: string; display_name: string; player_id: string; reference: string | null }>(
      db,
      `SELECT k.id, k.paid_at, k.color, k.fine_amount, k.paid_via, p.display_name, p.id AS player_id, pay.reference
         FROM cards k JOIN players p ON p.id = k.player_id LEFT JOIN payments pay ON pay.id = k.payment_id
        WHERE k.fine_status = 'paid' AND k.voided_at IS NULL AND substr(k.paid_at, 1, 10) BETWEEN ? AND ?
        ORDER BY k.paid_at DESC`,
      from,
      to,
    ),
    all<{ id: string; kind: "expense" | "income"; entry_date: string; category: string; description: string; amount: number; created_by_name: string; voided_at: string | null; void_reason: string | null; created_at: string }>(
      db,
      "SELECT * FROM ledger_entries WHERE entry_date BETWEEN ? AND ? ORDER BY entry_date DESC, created_at DESC",
      from,
      to,
    ),
    all<{ id: string; paid_at: string; amount: number; via: string; display_name: string; player_id: string; date: string; reference: string | null }>(
      db,
      `SELECT r.id, r.fee_paid_at AS paid_at, r.fee_amount AS amount, r.fee_paid_via AS via, p.display_name, p.id AS player_id, md.date, pay.reference
         FROM registrations r JOIN players p ON p.id = r.player_id JOIN match_days md ON md.id = r.match_day_id LEFT JOIN payments pay ON pay.id = r.fee_payment_id
        WHERE r.fee_status = 'paid' AND r.fee_amount > 0 AND substr(r.fee_paid_at, 1, 10) BETWEEN ? AND ? ORDER BY r.fee_paid_at DESC`,
      from,
      to,
    ),
    all<{ id: string; created_at: string; amount: number; wallet_amount: number; paid_via: string; display_name: string; player_id: string; period_start: string; period_end: string; reference: string | null }>(
      db,
      `SELECT m.id, m.created_at, m.amount, m.wallet_amount, m.paid_via, p.display_name, p.id AS player_id, m.period_start, m.period_end, pay.reference
         FROM membership_payments m JOIN players p ON p.id = m.player_id LEFT JOIN payments pay ON pay.id = m.payment_id
        WHERE m.voided_at IS NULL AND substr(m.created_at, 1, 10) BETWEEN ? AND ? ORDER BY m.created_at DESC`,
      from,
      to,
    ),
  ]);
  const live = entries.filter((e) => !e.voided_at);
  // Cash income only: wallet-covered amounts are credit the group already issued, not new money.
  const fineIncome = fines.filter((f) => f.paid_via !== "wallet").reduce((s, f) => s + f.fine_amount, 0);
  const guestFeeIncome = guestFees.reduce((s, g) => s + g.amount, 0);
  const membershipIncome = memberships.reduce((s, m) => s + (m.amount - m.wallet_amount), 0);
  const walletRedeemed = fines.filter((f) => f.paid_via === "wallet").reduce((s, f) => s + f.fine_amount, 0) + memberships.reduce((s, m) => s + m.wallet_amount, 0);
  const otherIncome = live.filter((e) => e.kind === "income").reduce((s, e) => s + e.amount, 0);
  const expenses = live.filter((e) => e.kind === "expense").reduce((s, e) => s + e.amount, 0);
  const byCategory: Record<string, number> = {};
  for (const e of live.filter((x) => x.kind === "expense")) byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount;
  const outstanding = (await first<{ n: number }>(db, "SELECT COALESCE(SUM(fine_amount), 0) AS n FROM cards WHERE fine_status = 'unpaid' AND voided_at IS NULL"))?.n ?? 0;
  return c.json({
    currency: await getSetting(db, "currency", "NGN"),
    timezone: tz,
    range: { from: c.req.query("from") ?? null, to: c.req.query("to") ?? null },
    totals: {
      fineIncome,
      guestFeeIncome,
      membershipIncome,
      otherIncome,
      income: fineIncome + guestFeeIncome + membershipIncome + otherIncome,
      expenses,
      balance: fineIncome + guestFeeIncome + membershipIncome + otherIncome - expenses,
      outstandingFines: outstanding,
      walletRedeemed,
    },
    guestFees: guestFees.map((g) => ({ id: g.id, paidAt: g.paid_at, playerId: g.player_id, displayName: g.display_name, matchDate: g.date, amount: g.amount, method: g.via, reference: g.reference })),
    memberships: memberships.map((m) => ({
      id: m.id,
      paidAt: m.created_at,
      playerId: m.player_id,
      displayName: m.display_name,
      amount: m.amount,
      walletAmount: m.wallet_amount,
      method: m.paid_via,
      period: { start: m.period_start, end: m.period_end },
      reference: m.reference,
    })),
    expensesByCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    payments: fines.map((f) => ({
      cardId: f.id,
      paidAt: f.paid_at,
      playerId: f.player_id,
      displayName: f.display_name,
      color: f.color,
      amount: f.fine_amount,
      method: f.paid_via,
      reference: f.reference,
    })),
    entries: entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      date: e.entry_date,
      category: e.category,
      description: e.description,
      amount: e.amount,
      createdByName: e.created_by_name,
      voided: Boolean(e.voided_at),
      voidReason: e.void_reason,
      createdAt: e.created_at,
    })),
    categories: { expense: EXPENSE_CATEGORIES, income: INCOME_CATEGORIES },
  });
});

financeRoutes.post("/admin/finance/entries", async (c) => {
  const input = await body(
    c,
    z.object({
      kind: z.enum(["expense", "income"]),
      date: zDate,
      category: z.string().trim().min(1).max(40),
      description: z.string().trim().min(1, "Describe what it was for").max(200),
      amount: z.number().int("Whole naira only").positive("Amount must be more than 0").max(100_000_000),
    }),
  );
  const db = c.env.DB;
  const user = c.get("user")!;
  const id = newId();
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO ledger_entries (id, kind, entry_date, category, description, amount, created_by, created_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.date,
      input.category,
      input.description,
      input.amount,
      user.id,
      user.name,
      nowIso(),
    ),
    auditStmt(c, { action: `finance.${input.kind}`, entityType: "ledger_entry", entityId: id, after: input }),
  ]);
  return c.json({ ok: true, id }, 201);
});

/** Entries are never deleted; voiding keeps the record and the audit trail. */
financeRoutes.post("/admin/finance/entries/:id/void", async (c) => {
  const input = await body(c, z.object({ reason: zReason }));
  if (!input.reason || input.reason.length < 3) throw new HttpError(422, "Give a reason for voiding this entry.");
  const db = c.env.DB;
  const id = c.req.param("id");
  const entry = await first<{ amount: number; description: string }>(db, "SELECT amount, description FROM ledger_entries WHERE id = ?", id);
  if (!entry) throw new HttpError(404, "Entry not found.");
  await atomic(
    db,
    [
      stmt(db, "UPDATE ledger_entries SET voided_at = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL", nowIso(), input.reason, id),
      guard(db),
      auditStmt(c, { action: "finance.void", entityType: "ledger_entry", entityId: id, reason: input.reason, before: entry }),
    ],
    "This entry is already voided.",
  );
  return c.json({ ok: true });
});

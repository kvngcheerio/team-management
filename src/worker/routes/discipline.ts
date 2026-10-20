import { Hono } from "hono";
import { z } from "zod";
import { fineFor, type CardColor } from "../../shared/rules";
import type { AppEnv, Ctx } from "../env";
import { all, atomic, auditStmt, first, getSetting, HttpError, newId, nowIso, stmt } from "../lib/db";
import { requireAdmin, requireUser } from "../lib/guards";
import { loadDay } from "../lib/matchday";
import { body, zId, zReason } from "../lib/validate";

/**
 * Disciplinary cards and fines, with a DUMMY payment provider.
 *
 * The payment flow mirrors a real provider (create a pending payment → provider confirms → mark fines
 * paid atomically) so Paystack/Flutterwave can replace `provider = 'dummy'` later. No card details are
 * ever collected: the checkout page only offers "simulate success" / "simulate failure".
 */

export const disciplineRoutes = new Hono<AppEnv>();

export interface CardRow {
  id: string;
  match_day_id: string;
  match_id: string | null;
  player_id: string;
  color: CardColor;
  reason: string | null;
  fine_amount: number;
  fine_status: "unpaid" | "paid" | "waived";
  paid_via: "online" | "cash" | null;
  payment_id: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  display_name?: string;
  date?: string;
}

export const cardShape = (k: CardRow) => ({
  id: k.id,
  matchDayId: k.match_day_id,
  matchId: k.match_id,
  playerId: k.player_id,
  displayName: k.display_name,
  date: k.date,
  color: k.color,
  reason: k.reason,
  fineAmount: k.fine_amount,
  fineStatus: k.fine_status,
  paidVia: k.paid_via,
  paidAt: k.paid_at,
  voided: Boolean(k.voided_at),
  voidReason: k.void_reason,
  createdAt: k.created_at,
});

export async function fineSettings(db: D1Database) {
  const [yellow, red, currency] = await Promise.all([getSetting(db, "fine_yellow", "2000"), getSetting(db, "fine_red", "5000"), getSetting(db, "currency", "NGN")]);
  return { fines: { yellow: Number(yellow), red: Number(red) } as Record<CardColor, number>, currency };
}

async function loadCard(db: D1Database, id: string) {
  const k = await first<CardRow>(db, "SELECT * FROM cards WHERE id = ?", id);
  if (!k) throw new HttpError(404, "Card not found.");
  return k;
}

// ---------------------------------------------------------------------------
// Admin: give, void, waive, mark paid (cash)
// ---------------------------------------------------------------------------

disciplineRoutes.post("/matchdays/:id/cards", requireAdmin, async (c) => {
  const input = await body(
    c,
    z.object({ id: z.string().uuid().optional(), playerId: zId, color: z.enum(["yellow", "red"]), matchId: zId.nullable().optional(), reason: z.string().trim().max(200).optional() }),
  );
  const db = c.env.DB;
  if (input.id && (await first(db, "SELECT 1 FROM cards WHERE id = ?", input.id))) return c.json({ card: cardShape(await loadCard(db, input.id)) });
  const day = await loadDay(db, c.req.param("id"));
  if (day.status !== "in_progress" && day.status !== "finalized") throw new HttpError(409, "Cards can be given once play has started.");
  const onRoster = await first(db, "SELECT 1 FROM roster_entries WHERE match_day_id = ? AND player_id = ?", day.id, input.playerId);
  if (!onRoster) throw new HttpError(422, "That player isn't in a set for this match day.");
  if (input.matchId && !(await first(db, "SELECT 1 FROM matches WHERE id = ? AND match_day_id = ?", input.matchId, day.id))) {
    throw new HttpError(422, "That match isn't part of this match day.");
  }
  const { fines } = await fineSettings(db);
  const amount = fineFor(input.color, fines);
  const id = input.id ?? newId();
  await atomic(db, [
    stmt(
      db,
      `INSERT INTO cards (id, match_day_id, match_id, player_id, color, reason, fine_amount, fine_status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      day.id,
      input.matchId ?? null,
      input.playerId,
      input.color,
      input.reason || null,
      amount,
      amount === 0 ? "waived" : "unpaid",
      c.get("user")!.id,
      nowIso(),
    ),
    auditStmt(c, { action: `card.${input.color}`, entityType: "card", entityId: id, matchDayId: day.id, after: { playerId: input.playerId, fine: amount, reason: input.reason } }),
  ]);
  return c.json({ card: cardShape(await loadCard(db, id)) }, 201);
});

disciplineRoutes.post("/cards/:id/:action{void|waive|mark-paid|reopen}", requireAdmin, async (c) => {
  const action = c.req.param("action");
  const input = await body(c, z.object({ reason: zReason }));
  const db = c.env.DB;
  const k = await loadCard(db, c.req.param("id"));
  const now = nowIso();
  const needsReason = action === "void" || action === "waive";
  if (needsReason && (!input.reason || input.reason.length < 3)) throw new HttpError(422, "Give a reason (recorded in the audit log).");
  let update: D1PreparedStatement;
  switch (action) {
    case "void":
      if (k.voided_at) throw new HttpError(409, "Already voided.");
      if (k.fine_status === "paid" && k.paid_via === "online") throw new HttpError(409, "This fine was paid online. Refund it outside the app, then void.");
      update = stmt(db, "UPDATE cards SET voided_at = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL", now, input.reason, k.id);
      break;
    case "waive":
      if (k.fine_status !== "unpaid") throw new HttpError(409, `This fine is already ${k.fine_status}.`);
      update = stmt(db, "UPDATE cards SET fine_status = 'waived' WHERE id = ? AND fine_status = 'unpaid'", k.id);
      break;
    case "mark-paid":
      if (k.fine_status !== "unpaid") throw new HttpError(409, `This fine is already ${k.fine_status}.`);
      update = stmt(db, "UPDATE cards SET fine_status = 'paid', paid_via = 'cash', paid_at = ? WHERE id = ? AND fine_status = 'unpaid'", now, k.id);
      break;
    default: // reopen a waived fine
      if (k.fine_status !== "waived") throw new HttpError(409, "Only waived fines can be reopened.");
      update = stmt(db, "UPDATE cards SET fine_status = 'unpaid' WHERE id = ? AND fine_status = 'waived'", k.id);
  }
  await atomic(db, [
    update,
    stmt(db, "INSERT INTO _batch_guard (ok) VALUES (changes())"),
    auditStmt(c, {
      action: `card.${action}`,
      entityType: "card",
      entityId: k.id,
      matchDayId: k.match_day_id,
      reason: input.reason,
      before: { fineStatus: k.fine_status, voided: Boolean(k.voided_at) },
    }),
  ]);
  return c.json({ card: cardShape(await loadCard(db, k.id)) });
});

// ---------------------------------------------------------------------------
// Fines: own view, admin summary
// ---------------------------------------------------------------------------

async function myPlayerId(c: Ctx) {
  const row = await first<{ id: string }>(c.env.DB, "SELECT id FROM players WHERE user_id = ?", c.get("user")!.id);
  return row?.id ?? null;
}

disciplineRoutes.get("/me/fines", requireUser, async (c) => {
  const db = c.env.DB;
  const playerId = await myPlayerId(c);
  const { fines, currency } = await fineSettings(db);
  if (!playerId) return c.json({ cards: [], payments: [], outstanding: 0, currency, fines });
  const cards = await all<CardRow>(
    db,
    `SELECT k.*, md.date FROM cards k JOIN match_days md ON md.id = k.match_day_id WHERE k.player_id = ? AND k.voided_at IS NULL ORDER BY k.created_at DESC`,
    playerId,
  );
  const payments = await all<Record<string, unknown>>(
    db,
    "SELECT id, amount, currency, status, reference, created_at AS createdAt, completed_at AS completedAt FROM payments WHERE player_id = ? ORDER BY created_at DESC LIMIT 20",
    playerId,
  );
  const outstanding = cards.filter((k) => k.fine_status === "unpaid").reduce((s, k) => s + k.fine_amount, 0);
  return c.json({ cards: cards.map(cardShape), payments, outstanding, currency, fines });
});

disciplineRoutes.get("/admin/fines", requireAdmin, async (c) => {
  const db = c.env.DB;
  const { currency, fines } = await fineSettings(db);
  const [cards, perPlayer] = await Promise.all([
    all<CardRow>(
      db,
      `SELECT k.*, p.display_name, md.date FROM cards k JOIN players p ON p.id = k.player_id JOIN match_days md ON md.id = k.match_day_id
        ORDER BY k.created_at DESC LIMIT 300`,
    ),
    all<{ playerId: string; displayName: string; yellow: number; red: number; owed: number; paid: number; waived: number }>(
      db,
      `SELECT p.id AS playerId, p.display_name AS displayName,
              SUM(CASE WHEN k.color = 'yellow' THEN 1 ELSE 0 END) AS yellow,
              SUM(CASE WHEN k.color = 'red' THEN 1 ELSE 0 END) AS red,
              SUM(CASE WHEN k.fine_status = 'unpaid' THEN k.fine_amount ELSE 0 END) AS owed,
              SUM(CASE WHEN k.fine_status = 'paid' THEN k.fine_amount ELSE 0 END) AS paid,
              SUM(CASE WHEN k.fine_status = 'waived' THEN k.fine_amount ELSE 0 END) AS waived
         FROM cards k JOIN players p ON p.id = k.player_id
        WHERE k.voided_at IS NULL GROUP BY p.id ORDER BY owed DESC, displayName COLLATE NOCASE`,
    ),
  ]);
  const totals = perPlayer.reduce((t, r) => ({ owed: t.owed + r.owed, paid: t.paid + r.paid, waived: t.waived + r.waived }), { owed: 0, paid: 0, waived: 0 });
  return c.json({ currency, fines, totals, perPlayer, cards: cards.map(cardShape) });
});

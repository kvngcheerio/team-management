import { DEFAULT_ACCESS, guestFeeFor } from "../../shared/rules";
import type { Ctx } from "../env";
import { randomToken } from "./crypto";
import { first, getSetting, newId, nowIso, stmt } from "./db";

export async function accessSettings(db: D1Database) {
  const [membershipFee, membershipMonths, guestFee, guestFreeAfter, referralCredit, currency] = await Promise.all([
    getSetting(db, "membership_fee", String(DEFAULT_ACCESS.membershipFee)),
    getSetting(db, "membership_months", String(DEFAULT_ACCESS.membershipMonths)),
    getSetting(db, "guest_fee", String(DEFAULT_ACCESS.guestFee)),
    getSetting(db, "guest_free_after", String(DEFAULT_ACCESS.guestFreeAfter)),
    getSetting(db, "referral_credit", String(DEFAULT_ACCESS.referralCredit)),
    getSetting(db, "currency", "NGN"),
  ]);
  return {
    membershipFee: Number(membershipFee),
    membershipMonths: Number(membershipMonths),
    guestFee: Number(guestFee),
    guestFreeAfter: Number(guestFreeAfter),
    referralCredit: Number(referralCredit),
    currency,
  };
}

/** Guest-fee days already paid by this player in the match day's season (cancelled days excluded). */
export async function paidGuestDays(db: D1Database, playerId: string, seasonId: string, excludeDayId?: string) {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM registrations r JOIN match_days md ON md.id = r.match_day_id
      WHERE r.player_id = ? AND md.season_id = ? AND md.status <> 'cancelled' AND r.fee_status = 'paid' AND md.id <> ?`,
    playerId,
    seasonId,
    excludeDayId ?? "",
  );
  return row?.n ?? 0;
}

/** Fee for a guest on a given match day (members pay nothing per day). */
export async function guestFeeForDay(db: D1Database, player: { id: string; kind: string }, day: { id: string; season_id: string }) {
  if (player.kind !== "guest") return { feeStatus: "none" as const, amount: 0 };
  const s = await accessSettings(db);
  const { amount, free } = guestFeeFor(await paidGuestDays(db, player.id, day.season_id, day.id), s.guestFee, s.guestFreeAfter);
  return { feeStatus: free ? ("free" as const) : ("unpaid" as const), amount };
}

export async function walletBalance(db: D1Database, playerId: string) {
  return (await first<{ n: number }>(db, "SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_transactions WHERE player_id = ?", playerId))?.n ?? 0;
}

/**
 * Credit the referrer when the referred player makes their first payment. The `ref` is unique, so
 * repeat payments (or retries) can never credit twice.
 */
export async function referralCreditStatement(db: D1Database, referredPlayerId: string) {
  const credit = (await accessSettings(db)).referralCredit;
  return stmt(
    db,
    `INSERT OR IGNORE INTO wallet_transactions (id, player_id, amount, kind, ref, note, created_at)
     SELECT ?, p.referred_by, ?, 'referral', ?, 'Invite reward: ' || p.display_name, ?
       FROM players p WHERE p.id = ? AND p.referred_by IS NOT NULL AND ? > 0`,
    newId(),
    credit,
    `referral:${referredPlayerId}`,
    nowIso(),
    referredPlayerId,
    credit,
  );
}

/** Wallet debit, guarded so the balance can never go negative (the batch aborts instead). */
export function walletDebitStatements(db: D1Database, playerId: string, amount: number, kind: "fine_relief" | "renewal", ref: string, note: string) {
  return [
    stmt(db, "INSERT INTO _batch_guard (ok) VALUES (CASE WHEN (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE player_id = ?) >= ? THEN 1 ELSE 0 END)", playerId, amount),
    stmt(db, "INSERT INTO wallet_transactions (id, player_id, amount, kind, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", newId(), playerId, -amount, kind, ref, note, nowIso()),
  ];
}

/** Lazily assign a referral code. */
export async function referralCode(db: D1Database, playerId: string) {
  const row = await first<{ referral_code: string | null }>(db, "SELECT referral_code FROM players WHERE id = ?", playerId);
  if (row?.referral_code) return row.referral_code;
  const code = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "x");
  await db.prepare("UPDATE players SET referral_code = ? WHERE id = ? AND referral_code IS NULL").bind(code, playerId).run();
  return (await first<{ referral_code: string }>(db, "SELECT referral_code FROM players WHERE id = ?", playerId))!.referral_code;
}

export async function myPlayerRow(c: Ctx) {
  const u = c.get("user");
  if (!u) return null;
  return first<{ id: string; kind: "member" | "guest"; display_name: string; membership_paid_until: string | null; referred_by: string | null; active: number }>(
    c.env.DB,
    "SELECT id, kind, display_name, membership_paid_until, referred_by, active FROM players WHERE user_id = ?",
    u.id,
  );
}

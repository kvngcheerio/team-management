-- Paid access: guest fees per match day (free after N paid days per season), membership renewals,
-- referral links with wallet credit, and payments that can be part-covered by wallet credit.
-- Amounts are whole naira.

-- ---------------------------------------------------------------------------
-- Settings (admin-editable)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('membership_fee', '100000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('membership_months', '6', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('guest_fee', '5000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('guest_free_after', '5', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('referral_credit', '500', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- How players pay until Paystack is integrated: 'transfer' (bank transfer, admin confirms) or 'test' (simulator).
  ('payment_mode', 'transfer', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bank_name', 'GTBank', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bank_account_number', '0160720733', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('bank_account_name', 'Onyekachi Edmond', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------------------------------------------------------------------------
-- Players: referral code, who referred them, membership paid-until (reminder only, no lapse)
-- ---------------------------------------------------------------------------
ALTER TABLE players ADD COLUMN referral_code TEXT;
ALTER TABLE players ADD COLUMN referred_by TEXT REFERENCES players(id) ON DELETE SET NULL;
ALTER TABLE players ADD COLUMN membership_paid_until TEXT;
UPDATE players SET referral_code = lower(hex(randomblob(5))) WHERE referral_code IS NULL;
CREATE UNIQUE INDEX players_referral_code_idx ON players(referral_code);
-- Existing members are grandfathered: paid for six months from today (renewal reminder only).
UPDATE players SET membership_paid_until = date('now', '+6 months') WHERE kind = 'member' AND membership_paid_until IS NULL;
-- Signups no longer need approval: payment unlocks play instead.
UPDATE players SET approved = 1 WHERE approved = 0;

-- ---------------------------------------------------------------------------
-- Guest fee per match day, tracked on the registration.
--   none    = not applicable (members)
--   unpaid  = owed; a guest's place isn't confirmed by self-service until paid
--   paid    = paid (online, cash or by admin)
--   free    = free because the guest already paid for N match days this season
--   waived  = admin waived it
-- ---------------------------------------------------------------------------
ALTER TABLE registrations ADD COLUMN fee_status TEXT NOT NULL DEFAULT 'none' CHECK (fee_status IN ('none', 'unpaid', 'paid', 'free', 'waived'));
ALTER TABLE registrations ADD COLUMN fee_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registrations ADD COLUMN fee_paid_via TEXT CHECK (fee_paid_via IN ('online', 'cash'));
ALTER TABLE registrations ADD COLUMN fee_payment_id TEXT REFERENCES payments(id);
ALTER TABLE registrations ADD COLUMN fee_paid_at TEXT;

-- ---------------------------------------------------------------------------
-- Payments: purpose and wallet part-payment. card_ids stays '[]' for non-fine payments.
-- ---------------------------------------------------------------------------
ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'fines' CHECK (purpose IN ('fines', 'membership', 'guest_fee'));
ALTER TABLE payments ADD COLUMN wallet_amount INTEGER NOT NULL DEFAULT 0 CHECK (wallet_amount >= 0);
ALTER TABLE payments ADD COLUMN registration_id TEXT REFERENCES registrations(id);
ALTER TABLE payments ADD COLUMN submitted_at TEXT;
ALTER TABLE payments ADD COLUMN reviewed_by TEXT REFERENCES user(id) ON DELETE SET NULL;
ALTER TABLE payments ADD COLUMN review_note TEXT;

-- ---------------------------------------------------------------------------
-- Membership payments (one row per renewal period paid).
-- ---------------------------------------------------------------------------
CREATE TABLE membership_payments (
  id TEXT PRIMARY KEY NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  wallet_amount INTEGER NOT NULL DEFAULT 0 CHECK (wallet_amount >= 0),
  paid_via TEXT NOT NULL CHECK (paid_via IN ('online', 'cash', 'wallet')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  payment_id TEXT REFERENCES payments(id),
  recorded_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  voided_at TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX membership_payments_player_idx ON membership_payments(player_id, period_end);
CREATE UNIQUE INDEX membership_payments_payment_idx ON membership_payments(payment_id) WHERE payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Wallet: an append-only ledger. Balance = SUM(amount). `ref` makes credits idempotent
-- (e.g. 'referral:<referredPlayerId>' can only ever be credited once).
-- ---------------------------------------------------------------------------
CREATE TABLE wallet_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  kind TEXT NOT NULL CHECK (kind IN ('referral', 'fine_relief', 'renewal', 'adjustment')),
  ref TEXT UNIQUE,
  note TEXT,
  created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX wallet_transactions_player_idx ON wallet_transactions(player_id, created_at);

-- Group name: Team Alpha (only replaces the untouched default).
UPDATE settings SET value = 'Team Alpha', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = 'group_name' AND value = 'Matchday FC';

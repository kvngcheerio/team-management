import type { DailyWinnerResult, FinalizationIssue, MatchDayStatus, SetRecord, StandingRow } from "../shared/rules";

export interface Me {
  user: { id: string; name: string; email: string; role: "admin" | "member" } | null;
  player: {
    id: string;
    displayName: string;
    kind: "member" | "guest";
    approved: boolean;
    contactPhone: string | null;
    avatarUrl: string | null;
    outstandingFines: number;
    membershipPaidUntil: string | null;
    renewal: "not_member" | "current" | "due_soon" | "overdue";
    wallet: number;
  } | null;
  currency: string;
  groupName: string;
  timezone: string;
  needsSetup: boolean;
  rules: string[];
}

export interface Registration {
  id: string;
  playerId: string;
  displayName: string;
  kind: "member" | "guest";
  status: "pending" | "confirmed" | "waitlist" | "withdrawn" | "rejected" | "unavailable";
  source: "self" | "admin" | "guest_form";
  attended: boolean | null;
  queuedAt: string;
  waitlistPosition: number | null;
  feeStatus?: FeeStatus;
  feeAmount?: number;
  note?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

export interface RosterPlayer {
  playerId: string;
  displayName: string;
  kind: "member" | "guest";
  role: "starter" | "sub";
  isGoalkeeper: boolean;
  memberAtLock: boolean | null;
  attended: boolean | null;
  points: number | null;
}

export interface TeamSet {
  id: string;
  idx: number;
  name: string;
  color: string;
  isDailyWinner: boolean;
  record?: SetRecord;
  players: RosterPlayer[];
}

export interface Goal {
  id: string;
  setId: string;
  kind: "normal" | "own_goal" | "unattributed";
  scorerPlayerId: string | null;
  assistPlayerId: string | null;
}

export interface Match {
  id: string;
  seq: number;
  homeSetId: string;
  awaySetId: string;
  homeScore: number;
  awayScore: number;
  status: "in_progress" | "completed" | "void";
  isPlayoff: boolean;
  reconciled: boolean;
  goals: Goal[];
}

export interface MatchDayDetail {
  day: {
    id: string;
    seasonId: string;
    seasonName: string;
    seasonStatus: string;
    timezone: string;
    date: string;
    kickoffTime: string;
    venue: string;
    capacity: number;
    checkinDeadline: string;
    checkinDeadlineLocal: { date: string; time: string };
    teamSize: number;
    setCount: number;
    status: MatchDayStatus;
    tiePolicy: "shared" | "playoff";
    notes: string;
    teamsPublishedAt: string | null;
    startedAt: string | null;
    finalizedAt: string | null;
    cancelledAt: string | null;
    cancelReason: string | null;
    autoCreated: boolean;
    version: number;
    teamSheetAt: string | null;
    teamSheetLocal: { date: string; time: string } | null;
    teamsVisible: boolean;
    guestLink?: string;
  };
  registrations: Registration[];
  counts: { confirmed: number; waitlist: number; pending: number; unavailable: number };
  noResponse: { playerId: string; displayName: string }[];
  guestSlots: number | null;
  cards: DayCard[];
  mvp: Poll | null;
  sets: TeamSet[];
  matches: Match[];
  winner: DailyWinnerResult;
  issues: FinalizationIssue[];
  me: {
    playerId: string;
    kind: string;
    registrationStatus: Registration["status"] | null;
    canCheckIn: boolean;
    approved: boolean;
    points: number | null;
    feeStatus: FeeStatus | null;
    feeAmount: number;
    guestFee: number | null;
  } | null;
  alreadyFinalized?: boolean;
}

export interface MatchDaySummary {
  id: string;
  seasonId: string;
  seasonName: string;
  timezone: string;
  date: string;
  kickoffTime: string;
  venue: string;
  capacity: number;
  status: MatchDayStatus;
  checkinDeadline: string;
  confirmed: number;
  waitlist: number;
  pending?: number;
  myStatus: Registration["status"] | null;
  teamsPublished: boolean;
}

export interface Season {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  timezone: string;
  status: "active" | "closed";
  closedAt: string | null;
  matchDays: number;
  finalizedDays: number;
  datesEditable: boolean;
}

export interface LeaderRow {
  playerId: string;
  displayName: string;
  kind: string;
  goals: number;
  assists: number;
  position: number;
}

export interface Standings {
  season: Season;
  table: (StandingRow & { kind: string })[];
  goals: LeaderRow[];
  assists: LeaderRow[];
  frozen: boolean;
}

export interface Player {
  id: string;
  displayName: string;
  kind: "member" | "guest";
  active: boolean;
  approved: boolean;
  hasAccount: boolean;
  avatarUrl: string | null;
  signupSource?: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  skillRating?: number;
  gkPreference?: "none" | "can" | "prefers";
  memberSince?: string | null;
  accountEmail?: string | null;
}

export interface DayCard {
  id: string;
  playerId: string;
  displayName: string;
  color: "yellow" | "red";
  matchId: string | null;
  reason: string | null;
  fineAmount: number | null;
  fineStatus: "unpaid" | "paid" | "waived" | null;
  voided: boolean;
}

export interface Card {
  id: string;
  matchDayId: string;
  playerId: string;
  displayName?: string;
  date?: string;
  color: "yellow" | "red";
  reason: string | null;
  fineAmount: number;
  fineStatus: "unpaid" | "paid" | "waived";
  paidVia: "online" | "cash" | null;
  paidAt: string | null;
  voided: boolean;
  voidReason: string | null;
  createdAt: string;
}

export type FeeStatus = "none" | "unpaid" | "paid" | "free" | "waived";

export interface CheckoutResult {
  completed: boolean;
  paymentId?: string;
  wallet: number;
  external: number;
}

export interface Account {
  paymentMode: "transfer" | "test";
  bank: { bankName: string; accountNumber: string; accountName: string };
  transfers: { id: string; purpose: string; amount: number; reference: string; status: "pending" | "submitted" | "failed"; reviewNote: string | null }[];
  currency: string;
  fees: { membership: number; membershipMonths: number; guest: number; guestFreeAfter: number; referralCredit: number };
  membership: {
    kind: "member" | "guest";
    paidUntil: string | null;
    status: "not_member" | "current" | "due_soon" | "overdue";
    next: { start: string; end: string };
    history: { amount: number; walletAmount: number; paidVia: string; periodStart: string; periodEnd: string; createdAt: string }[];
  };
  wallet: { balance: number; transactions: { amount: number; kind: string; note: string | null; createdAt: string }[] };
  referral: { url: string; invited: { playerId: string; displayName: string; kind: string; credited: boolean }[] };
  guestFeesOwed: { registrationId: string; matchDayId: string; date: string; amount: number; status: string }[];
}

export interface Payment {
  id: string;
  purpose: "fines" | "membership" | "guest_fee";
  walletAmount: number;
  total: number;
  matchDay: { date: string; registrationStatus: string } | null;
  membership: { periodStart: string; periodEnd: string } | null;
  submittedAt: string | null;
  reviewNote: string | null;
  bank: { bankName: string; accountNumber: string; accountName: string } | null;
  amount: number;
  currency: string;
  provider: string;
  status: "pending" | "submitted" | "succeeded" | "failed" | "cancelled";
  reference: string;
  createdAt: string;
  completedAt: string | null;
  cards: Card[];
}

export interface Poll {
  id: string;
  kind: "matchday" | "season";
  matchDayId: string | null;
  matchDayDate: string | null;
  seasonId: string;
  seasonName?: string;
  opensAt: string;
  closesAt: string;
  open: boolean;
  cancelled: boolean;
  turnout: { voted: number; eligible: number };
  canVote: boolean;
  myVote: string | null;
  candidates: { playerId: string; displayName: string; kind: string; avatarUrl: string | null }[];
  results: {
    total: number;
    winners: { playerId: string; displayName: string; avatarUrl: string | null }[];
    ranked: { playerId: string; displayName: string; votes: number }[];
  } | null;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

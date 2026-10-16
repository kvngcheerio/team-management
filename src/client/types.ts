import type { DailyWinnerResult, FinalizationIssue, MatchDayStatus, SetRecord, StandingRow } from "../shared/rules";

export interface Me {
  user: { id: string; name: string; email: string; role: "admin" | "member" } | null;
  player: { id: string; displayName: string; kind: "member" | "guest" } | null;
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
  status: "pending" | "confirmed" | "waitlist" | "withdrawn" | "rejected";
  source: "self" | "admin" | "guest_form";
  attended: boolean | null;
  queuedAt: string;
  waitlistPosition: number | null;
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
    version: number;
    guestLink?: string;
  };
  registrations: Registration[];
  counts: { confirmed: number; waitlist: number; pending: number };
  sets: TeamSet[];
  matches: Match[];
  winner: DailyWinnerResult;
  issues: FinalizationIssue[];
  me: { playerId: string; kind: string; registrationStatus: Registration["status"] | null; canCheckIn: boolean; points: number | null } | null;
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
  hasAccount: boolean;
  contactEmail?: string | null;
  contactPhone?: string | null;
  skillRating?: number;
  gkPreference?: "none" | "can" | "prefers";
  memberSince?: string | null;
  accountEmail?: string | null;
}

/**
 * Matchday business rules — the single source of truth for scoring, eligibility,
 * standings ordering, season boundaries and finalization checks.
 *
 * Everything here is pure (no I/O) so it can be unit-tested and shared by the
 * Worker (authoritative) and the UI (explanations/previews only — the server never
 * trusts client-calculated points).
 */

// ---------------------------------------------------------------------------
// Constants and documented defaults
// ---------------------------------------------------------------------------

/** League points each eligible player in a daily-winning set receives, once per match day. */
export const POINTS_PER_DAILY_WIN = 3;

/**
 * League points by finishing position (index 0 = 1st), depending on how many sets played that day.
 * 4+ sets: 3/2/1; 3 sets: 3/1/0; 2 sets: 3/0.
 */
export function placementPoints(setCount: number): number[] {
  if (setCount >= 4) return [POINTS_PER_DAILY_WIN, 2, 1];
  if (setCount === 3) return [POINTS_PER_DAILY_WIN, 1];
  return [POINTS_PER_DAILY_WIN];
}
export const SEASON_LENGTH_MONTHS = 6;
export const DEFAULT_TIMEZONE = "Africa/Lagos";

export type TiePolicy = "shared" | "playoff";
export type MatchStatus = "in_progress" | "completed" | "void";
export type GoalKind = "normal" | "own_goal" | "unattributed";
export type MatchDayStatus = "draft" | "checkin_open" | "locked" | "in_progress" | "finalized" | "cancelled";

export const RULES_SUMMARY = [
  "A match day is a session of several short matches between sets (teams picked for that day).",
  "The set with the most match wins that day is the daily winner.",
  "League points go by where your set finishes that day (most match wins first), once per match day. With 4 sets: 1st 3, 2nd 2, 3rd 1, 4th 0. With 3 sets: 1st 3, 2nd 1, 3rd 0. With 2 sets: winner 3.",
  "Sets level on wins share the position and its points. A tie for first is shared too — unless the admin chose a playoff for that day, in which case a recorded playoff match decides it (the playoff loser finishes 2nd).",
  "If no set wins a single match (all draws), there is no daily winner and nobody earns points.",
  "Eligible = in the set's locked roster, attendance confirmed, and a member when play started. Guests can score and assist but earn no league points.",
  "Converting a guest to a member applies from the next roster lock onwards (prospective).",
  "League table order: points, then daily wins, then goals, then assists. Players level on all four share the position.",
  "Seasons run six calendar months between explicit start and end dates (timezone Africa/Lagos by default).",
  "Only finalized match days count. Cancelled match days award nothing.",
  "Rosters lock when the first match starts: no team switches after that. Late guests can still be added on the pitch into a team with a free spot (teams are 5-a-side by default).",
  "Admins can correct finalized days; every correction is audited and standings are recalculated from records, so points can never be awarded twice.",
  "The team sheet is visible to players from 07:50 WAT on match day (or once play starts).",
  "Cards carry fines (default ₦2,000 yellow, ₦5,000 red), fixed when the card is given. Cards don't affect league points.",
  "Weekly MVP: voting opens when a match day is finalized and runs 48 hours. Players who attended vote for anyone who played (not themselves). Most votes wins; ties share it.",
  "Signing up makes you a guest. Guests pay ₦5,000 per match day to play; after paying for 5 match days in a season, the rest of that season is free. Paying the membership fee (default ₦100,000 every 6 months) makes you a member.",
  "Invite friends with your personal link: when someone you invited makes their first payment, you get ₦500 wallet credit, usable on membership renewal or card fines.",
  "Season MVP: an admin opens the vote. Approved members vote for anyone who played that season. Results show when voting closes.",
] as const;

// ---------------------------------------------------------------------------
// Match-day status transitions
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<MatchDayStatus, MatchDayStatus[]> = {
  draft: ["checkin_open", "cancelled"],
  checkin_open: ["locked", "draft", "cancelled"],
  locked: ["checkin_open", "in_progress", "cancelled"],
  in_progress: ["finalized", "cancelled"],
  finalized: [],
  cancelled: [],
};

export function canTransition(from: MatchDayStatus, to: MatchDayStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Rosters can be (re)published only before play starts. */
export function rosterEditable(status: MatchDayStatus): boolean {
  return status === "checkin_open" || status === "locked";
}

/** Members may withdraw themselves only while check-in is open and before the deadline. */
export function selfCheckInOpen(status: MatchDayStatus, deadlineIso: string, now: Date): boolean {
  return status === "checkin_open" && now.getTime() < Date.parse(deadlineIso);
}

/**
 * The check-in deadline is soft: members may still check in after it, until an admin closes check-in.
 * Such check-ins are flagged late (`isLateCheckIn`) so lateness can be enforced separately.
 */
export function lateCheckInAllowed(status: MatchDayStatus): boolean {
  return status === "checkin_open";
}

export function isLateCheckIn(deadlineIso: string, now: Date): boolean {
  return now.getTime() >= Date.parse(deadlineIso);
}

// ---------------------------------------------------------------------------
// Set table (W/D/L/GF/GA) and daily winner
// ---------------------------------------------------------------------------

export interface MatchResult {
  id: string;
  homeSetId: string;
  awaySetId: string;
  homeScore: number;
  awayScore: number;
  status: MatchStatus;
  isPlayoff: boolean;
  /** Display order within the day, used in messages. */
  seq?: number;
}

export interface SetRecord {
  setId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
}

/** Table of regular (non-playoff) completed matches. In-progress and void matches are ignored. */
export function computeSetTable(setIds: string[], matches: MatchResult[]): SetRecord[] {
  const table = new Map<string, SetRecord>(
    setIds.map((setId) => [setId, { setId, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 }]),
  );
  for (const m of matches) {
    if (m.status !== "completed" || m.isPlayoff) continue;
    const home = table.get(m.homeSetId);
    const away = table.get(m.awaySetId);
    if (!home || !away) continue;
    home.played++;
    away.played++;
    home.goalsFor += m.homeScore;
    home.goalsAgainst += m.awayScore;
    away.goalsFor += m.awayScore;
    away.goalsAgainst += m.homeScore;
    if (m.homeScore > m.awayScore) {
      home.wins++;
      away.losses++;
    } else if (m.homeScore < m.awayScore) {
      away.wins++;
      home.losses++;
    } else {
      home.draws++;
      away.draws++;
    }
  }
  return setIds.map((id) => table.get(id)!);
}

export type DailyWinnerResult =
  | { status: "decided"; winnerSetIds: string[]; method: "outright" | "shared" | "playoff"; maxWins: number }
  | { status: "no_winner"; reason: "no_completed_matches" | "no_wins" }
  | { status: "playoff_required"; tiedSetIds: string[]; maxWins: number };

/**
 * Most match wins decides the daily winner.
 * - Unique leader → outright winner.
 * - Tie + "shared" policy → all tied sets win.
 * - Tie + "playoff" policy → completed playoff matches between the tied sets decide (most playoff
 *   wins); if they don't separate the sets yet, another playoff is required.
 * - No completed regular matches, or nobody won a match → no daily winner.
 */
export function determineDailyWinner(setIds: string[], matches: MatchResult[], tiePolicy: TiePolicy): DailyWinnerResult {
  const table = computeSetTable(setIds, matches);
  if (!table.some((r) => r.played > 0)) return { status: "no_winner", reason: "no_completed_matches" };
  const maxWins = Math.max(...table.map((r) => r.wins));
  if (maxWins === 0) return { status: "no_winner", reason: "no_wins" };
  const leaders = table.filter((r) => r.wins === maxWins).map((r) => r.setId);
  if (leaders.length === 1) return { status: "decided", winnerSetIds: leaders, method: "outright", maxWins };
  if (tiePolicy === "shared") return { status: "decided", winnerSetIds: leaders, method: "shared", maxWins };

  const tied = new Set(leaders);
  const playoffs = matches.filter(
    (m) => m.isPlayoff && m.status === "completed" && tied.has(m.homeSetId) && tied.has(m.awaySetId),
  );
  const playoffWins = new Map(leaders.map((id) => [id, 0]));
  for (const m of playoffs) {
    if (m.homeScore > m.awayScore) playoffWins.set(m.homeSetId, playoffWins.get(m.homeSetId)! + 1);
    else if (m.awayScore > m.homeScore) playoffWins.set(m.awaySetId, playoffWins.get(m.awaySetId)! + 1);
  }
  const bestPlayoff = Math.max(...playoffWins.values());
  const playoffLeaders = leaders.filter((id) => playoffWins.get(id) === bestPlayoff);
  if (bestPlayoff > 0 && playoffLeaders.length === 1) {
    return { status: "decided", winnerSetIds: playoffLeaders, method: "playoff", maxWins };
  }
  return { status: "playoff_required", tiedSetIds: bestPlayoff > 0 ? playoffLeaders : leaders, maxWins };
}

// ---------------------------------------------------------------------------
// Goals and assists
// ---------------------------------------------------------------------------

export interface GoalEvent {
  id?: string;
  matchId: string;
  /** Set credited with the goal. */
  setId: string;
  kind: GoalKind;
  scorerPlayerId: string | null;
  assistPlayerId: string | null;
}

export interface RosterEntry {
  playerId: string;
  setId: string;
  /** Membership snapshot at roster lock; null before play starts. */
  memberAtLock: boolean | null;
}

/** Returns a human-readable error, or null when the goal event is valid for this match. */
export function validateGoalEvent(
  goal: Omit<GoalEvent, "matchId">,
  match: Pick<MatchResult, "homeSetId" | "awaySetId">,
  roster: RosterEntry[],
): string | null {
  if (goal.setId !== match.homeSetId && goal.setId !== match.awaySetId) {
    return "The credited set is not playing in this match.";
  }
  const opponentSetId = goal.setId === match.homeSetId ? match.awaySetId : match.homeSetId;
  const setOf = (playerId: string) => roster.find((r) => r.playerId === playerId)?.setId;

  if (goal.scorerPlayerId && goal.assistPlayerId && goal.scorerPlayerId === goal.assistPlayerId) {
    return "A player cannot assist their own goal.";
  }
  switch (goal.kind) {
    case "unattributed":
      if (goal.scorerPlayerId || goal.assistPlayerId) return "Unattributed goals cannot have a scorer or assister.";
      return null;
    case "own_goal":
      if (!goal.scorerPlayerId) return "Choose the player who scored the own goal.";
      if (goal.assistPlayerId) return "Own goals cannot have an assist.";
      if (setOf(goal.scorerPlayerId) !== opponentSetId) {
        return "An own goal must be scored by a player from the opposing set.";
      }
      return null;
    case "normal":
      if (!goal.scorerPlayerId) return "Choose the scorer, or record the goal as unattributed.";
      if (setOf(goal.scorerPlayerId) !== goal.setId) return "The scorer is not on the credited set's roster.";
      if (goal.assistPlayerId && setOf(goal.assistPlayerId) !== goal.setId) {
        return "The assister is not on the credited set's roster.";
      }
      return null;
  }
}

/** Goal events must add up to the recorded score for each side. */
export function reconcileMatch(match: MatchResult, goals: GoalEvent[]) {
  const mine = goals.filter((g) => g.matchId === match.id);
  const homeEvents = mine.filter((g) => g.setId === match.homeSetId).length;
  const awayEvents = mine.filter((g) => g.setId === match.awaySetId).length;
  return { ok: homeEvents === match.homeScore && awayEvents === match.awayScore, homeEvents, awayEvents };
}

// ---------------------------------------------------------------------------
// Finalization: blocking checks and per-player day stats
// ---------------------------------------------------------------------------

export interface DayState {
  setIds: string[];
  tiePolicy: TiePolicy;
  matches: MatchResult[];
  goals: GoalEvent[];
  roster: RosterEntry[];
  /** playerId → attended (true/false) or null when not yet marked. */
  attendance: Record<string, boolean | null>;
}

export interface FinalizationIssue {
  code:
    | "match_in_progress"
    | "score_mismatch"
    | "attendance_unmarked"
    | "absent_scorer"
    | "playoff_required"
    | "no_completed_matches";
  message: string;
}

export function finalizationIssues(state: DayState): FinalizationIssue[] {
  const issues: FinalizationIssue[] = [];
  const counted = state.matches.filter((m) => m.status !== "void");
  if (!counted.some((m) => m.status === "completed")) {
    issues.push({ code: "no_completed_matches", message: "Record at least one completed match (or cancel the day)." });
  }
  for (const m of counted) {
    if (m.status === "in_progress") {
      issues.push({ code: "match_in_progress", message: `Match ${label(m)} is still in progress. Complete or void it.` });
      continue;
    }
    const rec = reconcileMatch(m, state.goals);
    if (!rec.ok) {
      issues.push({
        code: "score_mismatch",
        message: `Match ${label(m)}: score ${m.homeScore}–${m.awayScore} but goal events ${rec.homeEvents}–${rec.awayEvents}.`,
      });
    }
  }
  const unmarked = state.roster.filter((r) => state.attendance[r.playerId] == null);
  if (unmarked.length > 0) {
    issues.push({ code: "attendance_unmarked", message: `${unmarked.length} rostered player(s) have no attendance marked.` });
  }
  const countedIds = new Set(counted.map((m) => m.id));
  const absent = new Set(state.roster.filter((r) => state.attendance[r.playerId] === false).map((r) => r.playerId));
  const absentInvolved = state.goals.some(
    (g) =>
      countedIds.has(g.matchId) &&
      ((g.scorerPlayerId && absent.has(g.scorerPlayerId)) || (g.assistPlayerId && absent.has(g.assistPlayerId))),
  );
  if (absentInvolved) {
    issues.push({ code: "absent_scorer", message: "A player marked absent is credited with a goal or assist." });
  }
  const winner = determineDailyWinner(state.setIds, state.matches, state.tiePolicy);
  if (winner.status === "playoff_required") {
    issues.push({ code: "playoff_required", message: "Sets are tied on wins and this day uses a playoff. Record a decisive playoff match." });
  }
  return issues;
}

export interface SetPlacement {
  setId: string;
  /** Finishing position (1 = daily winner); sets level on wins share it. Null when there's no winner. */
  position: number | null;
  points: number;
}

/**
 * Finishing positions for the day. The daily winner(s) are 1st; every other set is placed by regular
 * match wins below them, sharing a position (and its points) when level (1, 2, 2, 4 …). No decided
 * winner → no positions and no points.
 */
export function daySetPlacements(setIds: string[], matches: MatchResult[], winner: DailyWinnerResult): SetPlacement[] {
  if (winner.status !== "decided") return setIds.map((setId) => ({ setId, position: null, points: 0 }));
  const winners = new Set(winner.winnerSetIds);
  const wins = new Map(computeSetTable(setIds, matches).map((r) => [r.setId, r.wins]));
  const table = placementPoints(setIds.length);
  return setIds.map((setId) => {
    const position = winners.has(setId)
      ? 1
      : winners.size + setIds.filter((o) => !winners.has(o) && wins.get(o)! > wins.get(setId)!).length + 1;
    return { setId, position, points: table[position - 1] ?? 0 };
  });
}

export interface DayPlayerStat {
  playerId: string;
  setId: string;
  attended: boolean;
  eligible: boolean;
  dailyWin: boolean;
  points: number;
  goals: number;
  assists: number;
  ownGoals: number;
}

/**
 * Per-player records for one match day. Points are awarded once per player per day: their set's
 * placement points (`daySetPlacements`) when they're in its roster, attended, and were a member at
 * roster lock. `dailyWin` marks the winning set only.
 */
export function computeDayStats(state: DayState): { winner: DailyWinnerResult; stats: DayPlayerStat[] } {
  const winner = determineDailyWinner(state.setIds, state.matches, state.tiePolicy);
  const winners = new Set(winner.status === "decided" ? winner.winnerSetIds : []);
  const setPoints = new Map(daySetPlacements(state.setIds, state.matches, winner).map((p) => [p.setId, p.points]));
  const countedMatches = new Set(state.matches.filter((m) => m.status === "completed").map((m) => m.id));
  const tally = new Map<string, { goals: number; assists: number; ownGoals: number }>();
  const bump = (id: string, key: "goals" | "assists" | "ownGoals") => {
    const t = tally.get(id) ?? { goals: 0, assists: 0, ownGoals: 0 };
    t[key]++;
    tally.set(id, t);
  };
  for (const g of state.goals) {
    if (!countedMatches.has(g.matchId)) continue;
    if (g.kind === "normal" && g.scorerPlayerId) bump(g.scorerPlayerId, "goals");
    if (g.kind === "own_goal" && g.scorerPlayerId) bump(g.scorerPlayerId, "ownGoals");
    if (g.kind === "normal" && g.assistPlayerId) bump(g.assistPlayerId, "assists");
  }
  const seen = new Set<string>();
  const stats: DayPlayerStat[] = [];
  for (const r of state.roster) {
    if (seen.has(r.playerId)) continue; // defensive: a player can only be in one set
    seen.add(r.playerId);
    const attended = state.attendance[r.playerId] === true;
    const points = setPoints.get(r.setId) ?? 0;
    const eligible = attended && r.memberAtLock === true && points > 0;
    const t = tally.get(r.playerId) ?? { goals: 0, assists: 0, ownGoals: 0 };
    stats.push({
      playerId: r.playerId,
      setId: r.setId,
      attended,
      eligible,
      dailyWin: eligible && winners.has(r.setId),
      points: eligible ? points : 0,
      goals: t.goals,
      assists: t.assists,
      ownGoals: t.ownGoals,
    });
  }
  return { winner, stats };
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

export interface StandingInput {
  playerId: string;
  displayName: string;
  points: number;
  dailyWins: number;
  appearances: number;
  goals: number;
  assists: number;
}
export interface StandingRow extends StandingInput {
  position: number;
  shared: boolean;
}

/** Order by points, daily wins, goals, assists. Fully level players share a position (1, 1, 3 …). */
export function rankStandings(rows: StandingInput[]): StandingRow[] {
  const key = (r: StandingInput) => [r.points, r.dailyWins, r.goals, r.assists] as const;
  const sorted = [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!;
    return a.displayName.localeCompare(b.displayName);
  });
  const same = (a: StandingInput, b: StandingInput) => key(a).every((v, i) => v === key(b)[i]);
  return sorted.map((r, i) => {
    let first = i;
    while (first > 0 && same(sorted[first - 1]!, r)) first--;
    const shared = (i > 0 && same(sorted[i - 1]!, r)) || (i < sorted.length - 1 && same(sorted[i + 1]!, r));
    return { ...r, position: first + 1, shared };
  });
}

/** Leaderboard for a single stat with shared positions; zero rows are dropped. */
export function rankBy<T extends { displayName: string }>(rows: T[], value: (r: T) => number) {
  const sorted = rows.filter((r) => value(r) > 0).sort((a, b) => value(b) - value(a) || a.displayName.localeCompare(b.displayName));
  return sorted.map((r, i) => {
    let first = i;
    while (first > 0 && value(sorted[first - 1]!) === value(r)) first--;
    return { ...r, position: first + 1 };
  });
}

// ---------------------------------------------------------------------------
// Seasons (calendar dates are YYYY-MM-DD in the season timezone)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}

function daysInMonth(y: number, m0: number) {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

export function addMonthsClamped(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm0 = total % 12;
  const nd = Math.min(d, daysInMonth(ny, nm0));
  return `${ny}-${String(nm0 + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Inclusive end date of a six-calendar-month season: the day before the same day-of-month
 * six months later (clamped to month end). 2026-01-01 → 2026-06-30; 2026-07-15 → 2027-01-14.
 */
export function defaultSeasonEnd(startDate: string): string {
  return addDays(addMonthsClamped(startDate, SEASON_LENGTH_MONTHS), -1);
}

/** Inclusive on both ends. Lexicographic comparison works for YYYY-MM-DD. */
export function isDateInSeason(date: string, season: { startDate: string; endDate: string }): boolean {
  return date >= season.startDate && date <= season.endDate;
}

export function validateSeasonDates(startDate: string, endDate: string): string | null {
  if (!isValidDate(startDate) || !isValidDate(endDate)) return "Dates must be valid YYYY-MM-DD dates.";
  if (endDate <= startDate) return "The end date must be after the start date.";
  if (endDate > defaultSeasonEnd(startDate)) return "A season cannot be longer than six calendar months.";
  return null;
}

export function seasonsOverlap(a: { startDate: string; endDate: string }, b: { startDate: string; endDate: string }) {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

// ---------------------------------------------------------------------------
// Team selection
// ---------------------------------------------------------------------------

export interface PoolPlayer {
  playerId: string;
  displayName: string;
  /** 1..10, private admin rating. */
  rating: number;
  gk: "none" | "can" | "prefers";
}

export interface TeamAssignment {
  idx: number;
  players: { playerId: string; role: "starter" | "sub"; isGoalkeeper: boolean }[];
  totalRating: number;
}

export interface TeamSelectionResult {
  sets: TeamAssignment[];
  warnings: string[];
  explanation: string;
}

export class TeamSelectionError extends Error {}

/** Small seedable PRNG (mulberry32) so reshuffles are reproducible in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export const MIN_PLAYERS_PER_SET = 2;

function checkPool(pool: PoolPlayer[], setCount: number, teamSize: number): string[] {
  const ids = new Set(pool.map((p) => p.playerId));
  if (ids.size !== pool.length) throw new TeamSelectionError("The player pool contains duplicates.");
  if (setCount < 2) throw new TeamSelectionError("At least two sets are needed.");
  if (teamSize < 1) throw new TeamSelectionError("Players per set must be at least 1.");
  if (pool.length < setCount * MIN_PLAYERS_PER_SET) {
    throw new TeamSelectionError(
      `Not enough players: ${pool.length} confirmed for ${setCount} sets (minimum ${setCount * MIN_PLAYERS_PER_SET}). Reduce the number of sets or confirm more players.`,
    );
  }
  const warnings: string[] = [];
  const needed = setCount * teamSize;
  if (pool.length < needed) {
    warnings.push(
      `Only ${pool.length} players for ${setCount} sets of ${teamSize} (${needed} needed). Some sets will be short-handed.`,
    );
  } else if (pool.length > needed) {
    warnings.push(`${pool.length - needed} extra player(s) are listed as substitutes, spread across the sets.`);
  }
  return warnings;
}

function finish(buckets: PoolPlayer[][], gkIds: Set<string>, teamSize: number, byRating: boolean): TeamAssignment[] {
  return buckets.map((bucket, i) => {
    // Starters: goalkeeper first, then (for balanced) strongest; extras beyond team size are subs.
    const ordered = [...bucket].sort((a, b) => {
      const ga = gkIds.has(a.playerId) ? 1 : 0;
      const gb = gkIds.has(b.playerId) ? 1 : 0;
      if (ga !== gb) return gb - ga;
      return byRating ? b.rating - a.rating : 0;
    });
    return {
      idx: i + 1,
      players: ordered.map((p, j) => ({
        playerId: p.playerId,
        role: j < teamSize ? ("starter" as const) : ("sub" as const),
        isGoalkeeper: gkIds.has(p.playerId),
      })),
      totalRating: bucket.reduce((s, p) => s + p.rating, 0),
    };
  });
}

/** Random split: shuffle and deal round-robin, so set sizes differ by at most one. */
export function randomTeams(pool: PoolPlayer[], setCount: number, teamSize: number, rand: () => number): TeamSelectionResult {
  const warnings = checkPool(pool, setCount, teamSize);
  const buckets: PoolPlayer[][] = Array.from({ length: setCount }, () => []);
  shuffle(pool, rand).forEach((p, i) => buckets[i % setCount]!.push(p));
  return {
    sets: finish(buckets, new Set(), teamSize, false),
    warnings,
    explanation: "Players were shuffled randomly and dealt to the sets in turn. Ratings were not used.",
  };
}

/**
 * Balanced split (greedy, explainable — not mathematically optimal):
 * 1. Goalkeepers: players who prefer goal (then those who can play there) are spread one per set,
 *    strongest first.
 * 2. Everyone else is sorted by rating (ties shuffled) and dealt strongest-first, each to the set
 *    with the fewest players, breaking ties by the lowest total rating.
 */
export function balancedTeams(pool: PoolPlayer[], setCount: number, teamSize: number, rand: () => number): TeamSelectionResult {
  const warnings = checkPool(pool, setCount, teamSize);
  const shuffled = shuffle(pool, rand);
  const byRating = (a: PoolPlayer, b: PoolPlayer) => b.rating - a.rating;
  const keepers = [
    ...shuffled.filter((p) => p.gk === "prefers").sort(byRating),
    ...shuffled.filter((p) => p.gk === "can").sort(byRating),
  ].slice(0, setCount);
  const gkIds = new Set(keepers.map((p) => p.playerId));
  if (keepers.length < setCount) {
    warnings.push(`Only ${keepers.length} goalkeeper volunteer(s) for ${setCount} sets.`);
  }
  const buckets: PoolPlayer[][] = Array.from({ length: setCount }, () => []);
  const total = (b: PoolPlayer[]) => b.reduce((s, p) => s + p.rating, 0);
  const place = (p: PoolPlayer) => {
    let best = 0;
    for (let i = 1; i < setCount; i++) {
      const bi = buckets[i]!;
      const bb = buckets[best]!;
      if (bi.length < bb.length || (bi.length === bb.length && total(bi) < total(bb))) best = i;
    }
    buckets[best]!.push(p);
  };
  keepers.forEach(place);
  shuffled.filter((p) => !gkIds.has(p.playerId)).sort(byRating).forEach(place);
  const sets = finish(buckets, gkIds, teamSize, true);
  const totals = sets.map((s) => s.totalRating);
  return {
    sets,
    warnings,
    explanation:
      `Goalkeepers were spread first, then players were dealt from strongest to weakest rating, each to the set with the fewest players and lowest total rating. ` +
      `Total ratings range ${Math.min(...totals)}–${Math.max(...totals)}. Ratings are a rough guide, so balance is approximate.`,
  };
}

/**
 * Server-side validation of a published assignment. Returns an error message or null.
 */
export function validateAssignment(
  sets: { idx: number; players: { playerId: string }[] }[],
  setCount: number,
  eligiblePlayerIds: Set<string>,
): string | null {
  if (sets.length !== setCount) return `Expected ${setCount} sets.`;
  const idxs = new Set(sets.map((s) => s.idx));
  if (idxs.size !== setCount || [...idxs].some((i) => i < 1 || i > setCount)) return "Set numbers are invalid.";
  const seen = new Set<string>();
  for (const s of sets) {
    if (s.players.length === 0) return `Set ${s.idx} has no players.`;
    for (const p of s.players) {
      if (seen.has(p.playerId)) return "A player cannot appear in two sets.";
      seen.add(p.playerId);
      if (!eligiblePlayerIds.has(p.playerId)) return "Only approved, confirmed players can be placed in a set.";
    }
  }
  return null;
}

export const SET_NAMES = ["Red", "Blue", "White", "Black", "Yellow", "Orange", "Purple", "Green", "Grey", "Pink", "Navy", "Maroon"];
export const SET_COLORS = ["#dc2626", "#2563eb", "#f8fafc", "#111827", "#facc15", "#f97316", "#9333ea", "#16a34a", "#9ca3af", "#ec4899", "#1e3a8a", "#7f1d1d"];

function label(m: MatchResult) {
  return m.seq != null ? `#${m.seq}` : m.id.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Team-sheet reveal, availability and disciplinary fines
// ---------------------------------------------------------------------------

export const DEFAULT_TEAM_SHEET_TIME = "07:50";

/**
 * Players see the team sheet from the reveal time on match day (default 07:50 local),
 * or as soon as play has started. Admins always see it.
 */
export function teamSheetVisible(status: MatchDayStatus, teamSheetAtIso: string | null, now: Date, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  if (status === "in_progress" || status === "finalized") return true;
  if (!teamSheetAtIso) return true;
  return now.getTime() >= Date.parse(teamSheetAtIso);
}

export type CardColor = "yellow" | "red";
export const DEFAULT_FINES: Record<CardColor, number> = { yellow: 2000, red: 5000 };

/** Fine for a card, fixed at the moment the card is given (later price changes don't apply retroactively). */
export function fineFor(color: CardColor, fines: Record<CardColor, number>): number {
  const amount = fines[color];
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : DEFAULT_FINES[color];
}

export function formatMoney(amount: number, currency = "NGN"): string {
  try {
    return new Intl.NumberFormat("en-NG", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

// ---------------------------------------------------------------------------
// MVP voting
// ---------------------------------------------------------------------------

export const DEFAULT_MVP_VOTE_HOURS = 48;

export function pollOpen(poll: { opensAt: string; closesAt: string; closedEarlyAt: string | null }, now: Date): boolean {
  const t = now.getTime();
  return !poll.closedEarlyAt && t >= Date.parse(poll.opensAt) && t < Date.parse(poll.closesAt);
}

/** Most votes wins; a tie means a shared MVP. No votes means no MVP. */
export function tallyVotes(votes: { candidatePlayerId: string }[]) {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.candidatePlayerId, (counts.get(v.candidatePlayerId) ?? 0) + 1);
  const ranked = [...counts.entries()].map(([playerId, votes]) => ({ playerId, votes })).sort((a, b) => b.votes - a.votes);
  const top = ranked[0]?.votes ?? 0;
  return { ranked, winners: top > 0 ? ranked.filter((r) => r.votes === top).map((r) => r.playerId) : [], total: votes.length };
}

/** Returns an error message or null. Voters must be eligible, candidates eligible, and no self-votes. */
export function validateVote(voterId: string, candidateId: string, voters: Set<string>, candidates: Set<string>): string | null {
  if (!voters.has(voterId)) return "You're not eligible to vote in this poll.";
  if (voterId === candidateId) return "You can't vote for yourself.";
  if (!candidates.has(candidateId)) return "That player isn't a candidate in this poll.";
  return null;
}

// ---------------------------------------------------------------------------
// Late (on-pitch) guests
// ---------------------------------------------------------------------------

export const DEFAULT_TEAM_SIZE = 5;

export interface SetFill {
  setId: string;
  idx: number;
  size: number;
  totalRating: number;
}

/**
 * Pick the set a late guest joins: the one with the fewest players that still has room under the
 * team size; ties go to the lower total rating, then the lower set number. Null when every set is full.
 */
export function chooseSetForLateGuest(sets: SetFill[], teamSize: number): SetFill | null {
  const open = sets.filter((s) => s.size < teamSize);
  if (open.length === 0) return null;
  return [...open].sort((a, b) => a.size - b.size || a.totalRating - b.totalRating || a.idx - b.idx)[0]!;
}

/**
 * Where a player confirmed after teams are published goes: the same set a late guest would join, as a
 * starter; when every set is full, the smallest set (same tie-breaks) as a sub. Null when there are no sets.
 */
export function chooseSetForLatePlayer(sets: SetFill[], teamSize: number): { set: SetFill; role: "starter" | "sub" } | null {
  const open = chooseSetForLateGuest(sets, teamSize);
  if (open) return { set: open, role: "starter" };
  const set = [...sets].sort((a, b) => a.size - b.size || a.totalRating - b.totalRating || a.idx - b.idx)[0];
  return set ? { set, role: "sub" } : null;
}

/**
 * How many more guests can be added: free spots across all sets (team size minus players),
 * further limited by the match day's capacity.
 */
export function guestSlotsLeft(sets: SetFill[], teamSize: number, capacity: number, confirmed: number): number {
  const teamSpots = sets.reduce((n, s) => n + Math.max(0, teamSize - s.size), 0);
  return Math.max(0, Math.min(teamSpots, capacity - confirmed));
}

// ---------------------------------------------------------------------------
// Paid access: guest fees, membership, wallet
// ---------------------------------------------------------------------------

export const DEFAULT_ACCESS = { membershipFee: 100_000, membershipMonths: 6, guestFee: 5_000, guestFreeAfter: 5, referralCredit: 500 };

/**
 * Guest fee for a match day. A guest pays per match day until they've paid for `freeAfter` match days
 * in the season; after that, the rest of the season is free.
 */
export function guestFeeFor(paidDaysThisSeason: number, guestFee: number, freeAfter: number): { amount: number; free: boolean } {
  if (guestFee <= 0) return { amount: 0, free: true };
  if (freeAfter > 0 && paidDaysThisSeason >= freeAfter) return { amount: 0, free: true };
  return { amount: guestFee, free: false };
}

/** Wallet credit is applied first (when chosen); the rest is paid externally. */
export function applyWallet(total: number, walletBalance: number, useWallet: boolean): { wallet: number; external: number } {
  const wallet = useWallet ? Math.max(0, Math.min(total, walletBalance)) : 0;
  return { wallet, external: total - wallet };
}

/**
 * The membership period a payment buys: starts the day after the current paid-until (if still current),
 * otherwise today, and runs for `months` calendar months (inclusive end).
 */
export function nextMembershipPeriod(paidUntil: string | null, today: string, months: number): { start: string; end: string } {
  const start = paidUntil && paidUntil >= today ? addDays(paidUntil, 1) : today;
  return { start, end: addDays(addMonthsClamped(start, months), -1) };
}

export type RenewalStatus = "not_member" | "current" | "due_soon" | "overdue";

/** Membership never lapses (members stay members); this only drives reminders. */
export function renewalStatus(kind: "member" | "guest", paidUntil: string | null, today: string, warnDays = 30): RenewalStatus {
  if (kind !== "member") return "not_member";
  if (!paidUntil || paidUntil < today) return "overdue";
  return paidUntil <= addDays(today, warnDays) ? "due_soon" : "current";
}

// ---------------------------------------------------------------------------
// Weekly schedule
// ---------------------------------------------------------------------------

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function parseWeekdays(value: string): number[] {
  return [...new Set(value.split(",").map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort();
}

/** Dates from `from` (inclusive) for `days` days that fall on the scheduled weekdays. */
export function scheduledDates(from: string, days: number, weekdays: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    if (weekdays.includes(isoWeekday(d))) out.push(d);
  }
  return out;
}

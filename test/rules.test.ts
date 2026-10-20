import { describe, expect, it } from "vitest";
import {
  balancedTeams,
  computeDayStats,
  computeSetTable,
  defaultSeasonEnd,
  determineDailyWinner,
  finalizationIssues,
  isDateInSeason,
  randomTeams,
  rankStandings,
  reconcileMatch,
  seededRandom,
  TeamSelectionError,
  validateAssignment,
  validateGoalEvent,
  validateSeasonDates,
  type DayState,
  type GoalEvent,
  type MatchResult,
  type PoolPlayer,
  type RosterEntry,
} from "../src/shared/rules";
import { utcToZoned, zonedToUtcIso } from "../src/shared/time";

let n = 0;
const m = (home: string, away: string, hs: number, as: number, extra: Partial<MatchResult> = {}): MatchResult => ({
  id: `m${++n}`,
  homeSetId: home,
  awaySetId: away,
  homeScore: hs,
  awayScore: as,
  status: "completed",
  isPlayoff: false,
  ...extra,
});

describe("daily winner — most match wins", () => {
  it("picks the set with the most wins, not the most goals", () => {
    const matches = [m("A", "B", 1, 0), m("A", "C", 1, 0), m("B", "C", 9, 0), m("B", "A", 0, 0)];
    const res = determineDailyWinner(["A", "B", "C"], matches, "shared");
    expect(res).toMatchObject({ status: "decided", winnerSetIds: ["A"], method: "outright", maxWins: 2 });
  });

  it("ignores in-progress and void matches", () => {
    const matches = [m("A", "B", 1, 0), m("B", "A", 5, 0, { status: "void" }), m("B", "A", 3, 0, { status: "in_progress" })];
    expect(determineDailyWinner(["A", "B"], matches, "shared")).toMatchObject({ winnerSetIds: ["A"] });
  });

  it("reports no winner when nothing was won", () => {
    expect(determineDailyWinner(["A", "B"], [], "shared")).toEqual({ status: "no_winner", reason: "no_completed_matches" });
    expect(determineDailyWinner(["A", "B"], [m("A", "B", 1, 1)], "shared")).toEqual({ status: "no_winner", reason: "no_wins" });
  });

  it("computes W/D/L/GF/GA per set", () => {
    const table = computeSetTable(["A", "B"], [m("A", "B", 2, 1), m("A", "B", 0, 0)]);
    expect(table[0]).toEqual({ setId: "A", played: 2, wins: 1, draws: 1, losses: 0, goalsFor: 2, goalsAgainst: 1 });
    expect(table[1]).toEqual({ setId: "B", played: 2, wins: 0, draws: 1, losses: 1, goalsFor: 1, goalsAgainst: 2 });
  });
});

describe("tie policies", () => {
  const tied = [m("A", "B", 1, 0), m("B", "C", 1, 0), m("C", "A", 0, 0)]; // A 1W, B 1W, C 0W

  it("shared policy: tied sets share first place", () => {
    expect(determineDailyWinner(["A", "B", "C"], tied, "shared")).toMatchObject({
      status: "decided",
      method: "shared",
      winnerSetIds: ["A", "B"],
    });
  });

  it("playoff policy: requires a playoff, then the playoff winner takes it", () => {
    expect(determineDailyWinner(["A", "B", "C"], tied, "playoff")).toMatchObject({
      status: "playoff_required",
      tiedSetIds: ["A", "B"],
    });
    const drawnPlayoff = [...tied, m("A", "B", 1, 1, { isPlayoff: true })];
    expect(determineDailyWinner(["A", "B", "C"], drawnPlayoff, "playoff").status).toBe("playoff_required");
    const decided = [...tied, m("A", "B", 0, 2, { isPlayoff: true })];
    expect(determineDailyWinner(["A", "B", "C"], decided, "playoff")).toMatchObject({
      status: "decided",
      method: "playoff",
      winnerSetIds: ["B"],
    });
  });

  it("playoff matches do not count towards the regular table", () => {
    const res = determineDailyWinner(["A", "B"], [m("A", "B", 1, 0), m("B", "A", 3, 0, { isPlayoff: true })], "playoff");
    expect(res).toMatchObject({ status: "decided", method: "outright", winnerSetIds: ["A"] });
  });

  it("playoffs involving a non-tied set are ignored", () => {
    const res = determineDailyWinner(["A", "B", "C"], [...tied, m("A", "C", 3, 0, { isPlayoff: true })], "playoff");
    expect(res.status).toBe("playoff_required");
  });
});

function dayState(over: Partial<DayState> = {}): DayState {
  const roster: RosterEntry[] = [
    { playerId: "a1", setId: "A", memberAtLock: true },
    { playerId: "a2", setId: "A", memberAtLock: true },
    { playerId: "aG", setId: "A", memberAtLock: false }, // guest
    { playerId: "b1", setId: "B", memberAtLock: true },
    { playerId: "b2", setId: "B", memberAtLock: true },
  ];
  const matches = [
    { ...m("A", "B", 1, 0), id: "x1" },
    { ...m("A", "B", 2, 0), id: "x2" },
    { ...m("B", "A", 1, 0), id: "x3" },
  ];
  const goals: GoalEvent[] = [
    { matchId: "x1", setId: "A", kind: "normal", scorerPlayerId: "aG", assistPlayerId: "a1" },
    { matchId: "x2", setId: "A", kind: "normal", scorerPlayerId: "a1", assistPlayerId: null },
    { matchId: "x2", setId: "A", kind: "own_goal", scorerPlayerId: "b1", assistPlayerId: null },
    { matchId: "x3", setId: "B", kind: "unattributed", scorerPlayerId: null, assistPlayerId: null },
  ];
  return {
    setIds: ["A", "B"],
    tiePolicy: "shared",
    matches,
    goals,
    roster,
    attendance: { a1: true, a2: false, aG: true, b1: true, b2: true },
    ...over,
  };
}

describe("awarding points", () => {
  it("awards exactly 3 points once per eligible winning player regardless of match wins", () => {
    const { stats, winner } = computeDayStats(dayState());
    expect(winner).toMatchObject({ status: "decided", winnerSetIds: ["A"], maxWins: 2 });
    const by = Object.fromEntries(stats.map((s) => [s.playerId, s]));
    expect(by.a1).toMatchObject({ points: 3, dailyWin: true, eligible: true });
    expect(stats.filter((s) => s.points > 0)).toHaveLength(1);
    expect(stats.reduce((sum, s) => sum + s.points, 0)).toBe(3);
  });

  it("excludes absent players and guests from points", () => {
    const by = Object.fromEntries(computeDayStats(dayState()).stats.map((s) => [s.playerId, s]));
    expect(by.a2).toMatchObject({ attended: false, eligible: false, points: 0 });
    expect(by.aG).toMatchObject({ attended: true, eligible: false, points: 0, goals: 1 });
    expect(by.b1).toMatchObject({ points: 0 });
  });

  it("counts goals and assists; own goals don't count as scored goals", () => {
    const by = Object.fromEntries(computeDayStats(dayState()).stats.map((s) => [s.playerId, s]));
    expect(by.a1).toMatchObject({ goals: 1, assists: 1 });
    expect(by.b1).toMatchObject({ goals: 0, ownGoals: 1 });
  });

  it("shares points between tied sets under the shared policy", () => {
    const state = dayState({ matches: [{ ...m("A", "B", 1, 0), id: "x1" }, { ...m("B", "A", 1, 0), id: "x3" }] });
    const pts = computeDayStats(state).stats.filter((s) => s.points === 3).map((s) => s.playerId).sort();
    expect(pts).toEqual(["a1", "b1", "b2"]);
  });

  it("awards no points when there is no winner", () => {
    const state = dayState({ matches: [{ ...m("A", "B", 0, 0), id: "x1" }], goals: [] });
    expect(computeDayStats(state).stats.every((s) => s.points === 0)).toBe(true);
  });
});

describe("goal validation", () => {
  const match = { homeSetId: "A", awaySetId: "B" };
  const roster: RosterEntry[] = [
    { playerId: "a1", setId: "A", memberAtLock: null },
    { playerId: "a2", setId: "A", memberAtLock: null },
    { playerId: "b1", setId: "B", memberAtLock: null },
  ];
  const g = (o: Partial<GoalEvent>) => ({ setId: "A", kind: "normal" as const, scorerPlayerId: "a1", assistPlayerId: null, ...o });

  it("accepts valid goals", () => {
    expect(validateGoalEvent(g({ assistPlayerId: "a2" }), match, roster)).toBeNull();
    expect(validateGoalEvent(g({ kind: "unattributed", scorerPlayerId: null }), match, roster)).toBeNull();
    expect(validateGoalEvent(g({ kind: "own_goal", scorerPlayerId: "b1" }), match, roster)).toBeNull();
  });

  it("rejects self-assists, wrong-team scorers and assisters, and bad own goals", () => {
    expect(validateGoalEvent(g({ assistPlayerId: "a1" }), match, roster)).toMatch(/own goal/i);
    expect(validateGoalEvent(g({ scorerPlayerId: "b1" }), match, roster)).toMatch(/scorer/);
    expect(validateGoalEvent(g({ assistPlayerId: "b1" }), match, roster)).toMatch(/assister/);
    expect(validateGoalEvent(g({ kind: "own_goal", scorerPlayerId: "a2" }), match, roster)).toMatch(/opposing/);
    expect(validateGoalEvent(g({ kind: "own_goal", scorerPlayerId: "b1", assistPlayerId: "a1" }), match, roster)).toMatch(/assist/);
    expect(validateGoalEvent(g({ setId: "C" }), match, roster)).toMatch(/not playing/);
    expect(validateGoalEvent(g({ scorerPlayerId: "zz" }), match, roster)).toMatch(/scorer/);
  });

  it("reconciles goal events with the score", () => {
    const match1 = m("A", "B", 2, 1);
    const goals: GoalEvent[] = [
      { matchId: match1.id, setId: "A", kind: "normal", scorerPlayerId: "a1", assistPlayerId: null },
      { matchId: match1.id, setId: "A", kind: "own_goal", scorerPlayerId: "b1", assistPlayerId: null },
    ];
    expect(reconcileMatch(match1, goals)).toEqual({ ok: false, homeEvents: 2, awayEvents: 0 });
    goals.push({ matchId: match1.id, setId: "B", kind: "unattributed", scorerPlayerId: null, assistPlayerId: null });
    expect(reconcileMatch(match1, goals).ok).toBe(true);
  });
});

describe("finalization checks", () => {
  it("passes for a complete day", () => {
    expect(finalizationIssues(dayState())).toEqual([]);
  });
  it("blocks on unreconciled scores, open matches, unmarked attendance, absent scorers, and pending playoffs", () => {
    const base = dayState();
    const codes = (s: DayState) => finalizationIssues(s).map((i) => i.code);
    expect(codes({ ...base, goals: base.goals.slice(1) })).toContain("score_mismatch");
    expect(codes({ ...base, matches: [...base.matches, { ...m("A", "B", 0, 0), status: "in_progress" }] })).toContain("match_in_progress");
    expect(codes({ ...base, attendance: { ...base.attendance, b2: null } })).toContain("attendance_unmarked");
    expect(codes({ ...base, attendance: { ...base.attendance, a1: false } })).toContain("absent_scorer");
    const tiedState = dayState({ tiePolicy: "playoff", matches: [{ ...m("A", "B", 1, 0), id: "x1" }, { ...m("B", "A", 1, 0), id: "x3" }], goals: [
      { matchId: "x1", setId: "A", kind: "unattributed", scorerPlayerId: null, assistPlayerId: null },
      { matchId: "x3", setId: "B", kind: "unattributed", scorerPlayerId: null, assistPlayerId: null },
    ] });
    expect(codes(tiedState)).toEqual(["playoff_required"]);
    expect(codes({ ...base, matches: [], goals: [] })).toContain("no_completed_matches");
  });
});

describe("standings order", () => {
  const row = (playerId: string, points: number, dailyWins: number, goals: number, assists: number) => ({
    playerId,
    displayName: playerId,
    points,
    dailyWins,
    appearances: 1,
    goals,
    assists,
  });
  it("orders by points, daily wins, goals, assists and shares fully level positions", () => {
    const ranked = rankStandings([
      row("e", 3, 1, 0, 0),
      row("a", 6, 2, 1, 0),
      row("b", 6, 2, 1, 0),
      row("c", 6, 2, 0, 5),
      row("d", 6, 1, 9, 9),
    ]);
    expect(ranked.map((r) => [r.playerId, r.position, r.shared])).toEqual([
      ["a", 1, true],
      ["b", 1, true],
      ["c", 3, false],
      ["d", 4, false],
      ["e", 5, false],
    ]);
  });
});

describe("season boundaries (six calendar months)", () => {
  it("computes inclusive end dates", () => {
    expect(defaultSeasonEnd("2026-01-01")).toBe("2026-06-30");
    expect(defaultSeasonEnd("2026-07-01")).toBe("2026-12-31");
    expect(defaultSeasonEnd("2026-07-15")).toBe("2027-01-14");
    expect(defaultSeasonEnd("2026-08-31")).toBe("2027-02-27"); // Feb clamps to 28th, minus one day
    expect(defaultSeasonEnd("2027-08-31")).toBe("2028-02-28"); // leap year clamps to 29th
  });
  it("includes both boundary days only", () => {
    const s = { startDate: "2026-01-01", endDate: "2026-06-30" };
    expect(isDateInSeason("2026-01-01", s)).toBe(true);
    expect(isDateInSeason("2026-06-30", s)).toBe(true);
    expect(isDateInSeason("2025-12-31", s)).toBe(false);
    expect(isDateInSeason("2026-07-01", s)).toBe(false);
  });
  it("validates explicit dates", () => {
    expect(validateSeasonDates("2026-01-01", "2026-06-30")).toBeNull();
    expect(validateSeasonDates("2026-01-01", "2026-07-01")).toMatch(/six/);
    expect(validateSeasonDates("2026-01-01", "2026-01-01")).toMatch(/after/);
    expect(validateSeasonDates("2026-02-30", "2026-06-30")).toMatch(/valid/);
  });
});

describe("team selection", () => {
  const pool: PoolPlayer[] = Array.from({ length: 22 }, (_, i) => ({
    playerId: `p${i}`,
    displayName: `P${i}`,
    rating: (i % 10) + 1,
    gk: i < 3 ? "prefers" : i === 3 ? "can" : "none",
  }));

  it("balanced: no duplicates, everyone placed once, keepers spread, totals close", () => {
    const res = balancedTeams(pool, 4, 5, seededRandom(42));
    const ids = res.sets.flatMap((s) => s.players.map((p) => p.playerId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(pool.map((p) => p.playerId).sort());
    expect(res.sets.map((s) => s.players.filter((p) => p.isGoalkeeper).length)).toEqual([1, 1, 1, 1]);
    const totals = res.sets.map((s) => s.totalRating);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(10);
    // 22 players, 4×5 → 2 subs
    expect(res.sets.flatMap((s) => s.players).filter((p) => p.role === "sub")).toHaveLength(2);
    expect(res.warnings.join(" ")).toMatch(/substitutes/);
  });

  it("random: deterministic per seed and balanced sizes", () => {
    const a = randomTeams(pool, 4, 5, seededRandom(1));
    const b = randomTeams(pool, 4, 5, seededRandom(1));
    expect(a.sets).toEqual(b.sets);
    expect(a.sets.map((s) => s.players.length).sort()).toEqual([5, 5, 6, 6]);
  });

  it("handles insufficient players explicitly", () => {
    expect(() => balancedTeams(pool.slice(0, 7), 4, 5, seededRandom(1))).toThrow(TeamSelectionError);
    const short = balancedTeams(pool.slice(0, 10), 4, 5, seededRandom(1));
    expect(short.warnings[0]).toMatch(/short-handed/);
  });

  it("rejects duplicate pool entries", () => {
    expect(() => randomTeams([...pool, pool[0]!], 4, 5, seededRandom(1))).toThrow(/duplicates/);
  });

  it("validates published assignments: no duplicates and only eligible players", () => {
    const eligible = new Set(["p1", "p2", "p3", "p4"]);
    expect(validateAssignment([{ idx: 1, players: [{ playerId: "p1" }, { playerId: "p2" }] }, { idx: 2, players: [{ playerId: "p3" }] }], 2, eligible)).toBeNull();
    expect(validateAssignment([{ idx: 1, players: [{ playerId: "p1" }] }, { idx: 2, players: [{ playerId: "p1" }] }], 2, eligible)).toMatch(/two sets/);
    expect(validateAssignment([{ idx: 1, players: [{ playerId: "p1" }] }, { idx: 2, players: [{ playerId: "zz" }] }], 2, eligible)).toMatch(/approved/);
    expect(validateAssignment([{ idx: 1, players: [{ playerId: "p1" }] }], 2, eligible)).toMatch(/Expected/);
  });
});

describe("timezone helpers", () => {
  it("converts Africa/Lagos wall time to UTC and back", () => {
    expect(zonedToUtcIso("2026-10-17", "07:30", "Africa/Lagos")).toBe("2026-10-17T06:30:00.000Z");
    expect(utcToZoned("2026-10-17T06:30:00.000Z", "Africa/Lagos")).toEqual({ date: "2026-10-17", time: "07:30" });
  });
  it("handles DST zones", () => {
    expect(zonedToUtcIso("2026-07-01", "12:00", "Europe/London")).toBe("2026-07-01T11:00:00.000Z");
    expect(zonedToUtcIso("2026-12-01", "12:00", "Europe/London")).toBe("2026-12-01T12:00:00.000Z");
  });
});

import { chooseSetForLateGuest, guestSlotsLeft } from "../src/shared/rules";

describe("late guests", () => {
  const fills = [
    { setId: "A", idx: 1, size: 5, totalRating: 30 },
    { setId: "B", idx: 2, size: 4, totalRating: 26 },
    { setId: "C", idx: 3, size: 4, totalRating: 22 },
    { setId: "D", idx: 4, size: 3, totalRating: 25 },
  ];
  it("joins the smallest set with room, then the weakest, then the lowest number", () => {
    expect(chooseSetForLateGuest(fills, 5)!.setId).toBe("D");
    expect(chooseSetForLateGuest(fills.filter((f) => f.setId !== "D"), 5)!.setId).toBe("C");
    expect(chooseSetForLateGuest([{ setId: "X", idx: 2, size: 4, totalRating: 20 }, { setId: "Y", idx: 1, size: 4, totalRating: 20 }], 5)!.setId).toBe("Y");
  });
  it("returns null when every set has 5", () => {
    expect(chooseSetForLateGuest(fills.map((f) => ({ ...f, size: 5 })), 5)).toBeNull();
  });
  it("counts guest spots from team sizes, capped by capacity", () => {
    expect(guestSlotsLeft(fills, 5, 30, 16)).toBe(4); // 0+1+1+2
    expect(guestSlotsLeft(fills, 5, 18, 16)).toBe(2); // capacity limits it
    expect(guestSlotsLeft(fills.map((f) => ({ ...f, size: 5 })), 5, 30, 20)).toBe(0);
  });
});

import { applyWallet, guestFeeFor, nextMembershipPeriod, renewalStatus } from "../src/shared/rules";

describe("paid access rules", () => {
  it("charges guests per match day until 5 paid days in the season, then free", () => {
    expect(guestFeeFor(0, 5000, 5)).toEqual({ amount: 5000, free: false });
    expect(guestFeeFor(4, 5000, 5)).toEqual({ amount: 5000, free: false });
    expect(guestFeeFor(5, 5000, 5)).toEqual({ amount: 0, free: true });
    expect(guestFeeFor(9, 5000, 5)).toEqual({ amount: 0, free: true });
  });
  it("applies wallet credit first, never more than the total or balance", () => {
    expect(applyWallet(100000, 1500, true)).toEqual({ wallet: 1500, external: 98500 });
    expect(applyWallet(2000, 3500, true)).toEqual({ wallet: 2000, external: 0 });
    expect(applyWallet(2000, 3500, false)).toEqual({ wallet: 0, external: 2000 });
    expect(applyWallet(2000, 0, true)).toEqual({ wallet: 0, external: 2000 });
  });
  it("extends membership by six months from the later of today or the current expiry", () => {
    expect(nextMembershipPeriod(null, "2026-10-20", 6)).toEqual({ start: "2026-10-20", end: "2027-04-19" });
    expect(nextMembershipPeriod("2026-12-31", "2026-10-20", 6)).toEqual({ start: "2027-01-01", end: "2027-06-30" });
    expect(nextMembershipPeriod("2026-01-31", "2026-10-20", 6)).toEqual({ start: "2026-10-20", end: "2027-04-19" });
  });
  it("only reminds about renewal; guests aren't members", () => {
    expect(renewalStatus("guest", null, "2026-10-20")).toBe("not_member");
    expect(renewalStatus("member", "2027-04-19", "2026-10-20")).toBe("current");
    expect(renewalStatus("member", "2026-11-10", "2026-10-20")).toBe("due_soon");
    expect(renewalStatus("member", "2026-10-01", "2026-10-20")).toBe("overdue");
  });
});

import { isoWeekday, parseWeekdays, scheduledDates } from "../src/shared/rules";

describe("weekly schedule", () => {
  it("finds ISO weekdays and the scheduled dates in a window", () => {
    expect(isoWeekday("2026-10-19")).toBe(1); // Monday
    expect(isoWeekday("2026-10-25")).toBe(7); // Sunday
    expect(parseWeekdays("6, 2,2, 9, x")).toEqual([2, 6]);
    expect(scheduledDates("2026-10-19", 14, [2, 6])).toEqual(["2026-10-20", "2026-10-24", "2026-10-27", "2026-10-31"]);
    expect(scheduledDates("2026-10-19", 7, [])).toEqual([]);
  });
});

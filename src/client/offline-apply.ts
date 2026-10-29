import type { DayCard, Goal, Match, MatchDayDetail } from "./types";

/**
 * Apply a queued (offline) action to the cached match day the way the server will, so the screen keeps
 * up at the pitch. The server's response replaces this copy once the request is sent; derived parts
 * (set records, the daily winner, finalization issues) only refresh then.
 */
type Patch = (d: MatchDayDetail) => MatchDayDetail;

function withMatch(d: MatchDayDetail, matchId: string, f: (m: Match) => Match): MatchDayDetail {
  return { ...d, matches: d.matches.map((m) => (m.id === matchId ? reconcile(f(m)) : m)) };
}

function reconcile(m: Match): Match {
  const home = m.goals.filter((g) => g.setId === m.homeSetId).length;
  const away = m.goals.filter((g) => g.setId === m.awaySetId).length;
  return { ...m, reconciled: home === m.homeScore && away === m.awayScore };
}

const side = (m: Match, setId: string) => (setId === m.homeSetId ? "homeScore" : "awayScore");

export const offlineApply = {
  start: (): Patch => (d) => ({ ...d, day: { ...d.day, status: "in_progress" } }),

  createMatch:
    (v: { id: string; homeSetId: string; awaySetId: string; isPlayoff: boolean; final?: { homeScore: number; awayScore: number } }): Patch =>
    (d) => {
      const goals: Goal[] = [];
      const add = (setId: string, n: number) => {
        for (let i = 0; i < n; i++) goals.push({ id: crypto.randomUUID(), setId, kind: "unattributed", scorerPlayerId: null, assistPlayerId: null });
      };
      if (v.final) {
        add(v.homeSetId, v.final.homeScore);
        add(v.awaySetId, v.final.awayScore);
      }
      const match: Match = {
        id: v.id,
        seq: Math.max(0, ...d.matches.map((m) => m.seq)) + 1,
        homeSetId: v.homeSetId,
        awaySetId: v.awaySetId,
        homeScore: v.final?.homeScore ?? 0,
        awayScore: v.final?.awayScore ?? 0,
        status: v.final || d.day.status === "finalized" ? "completed" : "in_progress",
        isPlayoff: v.isPlayoff,
        reconciled: true,
        goals,
      };
      return { ...d, matches: [...d.matches, match] };
    },

  updateMatch:
    (matchId: string, v: { homeScore?: number; awayScore?: number; status?: string }): Patch =>
    (d) =>
      withMatch(d, matchId, (m) => ({
        ...m,
        homeScore: v.homeScore ?? m.homeScore,
        awayScore: v.awayScore ?? m.awayScore,
        status: (v.status as Match["status"]) ?? m.status,
      })),

  addGoal:
    (matchId: string, goal: Goal): Patch =>
    (d) =>
      withMatch(d, matchId, (m) => ({ ...m, goals: [...m.goals, goal], [side(m, goal.setId)]: m[side(m, goal.setId)] + 1 })),

  deleteGoal:
    (goalId: string): Patch =>
    (d) => {
      const m = d.matches.find((x) => x.goals.some((g) => g.id === goalId));
      if (!m) return d;
      const col = side(m, m.goals.find((g) => g.id === goalId)!.setId);
      return withMatch(d, m.id, (x) => ({ ...x, goals: x.goals.filter((g) => g.id !== goalId), [col]: Math.max(0, x[col] - 1) }));
    },

  attributeGoal:
    (goalId: string, v: { kind: "normal" | "own_goal"; scorerPlayerId: string; assistPlayerId: string | null }): Patch =>
    (d) => {
      const m = d.matches.find((x) => x.goals.some((g) => g.id === goalId));
      if (!m) return d;
      const next = { kind: v.kind, scorerPlayerId: v.scorerPlayerId, assistPlayerId: v.kind === "normal" ? v.assistPlayerId : null };
      return withMatch(d, m.id, (x) => ({ ...x, goals: x.goals.map((g) => (g.id === goalId ? { ...g, ...next } : g)) }));
    },

  attendance:
    (playerId: string, attended: boolean | null): Patch =>
    (d) => ({
      ...d,
      registrations: d.registrations.map((r) => (r.playerId === playerId ? { ...r, attended } : r)),
      sets: d.sets.map((s) => ({ ...s, players: s.players.map((p) => (p.playerId === playerId ? { ...p, attended } : p)) })),
    }),

  giveCard:
    (card: Omit<DayCard, "displayName" | "fineAmount" | "fineStatus" | "voided">): Patch =>
    (d) => {
      const displayName = d.sets.flatMap((s) => s.players).find((p) => p.playerId === card.playerId)?.displayName ?? "";
      return { ...d, cards: [...d.cards, { ...card, displayName, fineAmount: null, fineStatus: null, voided: false }] };
    },
};

import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { goalLabel, SetTable, WinnerBanner } from "../components/matchday";
import { Badge, Button, Card, CardIcon, ConfirmDialog, cx, ErrorBox, GuestBadge, Input, Loading, PageHeader, Segmented, SetChip, useToast } from "../components/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatMoney } from "../../shared/rules";
import { useMe } from "../hooks";
import { formatDateLong } from "../format";
import { useDayMutation, useMatchDay } from "../hooks";
import type { Match, MatchDayDetail, TeamSet } from "../types";

type GoalDraft = {
  matchId: string;
  setId: string;
  step: "scorer" | "assist";
  kind: "normal" | "own_goal" | "unattributed";
  scorerPlayerId: string | null;
  /** When set, the sheet names the scorer of this existing unattributed goal instead of adding a goal. */
  attributeGoalId?: string;
};

export default function LiveResultsPage() {
  const { id } = useParams();
  const { data, isLoading, error } = useMatchDay(id);
  const [goal, setGoal] = useState<GoalDraft | null>(null);
  // For finalized days every change needs a reason: queue the action until one is given.
  const [needsReason, setNeedsReason] = useState<null | { label: string; run: (reason: string) => void }>(null);

  const createMatch = useDayMutation(id!, (v: { homeSetId: string; awaySetId: string; isPlayoff: boolean; final?: { homeScore: number; awayScore: number }; reason?: string }) =>
    api.post(`/matchdays/${id}/matches`, { id: crypto.randomUUID(), ...v }),
    "Result saved",
  );
  const updateMatch = useDayMutation(id!, (v: { matchId: string; reason?: string; homeScore?: number; awayScore?: number; status?: string }) => {
    const { matchId, ...rest } = v;
    return api.patch(`/matches/${matchId}`, rest);
  });
  const attribute = useDayMutation(id!, (v: { goalId: string; kind: "normal" | "own_goal"; scorerPlayerId: string; assistPlayerId: string | null; reason?: string }) => {
    const { goalId, ...rest } = v;
    return api.post(`/goals/${goalId}/attribute`, rest);
  }, "Scorer saved");
  const start = useDayMutation(id!, () => api.post(`/matchdays/${id}/start`), "Play started — rosters are locked");
  const addGoal = useDayMutation(id!, (v: { matchId: string; setId: string; kind: string; scorerPlayerId: string | null; assistPlayerId: string | null; reason?: string }) => {
    const { matchId, ...rest } = v;
    return api.post(`/matches/${matchId}/goals`, { id: crypto.randomUUID(), ...rest });
  }, "Goal recorded");
  const deleteGoal = useDayMutation(id!, (v: { goalId: string; reason?: string }) => api.post(`/goals/${v.goalId}/delete`, { reason: v.reason }), "Goal removed");

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data!;
  const finalized = d.day.status === "finalized";
  const editable = d.day.status === "in_progress" || finalized;
  const live = d.matches.find((m) => m.status === "in_progress");
  const setById = new Map(d.sets.map((s) => [s.id, s]));
  const guarded = (label: string, run: (reason?: string) => void) => (finalized ? setNeedsReason({ label, run }) : run());

  const submitGoal = (g: GoalDraft, assistPlayerId: string | null) => {
    if (g.attributeGoalId) {
      const goalId = g.attributeGoalId;
      if (g.kind !== "unattributed") guarded("Name scorer", (reason) => attribute.mutate({ goalId, kind: g.kind as "normal" | "own_goal", scorerPlayerId: g.scorerPlayerId!, assistPlayerId, reason }));
    } else {
      guarded("Add goal", (reason) => addGoal.mutate({ matchId: g.matchId, setId: g.setId, kind: g.kind, scorerPlayerId: g.scorerPlayerId, assistPlayerId, reason }));
    }
    setGoal(null);
  };
  const nameScorer = (matchId: string, goal: { id: string; setId: string }) => setGoal({ matchId, setId: goal.setId, step: "scorer", kind: "normal", scorerPlayerId: null, attributeGoalId: goal.id });

  return (
    <div className="space-y-5 pb-8">
      <PageHeader
        title={finalized ? "Correct results" : "Live results"}
        kicker={formatDateLong(d.day.date)}
        action={
          <div className="flex items-center gap-3">
            {d.day.status === "in_progress" && (
              <Link to={`/matchdays/${id}/add-guest`}><Button size="sm" variant="secondary">+ Guest{d.guestSlots != null && ` (${d.guestSlots})`}</Button></Link>
            )}
            <Link to={`/matchdays/${id}`} className="text-sm font-semibold text-pitch-700">← Day</Link>
          </div>
        }
      />
      {!editable && d.day.status === "cancelled" && <ErrorBox error={new Error("This day was cancelled.")} />}
      {!editable && ["checkin_open", "locked"].includes(d.day.status) && (
        <Card className="space-y-3 bg-chalk p-5">
          <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Ready to play?</h2>
          {d.sets.length === 0 ? (
            <>
              <p className="text-sm text-muted">Pick and publish teams first — results are recorded between teams.</p>
              <Link to={`/matchdays/${id}/teams`}><Button>Pick teams</Button></Link>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">Starting play locks the teams. Then record each match below.</p>
              <Button size="lg" loading={start.isPending} onClick={() => start.mutate(undefined)}>Start play</Button>
            </>
          )}
        </Card>
      )}
      {!editable && d.day.status === "draft" && <ErrorBox error={new Error("Open check-in and pick teams before recording results.")} />}
      {finalized && <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">This day is finalized. Each change asks for a reason, is audited, and recalculates points.</div>}

      {editable && live && (
        <Scoreboard
          detail={d}
          match={live}
          onGoal={(setId) => setGoal({ matchId: live.id, setId, step: "scorer", kind: "normal", scorerPlayerId: null })}
          onFullTime={() => updateMatch.mutate({ matchId: live.id, status: "completed" })}
          onVoid={() => updateMatch.mutate({ matchId: live.id, status: "void" })}
          onDeleteGoal={(goalId) => deleteGoal.mutate({ goalId })}
          busy={addGoal.isPending || updateMatch.isPending}
        />
      )}

      {editable && !live && <NewMatch detail={d} busy={createMatch.isPending} onCreate={(v) => guarded("Add match", (reason) => createMatch.mutate({ ...v, reason }))} />}

      {d.matches.some((m) => m.status !== "in_progress") && (
        <section className="space-y-2">
          <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Matches</h2>
          {[...d.matches].reverse().filter((m) => m.status !== "in_progress").map((m) => (
            <PastMatch
              key={m.id}
              detail={d}
              match={m}
              home={setById.get(m.homeSetId)!}
              away={setById.get(m.awaySetId)!}
              editable={editable}
              onScore={(side, delta) => {
                const homeScore = side === "home" ? Math.max(0, m.homeScore + delta) : m.homeScore;
                const awayScore = side === "away" ? Math.max(0, m.awayScore + delta) : m.awayScore;
                guarded("Change score", (reason) => updateMatch.mutate({ matchId: m.id, homeScore, awayScore, reason }));
              }}
              onStatus={(status) => guarded(status === "void" ? "Void match" : "Restore match", (reason) => updateMatch.mutate({ matchId: m.id, status, reason }))}
              onGoal={(setId) => setGoal({ matchId: m.id, setId, step: "scorer", kind: "normal", scorerPlayerId: null })}
              onDeleteGoal={(goalId) => guarded("Remove goal", (reason) => deleteGoal.mutate({ goalId, reason }))}
              onNameScorer={(g) => nameScorer(m.id, g)}
            />
          ))}
        </section>
      )}

      {editable && <CardsSection detail={d} liveMatchId={live?.id ?? null} />}

      {d.sets.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Standings today</h2>
          <WinnerBanner detail={d} />
          <SetTable detail={d} />
          {d.day.status === "in_progress" && (
            <Card className="p-4">
              {d.issues.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
                  {d.issues.map((i) => (
                    <li key={i.message}>{i.message}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm font-semibold text-pitch-800">Everything reconciles. Finalize from the match day page when play is over.</p>
              )}
              <Link to={`/matchdays/${id}`} className="mt-3 inline-block">
                <Button variant="secondary">Go to finalize</Button>
              </Link>
            </Card>
          )}
        </section>
      )}

      {goal && <GoalSheet detail={d} draft={goal} onChange={setGoal} onSubmit={submitGoal} onClose={() => setGoal(null)} />}
      <ConfirmDialog
        open={!!needsReason}
        title={needsReason?.label ?? ""}
        requireReason
        confirmLabel="Save correction"
        onClose={() => setNeedsReason(null)}
        onConfirm={(reason) => {
          needsReason?.run(reason);
          setNeedsReason(null);
        }}
      >
        Recorded with your name and the time in the audit log.
      </ConfirmDialog>
    </div>
  );
}

function Scoreboard({ detail, match, onGoal, onFullTime, onVoid, onDeleteGoal, busy }: { detail: MatchDayDetail; match: Match; onGoal: (setId: string) => void; onFullTime: () => void; onVoid: () => void; onDeleteGoal: (id: string) => void; busy: boolean }) {
  const home = detail.sets.find((s) => s.id === match.homeSetId)!;
  const away = detail.sets.find((s) => s.id === match.awaySetId)!;
  const [confirmVoid, setConfirmVoid] = useState(false);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <span className="text-sm font-semibold">Match #{match.seq}</span>
        <span className="flex items-center gap-2">
          {match.isPlayoff && <Badge tone="gold">Playoff</Badge>}
          <Badge tone="blue">Live</Badge>
        </span>
      </div>
      <div className="grid grid-cols-2">
        {[home, away].map((s, i) => (
          <div key={s.id} className={cx("flex flex-col items-center gap-3 p-5", i === 0 && "border-r border-line")}>
            <span className="h-1.5 w-12 rounded-full" style={{ background: s.color === "#f8fafc" ? "#d6d6d0" : s.color }} aria-hidden />
            <div className="text-xl font-medium tracking-[-0.02em]">{s.name}</div>
            <div className="num stat text-[96px] leading-none">{i === 0 ? match.homeScore : match.awayScore}</div>
            <Button size="lg" className="w-full" disabled={busy} onClick={() => onGoal(s.id)}>
              + Goal
            </Button>
          </div>
        ))}
      </div>
      {match.goals.length > 0 && (
        <ul className="divide-y divide-line border-t border-line text-sm">
          {match.goals.map((g) => (
            <li key={g.id} className="flex min-h-11 items-center gap-2 px-4">
              <span className="size-2.5 rounded-full" style={{ background: detail.sets.find((s) => s.id === g.setId)?.color }} />
              <span className="flex-1">{goalLabel(detail, g)}</span>
              <button className="rounded-md px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => onDeleteGoal(g.id)}>
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 border-t border-line p-3">
        <Button className="flex-1" size="lg" variant="secondary" onClick={onFullTime} disabled={busy}>
          Full time
        </Button>
        <Button variant="ghost" onClick={() => setConfirmVoid(true)}>
          Void
        </Button>
      </div>
      <ConfirmDialog open={confirmVoid} title="Void this match?" tone="danger" confirmLabel="Void" onClose={() => setConfirmVoid(false)} onConfirm={() => { onVoid(); setConfirmVoid(false); }}>
        Voided matches don't count for wins, goals or assists.
      </ConfirmDialog>
    </Card>
  );
}

function NewMatch({ detail, onCreate, busy }: { detail: MatchDayDetail; onCreate: (v: { homeSetId: string; awaySetId: string; isPlayoff: boolean; final?: { homeScore: number; awayScore: number } }) => void; busy: boolean }) {
  const [mode, setMode] = useState<"final" | "live">("final");
  const [picked, setPicked] = useState<string[]>([]);
  const [isPlayoff, setIsPlayoff] = useState(false);
  const [score, setScore] = useState<[number, number]>([0, 0]);
  const toggle = (sid: string) => setPicked((p) => (p.includes(sid) ? p.filter((x) => x !== sid) : p.length < 2 ? [...p, sid] : [p[1]!, sid]));
  const setById = new Map(detail.sets.map((s) => [s.id, s]));
  const save = () => {
    onCreate({ homeSetId: picked[0]!, awaySetId: picked[1]!, isPlayoff, ...(mode === "final" ? { final: { homeScore: score[0], awayScore: score[1] } } : {}) });
    setPicked([]);
    setScore([0, 0]);
  };
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">{detail.matches.length ? "Record next match" : "Record a match"}</h2>
        <Segmented label="How to record" value={mode} onChange={setMode} options={[{ value: "final", label: "Final score" }, { value: "live", label: "Live, goal by goal" }]} />
      </div>
      <p className="text-sm text-muted">
        {mode === "final" ? "Pick the two teams and enter the final score. You can name the scorers afterwards." : "Pick the two teams and kick off; tap + Goal as goals go in."}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {detail.sets.map((s) => (
          <button
            key={s.id}
            onClick={() => toggle(s.id)}
            aria-pressed={picked.includes(s.id)}
            className={cx("flex min-h-14 items-center gap-2 rounded-2xl border-2 px-3 text-left", picked.includes(s.id) ? "border-pitch-700 bg-pitch-50" : "border-line bg-white")}
          >
            <SetChip name={s.name} color={s.color} className="font-medium" />
            <span className="ml-auto num text-xs text-muted">{s.record?.wins ?? 0}W</span>
          </button>
        ))}
      </div>
      {mode === "final" && picked.length === 2 && (
        <div className="grid grid-cols-2 gap-3">
          {[0, 1].map((side) => {
            const set = setById.get(picked[side]!)!;
            return (
              <div key={side} className="flex flex-col items-center gap-2 rounded-[22px] border border-line bg-chalk p-4">
                <SetChip name={set.name} color={set.color} />
                <div className="flex items-center gap-4">
                  <Button variant="secondary" aria-label={`Lower ${set.name} score`} onClick={() => setScore((sc) => (side === 0 ? [Math.max(0, sc[0] - 1), sc[1]] : [sc[0], Math.max(0, sc[1] - 1)]))}>−</Button>
                  <span className="num stat w-16 text-center text-[64px]">{score[side]}</span>
                  <Button variant="secondary" aria-label={`Raise ${set.name} score`} onClick={() => setScore((sc) => (side === 0 ? [sc[0] + 1, sc[1]] : [sc[0], sc[1] + 1]))}>+</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {detail.day.tiePolicy === "playoff" && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="size-5 accent-pitch-700" checked={isPlayoff} onChange={(e) => setIsPlayoff(e.target.checked)} />
          This is a playoff match (decides a tie on wins)
        </label>
      )}
      <Button size="lg" className="w-full" disabled={picked.length !== 2} loading={busy} onClick={save}>
        {mode === "final" ? (picked.length === 2 ? `Save result ${score[0]}–${score[1]}` : "Save result") : "Kick off"}
      </Button>
    </Card>
  );
}

function PastMatch({ detail, match, home, away, editable, onScore, onStatus, onGoal, onDeleteGoal, onNameScorer }: {
  onNameScorer: (g: { id: string; setId: string }) => void;
  detail: MatchDayDetail;
  match: Match;
  home: TeamSet;
  away: TeamSet;
  editable: boolean;
  onScore: (side: "home" | "away", delta: number) => void;
  onStatus: (s: "completed" | "void") => void;
  onGoal: (setId: string) => void;
  onDeleteGoal: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className={cx(match.status === "void" && "opacity-60")}>
      <button className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="w-6 text-xs font-semibold text-muted">#{match.seq}</span>
        <SetChip name={home.name} color={home.color} className="flex-1 justify-end" />
        <span className="num display rounded-lg bg-stone-100 px-2 py-1 text-xl font-bold">
          {match.homeScore}–{match.awayScore}
        </span>
        <SetChip name={away.name} color={away.color} className="flex-1" />
        {!match.reconciled && match.status !== "void" && <Badge tone="red">!</Badge>}
        {match.status === "void" && <Badge tone="red">Void</Badge>}
      </button>
      {open && (
        <div className="space-y-3 border-t border-line p-3">
          {!match.reconciled && match.status !== "void" && <p className="text-sm text-red-700">Goal events don't add up to the score. Add or remove goals, or fix the score.</p>}
          {match.goals.length > 0 && (
            <ul className="space-y-1 text-sm">
              {match.goals.map((g) => (
                <li key={g.id} className="flex min-h-10 items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ background: detail.sets.find((s) => s.id === g.setId)?.color }} />
                  <span className="flex-1">{goalLabel(detail, g)}</span>
                  {editable && g.kind === "unattributed" && (
                    <button className="rounded-full border border-pitch-700/40 px-3 py-1 text-xs font-medium text-pitch-800 hover:border-pitch-700" onClick={() => onNameScorer(g)}>Who scored?</button>
                  )}
                  {editable && <button className="rounded-md px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => onDeleteGoal(g.id)}>Remove</button>}
                </li>
              ))}
            </ul>
          )}
          {editable && match.status !== "void" && (
            <div className="grid grid-cols-2 gap-2">
              {([["home", home], ["away", away]] as const).map(([side, s]) => (
                <div key={side} className="space-y-2 rounded-xl bg-stone-50 p-2">
                  <div className="text-center text-sm font-semibold">{s.name}</div>
                  <Button size="sm" className="w-full" onClick={() => onGoal(s.id)}>+ Goal</Button>
                  <div className="flex items-center justify-center gap-2">
                    <Button size="sm" variant="secondary" aria-label={`Lower ${s.name} score`} onClick={() => onScore(side, -1)}>−</Button>
                    <span className="text-xs text-muted">score only</span>
                    <Button size="sm" variant="secondary" aria-label={`Raise ${s.name} score`} onClick={() => onScore(side, 1)}>+</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {editable && (
            <div className="flex justify-end">
              {match.status === "void" ? (
                <Button size="sm" variant="secondary" onClick={() => onStatus("completed")}>Restore match</Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => onStatus("void")}>Void match</Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function GoalSheet({ detail, draft, onChange, onSubmit, onClose }: { detail: MatchDayDetail; draft: GoalDraft; onChange: (d: GoalDraft) => void; onSubmit: (d: GoalDraft, assist: string | null) => void; onClose: () => void }) {
  const match = detail.matches.find((m) => m.id === draft.matchId)!;
  const credited = detail.sets.find((s) => s.id === draft.setId)!;
  const opponent = detail.sets.find((s) => s.id === (draft.setId === match.homeSetId ? match.awaySetId : match.homeSetId))!;
  const own = credited.players.filter((p) => p.attended !== false);
  const opp = opponent.players.filter((p) => p.attended !== false);
  const grid = (players: TeamSet["players"], pick: (pid: string) => void, exclude?: string | null) => (
    <div className="grid grid-cols-2 gap-2">
      {players.filter((p) => p.playerId !== exclude).map((p) => (
        <button key={p.playerId} onClick={() => pick(p.playerId)} className="flex min-h-14 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-left font-semibold active:bg-pitch-50">
          <span className="truncate">{p.displayName}</span>
          {p.kind === "guest" && <GuestBadge />}
        </button>
      ))}
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label="Record goal">
      <div className="max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl bg-chalk p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-3xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">
            Goal · <SetChip name={credited.name} color={credited.color} />
          </h3>
          <button onClick={onClose} className="min-h-11 rounded-lg px-3 font-semibold text-muted">Cancel</button>
        </div>
        {draft.step === "scorer" ? (
          <div className="space-y-4">
            <div>
              <div className="mb-2 text-sm font-semibold text-muted">Who scored?</div>
              {grid(own, (pid) => onChange({ ...draft, kind: "normal", scorerPlayerId: pid, step: "assist" }))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={() => onSubmit({ ...draft, kind: "unattributed", scorerPlayerId: null }, null)}>Not sure who</Button>
              <Button variant="secondary" onClick={() => onChange({ ...draft, kind: "own_goal", step: "scorer", scorerPlayerId: "__own" })}>Own goal…</Button>
            </div>
            {draft.scorerPlayerId === "__own" && (
              <div>
                <div className="mb-2 text-sm font-semibold text-muted">Own goal by ({opponent.name})</div>
                {grid(opp, (pid) => onSubmit({ ...draft, kind: "own_goal", scorerPlayerId: pid }, null))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm font-semibold text-muted">Assist?</div>
            <Button size="lg" className="w-full" onClick={() => onSubmit(draft, null)}>No assist</Button>
            {grid(own, (pid) => onSubmit(draft, pid), draft.scorerPlayerId)}
          </div>
        )}
      </div>
    </div>
  );
}

function CardsSection({ detail, liveMatchId }: { detail: MatchDayDetail; liveMatchId: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState<"yellow" | "red">("yellow");
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["matchday", detail.day.id] });
    qc.invalidateQueries({ queryKey: ["admin-fines"] });
  };
  const give = useMutation({
    mutationFn: (playerId: string) => api.post(`/matchdays/${detail.day.id}/cards`, { id: crypto.randomUUID(), playerId, color, matchId: liveMatchId, reason: reason || undefined }),
    onSuccess: (r: { card: { fineAmount: number; displayName?: string } }) => {
      refresh();
      setOpen(false);
      setReason("");
      toast(`${color === "yellow" ? "Yellow" : "Red"} card given · fine ${formatMoney(r.card.fineAmount, me?.currency ?? "NGN")}`);
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const voidCard = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.post(`/cards/${v.id}/void`, { reason: v.reason }),
    onSuccess: refresh,
    onError: (e: Error) => toast(e.message, "error"),
  });
  const players = detail.sets.flatMap((s) => s.players.map((p) => ({ ...p, set: s }))).filter((p) => p.attended !== false);
  const cards = detail.cards.filter((k) => !k.voided);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Cards</h2>
        <div className="flex gap-2">
          <Button size="sm" className="!bg-yellow-400 !text-ink" onClick={() => { setColor("yellow"); setOpen(true); }}>+ Yellow</Button>
          <Button size="sm" className="!bg-red-600" onClick={() => { setColor("red"); setOpen(true); }}>+ Red</Button>
        </div>
      </div>
      {cards.length === 0 ? <p className="text-sm text-muted">No cards today.</p> : (
        <Card>
          <ul className="divide-y divide-line">
            {cards.map((k) => (
              <li key={k.id} className="flex min-h-11 items-center gap-2 px-4 text-sm">
                <CardIcon color={k.color} />
                <span className="flex-1">{k.displayName}{k.reason && <span className="text-muted"> · {k.reason}</span>}</span>
                {k.fineAmount != null && <span className="num text-muted">{formatMoney(k.fineAmount, me?.currency ?? "NGN")}</span>}
                <button className="rounded-md px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50" onClick={() => setVoiding(k.id)}>Void</button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/40 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-label={`Give ${color} card`}>
          <div className="max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl bg-chalk p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-3xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-[26px] font-medium tracking-[-0.025em]"><CardIcon color={color} className="!h-6 !w-4" /> {color} card</h3>
              <button onClick={() => setOpen(false)} className="min-h-11 rounded-lg px-3 font-semibold text-muted">Cancel</button>
            </div>
            <Input placeholder="Reason (optional), e.g. Dissent" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className="mb-3" />
            <div className="mb-2 text-sm font-semibold text-muted">Who?</div>
            <div className="grid grid-cols-2 gap-2">
              {players.map((p) => (
                <button key={p.playerId} disabled={give.isPending} onClick={() => give.mutate(p.playerId)} className="flex min-h-14 items-center gap-2 rounded-xl border border-line bg-white px-3 text-left font-semibold active:bg-pitch-50">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.set.color }} />
                  <span className="truncate">{p.displayName}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog open={!!voiding} title="Void this card?" requireReason tone="danger" confirmLabel="Void card" onClose={() => setVoiding(null)}
        onConfirm={(r) => voidCard.mutate({ id: voiding!, reason: r }, { onSettled: () => setVoiding(null) })}>
        Removes the card and cancels its fine. Recorded in the audit log.
      </ConfirmDialog>
    </section>
  );
}

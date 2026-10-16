import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { goalLabel, SetTable, WinnerBanner } from "../components/matchday";
import { Badge, Button, Card, ConfirmDialog, cx, ErrorBox, GuestBadge, Loading, PageHeader, SetChip } from "../components/ui";
import { formatDateLong } from "../format";
import { useDayMutation, useMatchDay } from "../hooks";
import type { Match, MatchDayDetail, TeamSet } from "../types";

type GoalDraft = { matchId: string; setId: string; step: "scorer" | "assist"; kind: "normal" | "own_goal" | "unattributed"; scorerPlayerId: string | null };

export default function LiveResultsPage() {
  const { id } = useParams();
  const { data, isLoading, error } = useMatchDay(id);
  const [goal, setGoal] = useState<GoalDraft | null>(null);
  // For finalized days every change needs a reason: queue the action until one is given.
  const [needsReason, setNeedsReason] = useState<null | { label: string; run: (reason: string) => void }>(null);

  const createMatch = useDayMutation(id!, (v: { homeSetId: string; awaySetId: string; isPlayoff: boolean; reason?: string }) =>
    api.post(`/matchdays/${id}/matches`, { id: crypto.randomUUID(), ...v }),
  );
  const updateMatch = useDayMutation(id!, (v: { matchId: string; reason?: string; homeScore?: number; awayScore?: number; status?: string }) => {
    const { matchId, ...rest } = v;
    return api.patch(`/matches/${matchId}`, rest);
  });
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
    guarded("Add goal", (reason) => addGoal.mutate({ matchId: g.matchId, setId: g.setId, kind: g.kind, scorerPlayerId: g.scorerPlayerId, assistPlayerId, reason }));
    setGoal(null);
  };

  return (
    <div className="space-y-5 pb-8">
      <PageHeader
        title={finalized ? "Correct results" : "Live results"}
        kicker={formatDateLong(d.day.date)}
        action={<Link to={`/matchdays/${id}`} className="text-sm font-semibold text-pitch-700">← Day</Link>}
      />
      {!editable && <ErrorBox error={new Error(d.day.status === "cancelled" ? "This day was cancelled." : "Start play from the match day page first.")} />}
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
          <h2 className="display text-2xl font-bold uppercase text-pitch-900">Matches</h2>
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
            />
          ))}
        </section>
      )}

      {d.sets.length > 0 && (
        <section className="space-y-3">
          <h2 className="display text-2xl font-bold uppercase text-pitch-900">Standings today</h2>
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
      <div className="flex items-center justify-between bg-pitch-900 px-4 py-2 text-white">
        <span className="text-sm font-semibold">Match #{match.seq}</span>
        <span className="flex items-center gap-2">
          {match.isPlayoff && <Badge tone="gold">Playoff</Badge>}
          <Badge tone="blue">Live</Badge>
        </span>
      </div>
      <div className="grid grid-cols-2">
        {[home, away].map((s, i) => (
          <div key={s.id} className={cx("flex flex-col items-center gap-3 p-4", i === 0 && "border-r border-line")} style={{ borderTop: `6px solid ${s.color}` }}>
            <div className="display text-xl font-bold uppercase">{s.name}</div>
            <div className="num display text-7xl font-bold leading-none">{i === 0 ? match.homeScore : match.awayScore}</div>
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

function NewMatch({ detail, onCreate, busy }: { detail: MatchDayDetail; onCreate: (v: { homeSetId: string; awaySetId: string; isPlayoff: boolean }) => void; busy: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [isPlayoff, setIsPlayoff] = useState(false);
  const toggle = (sid: string) => setPicked((p) => (p.includes(sid) ? p.filter((x) => x !== sid) : p.length < 2 ? [...p, sid] : [p[1]!, sid]));
  return (
    <Card className="p-4">
      <h2 className="display text-2xl font-bold uppercase text-pitch-900">{detail.matches.length ? "Next match" : "First match"}</h2>
      <p className="text-sm text-muted">Tap the two sets that are playing.</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {detail.sets.map((s) => (
          <button
            key={s.id}
            onClick={() => toggle(s.id)}
            aria-pressed={picked.includes(s.id)}
            className={cx("flex min-h-14 items-center gap-2 rounded-xl border-2 px-3 text-left font-semibold", picked.includes(s.id) ? "border-pitch-600 bg-pitch-50" : "border-line bg-white")}
          >
            <SetChip name={s.name} color={s.color} />
            <span className="ml-auto num text-xs text-muted">{s.record?.wins ?? 0}W</span>
          </button>
        ))}
      </div>
      {detail.day.tiePolicy === "playoff" && (
        <label className="mt-3 flex min-h-11 items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-5 accent-pitch-700" checked={isPlayoff} onChange={(e) => setIsPlayoff(e.target.checked)} />
          This is a playoff match (decides a tie on wins)
        </label>
      )}
      <Button size="lg" className="mt-3 w-full" disabled={picked.length !== 2} loading={busy} onClick={() => onCreate({ homeSetId: picked[0]!, awaySetId: picked[1]!, isPlayoff })}>
        Kick off
      </Button>
    </Card>
  );
}

function PastMatch({ detail, match, home, away, editable, onScore, onStatus, onGoal, onDeleteGoal }: {
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
          <h3 className="display text-2xl font-bold uppercase">
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

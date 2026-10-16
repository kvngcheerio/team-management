import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { Badge, Button, Card, ConfirmDialog, cx, Empty, ErrorBox, Field, GuestBadge, Input, Loading, PageHeader, Select } from "../components/ui";
import { formatDateLong } from "../format";
import { useDayMutation, useMatchDay } from "../hooks";
import type { Player } from "../types";
import { SET_COLORS, SET_NAMES } from "../../shared/rules";

interface DraftPlayer {
  playerId: string;
  displayName: string;
  rating: number;
  kind: string;
  role: "starter" | "sub";
  isGoalkeeper: boolean;
}
interface DraftSet {
  idx: number;
  players: DraftPlayer[];
}
interface Generated {
  seed: number;
  setCount: number;
  teamSize: number;
  warnings: string[];
  explanation: string;
  sets: { idx: number; players: (DraftPlayer & { rating: number })[] }[];
}

export default function TeamSelectionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: detail, isLoading, error } = useMatchDay(id);
  const players = useQuery({ queryKey: ["players"], queryFn: () => api.get<{ players: Player[] }>("/players") });
  const [mode, setMode] = useState<"balanced" | "random">("balanced");
  const [setCount, setSetCount] = useState(0);
  const [teamSize, setTeamSize] = useState(0);
  const [draft, setDraft] = useState<DraftSet[] | null>(null);
  const [info, setInfo] = useState<{ warnings: string[]; explanation: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const byId = useMemo(() => new Map((players.data?.players ?? []).map((p) => [p.id, p])), [players.data]);

  useEffect(() => {
    if (!detail || setCount) return;
    setSetCount(detail.day.setCount);
    setTeamSize(detail.day.teamSize);
  }, [detail, setCount]);

  // Start from published teams if there are any.
  useEffect(() => {
    if (!detail || draft || !players.data || detail.sets.length === 0) return;
    setDraft(
      detail.sets.map((s) => ({
        idx: s.idx,
        players: s.players.map((p) => ({ playerId: p.playerId, displayName: p.displayName, kind: p.kind, role: p.role, isGoalkeeper: p.isGoalkeeper, rating: byId.get(p.playerId)?.skillRating ?? 5 })),
      })),
    );
  }, [detail, players.data, draft, byId]);

  const generate = useMutation({
    mutationFn: (seed?: number) => api.post<Generated>(`/matchdays/${id}/teams/generate`, { mode, setCount, teamSize, seed }),
    onSuccess: (g) => {
      setDraft(g.sets.map((s) => ({ idx: s.idx, players: s.players.map((p) => ({ ...p, kind: byId.get(p.playerId)?.kind ?? "member" })) })));
      setInfo({ warnings: g.warnings, explanation: g.explanation });
      setSelected(null);
    },
  });
  const publish = useDayMutation(
    id!,
    (replace: boolean) =>
      api.post(`/matchdays/${id}/teams/publish`, {
        expectedVersion: detail!.day.version,
        replace,
        teamSize,
        sets: draft!.map((s) => ({ idx: s.idx, players: s.players.map((p) => ({ playerId: p.playerId, role: p.role, isGoalkeeper: p.isGoalkeeper })) })),
      }),
    "Teams published",
  );

  if (isLoading || players.isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = detail!;
  const editable = ["checkin_open", "locked"].includes(d.day.status);
  const confirmed = d.registrations.filter((r) => r.status === "confirmed");
  const assigned = new Set(draft?.flatMap((s) => s.players.map((p) => p.playerId)) ?? []);
  const unassigned = confirmed.filter((r) => !assigned.has(r.playerId));

  const tapPlayer = (playerId: string) => {
    if (!draft) return;
    if (!selected) return setSelected(playerId);
    if (selected === playerId) return setSelected(null);
    // Swap two players (possibly across sets), or move an unassigned player in.
    const loc = (pid: string) => {
      for (const s of draft) {
        const i = s.players.findIndex((p) => p.playerId === pid);
        if (i >= 0) return { s, i };
      }
      return null;
    };
    const a = loc(selected);
    const b = loc(playerId);
    const next = draft.map((s) => ({ ...s, players: [...s.players] }));
    const find = (x: { s: DraftSet; i: number }) => next.find((s) => s.idx === x.s.idx)!;
    if (a && b) {
      const sa = find(a);
      const sb = find(b);
      const pa = sa.players[a.i]!;
      const pb = sb.players[b.i]!;
      sa.players[a.i] = { ...pb, role: pa.role };
      sb.players[b.i] = { ...pa, role: pb.role };
    }
    setDraft(next);
    setSelected(null);
  };
  const moveTo = (idx: number) => {
    if (!draft || !selected) return;
    const next = draft.map((s) => ({ ...s, players: s.players.filter((p) => p.playerId !== selected) }));
    const existing = draft.flatMap((s) => s.players).find((p) => p.playerId === selected);
    const reg = confirmed.find((r) => r.playerId === selected);
    const player: DraftPlayer = existing ?? { playerId: selected, displayName: reg?.displayName ?? "?", kind: reg?.kind ?? "member", rating: byId.get(selected)?.skillRating ?? 5, role: "starter", isGoalkeeper: false };
    const target = next.find((s) => s.idx === idx)!;
    target.players.push({ ...player, role: target.players.filter((p) => p.role === "starter").length >= teamSize ? "sub" : "starter" });
    setDraft(next);
    setSelected(null);
  };
  const removeSelected = () => {
    if (!draft || !selected) return;
    setDraft(draft.map((s) => ({ ...s, players: s.players.filter((p) => p.playerId !== selected) })));
    setSelected(null);
  };
  const toggle = (playerId: string, key: "role" | "isGoalkeeper") =>
    setDraft(
      draft!.map((s) => ({
        ...s,
        players: s.players.map((p) => (p.playerId !== playerId ? p : key === "role" ? { ...p, role: p.role === "starter" ? "sub" : "starter" } : { ...p, isGoalkeeper: !p.isGoalkeeper })),
      })),
    );
  const canPublish = editable && draft && draft.length >= 2 && draft.every((s) => s.players.length > 0);

  return (
    <div className="space-y-5 pb-24">
      <PageHeader title="Pick teams" kicker={formatDateLong(d.day.date)} action={<Link to={`/matchdays/${id}`} className="text-sm font-semibold text-pitch-700">← Back</Link>} />
      {!editable && <ErrorBox error={new Error(d.day.status === "draft" ? "Open check-in first." : "Rosters are locked: play has started.")} />}

      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Method">
            <Select value={mode} onChange={(e) => setMode(e.target.value as "balanced")}>
              <option value="balanced">Balanced</option>
              <option value="random">Random</option>
            </Select>
          </Field>
          <Field label="Sets">
            <Input type="number" inputMode="numeric" min={2} max={12} value={setCount || ""} onChange={(e) => setSetCount(Number(e.target.value))} />
          </Field>
          <Field label="Per set">
            <Input type="number" inputMode="numeric" min={1} max={30} value={teamSize || ""} onChange={(e) => setTeamSize(Number(e.target.value))} />
          </Field>
          <div className="flex items-end">
            <Button className="w-full" disabled={!editable} loading={generate.isPending} onClick={() => generate.mutate(undefined)}>
              {draft ? "Reshuffle" : "Generate"}
            </Button>
          </div>
        </div>
        <p className="mt-3 text-sm text-muted">
          Pool: <b className="text-ink">{confirmed.length}</b> confirmed players (approved guests included; pending guests and the waiting list are excluded).
          {mode === "balanced" && " Balanced uses private skill ratings and goalkeeper preferences."}
        </p>
        <ErrorBox error={generate.error} className="mt-3" />
        {info && (
          <div className="mt-3 space-y-2 text-sm">
            {info.warnings.map((w) => (
              <div key={w} className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">⚠ {w}</div>
            ))}
            <p className="text-muted">{info.explanation}</p>
          </div>
        )}
      </Card>

      {!draft ? (
        <Empty title="No teams yet">Generate teams from the confirmed players, then adjust by tapping players to swap them.</Empty>
      ) : (
        <>
          <p className="text-sm text-muted">
            {selected ? "Tap another player to swap, or tap “Move here” on a set." : "Tap a player to select them for a swap or move."}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {draft.map((s) => {
              const total = s.players.reduce((n, p) => n + p.rating, 0);
              return (
                <Card key={s.idx} className="overflow-hidden">
                  <div className="flex items-center justify-between border-b border-line px-4 py-2.5" style={{ borderTop: `5px solid ${SET_COLORS[s.idx - 1]}` }}>
                    <h3 className="display text-xl font-bold uppercase">{SET_NAMES[s.idx - 1]}</h3>
                    <div className="flex items-center gap-2">
                      <span className="num text-xs text-muted" title="Total private rating">
                        {s.players.length} · Σ{total}
                      </span>
                      {selected && !s.players.some((p) => p.playerId === selected) && (
                        <Button size="sm" variant="secondary" onClick={() => moveTo(s.idx)}>Move here</Button>
                      )}
                    </div>
                  </div>
                  <ul className="divide-y divide-line">
                    {s.players.map((p) => (
                      <li key={p.playerId} className={cx("flex min-h-12 items-center gap-2 px-3", selected === p.playerId && "bg-pitch-100")}>
                        <button className="min-h-12 flex-1 truncate text-left font-medium" onClick={() => tapPlayer(p.playerId)} aria-pressed={selected === p.playerId}>
                          {p.displayName}
                        </button>
                        {p.kind === "guest" && <GuestBadge />}
                        <span className="num w-6 text-center text-xs text-muted">{p.rating}</span>
                        <button onClick={() => toggle(p.playerId, "isGoalkeeper")} className={cx("rounded-md px-2 py-1 text-xs font-bold", p.isGoalkeeper ? "bg-sky-100 text-sky-900" : "text-stone-400")} aria-label="Toggle goalkeeper">
                          GK
                        </button>
                        <button onClick={() => toggle(p.playerId, "role")} className={cx("rounded-md px-2 py-1 text-xs font-bold", p.role === "sub" ? "bg-stone-200 text-stone-800" : "text-stone-400")} aria-label="Toggle substitute">
                          SUB
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              );
            })}
          </div>
          {unassigned.length > 0 && (
            <Card className="p-4">
              <h3 className="font-semibold">Not in a set ({unassigned.length})</h3>
              <p className="text-xs text-muted">Confirmed players not placed yet. Select one, then “Move here”.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {unassigned.map((r) => (
                  <button key={r.playerId} onClick={() => setSelected(selected === r.playerId ? null : r.playerId)} className={cx("min-h-10 rounded-full px-3 text-sm font-medium ring-1 ring-line", selected === r.playerId ? "bg-pitch-100" : "bg-white")}>
                    {r.displayName}
                  </button>
                ))}
              </div>
            </Card>
          )}
          {selected && assigned.has(selected) && (
            <Button variant="ghost" size="sm" onClick={removeSelected}>
              Take selected player out of their set
            </Button>
          )}
        </>
      )}

      {draft && (
        <div className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white/95 p-3 backdrop-blur sm:bottom-0">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <span className="flex-1 text-sm text-muted">{d.sets.length > 0 ? <Badge tone="green">Published</Badge> : "Not published yet"}</span>
            <Button size="lg" disabled={!canPublish} loading={publish.isPending} onClick={() => (d.sets.length > 0 ? setConfirmReplace(true) : publish.mutate(false, { onSuccess: () => navigate(`/matchdays/${id}`) }))}>
              {d.sets.length > 0 ? "Republish teams" : "Publish teams"}
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmReplace}
        title="Replace published teams?"
        confirmLabel="Republish"
        loading={publish.isPending}
        onClose={() => setConfirmReplace(false)}
        onConfirm={() => publish.mutate(true, { onSettled: () => setConfirmReplace(false), onSuccess: () => navigate(`/matchdays/${id}`) })}
      >
        Players will see the new teams immediately. This is recorded in the audit log.
      </ConfirmDialog>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { Badge, Button, Card, cx, Empty, ErrorBox, Field, Input, Loading, PageHeader, Select, SetChip, useToast } from "../components/ui";
import { useMatchDay } from "../hooks";
import type { MatchDayDetail, Player } from "../types";

type AddResult = MatchDayDetail & { added: { playerId: string; displayName: string; setId: string; setName: string } };

export default function AddGuestPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: d, isLoading, error } = useMatchDay(id);
  const players = useQuery({ queryKey: ["players"], queryFn: () => api.get<{ players: Player[] }>("/players") });
  const [mode, setMode] = useState<"new" | "previous">("new");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [previous, setPrevious] = useState("");
  const [team, setTeam] = useState("");
  const [feePaid, setFeePaid] = useState(true);
  const [last, setLast] = useState<AddResult["added"] | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.post<AddResult>(`/matchdays/${id}/pitch-guests`, {
        ...(mode === "new" ? { name, phone: phone || undefined } : { existingPlayerId: previous }),
        setId: team || undefined,
        feePaid,
      }),
    onSuccess: (r) => {
      qc.setQueryData(["matchday", id], r);
      qc.invalidateQueries({ queryKey: ["players"] });
      setLast(r.added);
      setName("");
      setPhone("");
      setPrevious("");
      setTeam("");
      toast(`${r.added.displayName} added to ${r.added.setName}`);
    },
    onError: (e: Error) => toast(e.message, "error"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const day = d!;
  const size = day.day.teamSize;
  const slots = day.guestSlots ?? 0;
  const onTeam = new Set(day.sets.flatMap((s) => s.players.map((p) => p.playerId)));
  const prevGuests = (players.data?.players ?? []).filter((p) => p.kind === "guest" && !onTeam.has(p.id));
  const canAdd = ["checkin_open", "locked", "in_progress"].includes(day.day.status) && day.sets.length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <div className="mx-auto max-w-xl space-y-5 pb-8">
      <PageHeader title="Add guest" kicker="On the pitch" action={<Link to={`/matchdays/${id}`} className="text-sm font-semibold text-pitch-700">← Day</Link>} />

      <Card className={cx("p-5 text-center", slots === 0 ? "bg-red-50" : "bg-pitch-50")}>
        <div className="text-sm text-muted">Guest limit</div>
        <div className={cx("num stat text-6xl leading-none", slots === 0 ? "text-red-700" : "text-pitch-800")}>{slots}</div>
        <div className="mt-1 text-sm font-medium">{slots === 0 ? "No spots left — every team is full" : `spot${slots === 1 ? "" : "s"} left · teams are ${size}-a-side`}</div>
        <div className="mt-1 text-xs text-muted">
          {day.counts.confirmed}/{day.day.capacity} players today
        </div>
      </Card>

      {day.sets.length === 0 ? (
        <Empty title="Teams not published">Publish teams first, then add guests on the pitch.</Empty>
      ) : (
        <Card className="p-4">
          <ul className="space-y-2.5">
            {day.sets.map((s) => {
              const n = s.players.length;
              return (
                <li key={s.id}>
                  <div className="flex items-center justify-between text-sm">
                    <SetChip name={s.name} color={s.color} />
                    <span className={cx("num font-semibold", n >= size ? "text-muted" : "text-pitch-800")}>
                      {n}/{size} {n >= size ? "· full" : `· ${size - n} open`}
                    </span>
                  </div>
                  <div className="mt-1 flex gap-1" aria-hidden>
                    {Array.from({ length: Math.max(size, n) }, (_, i) => (
                      <span key={i} className={cx("h-2.5 flex-1 rounded-full", i < n ? "" : "bg-stone-200")} style={i < n ? { background: s.color === "#f8fafc" ? "#cbd5e1" : s.color } : undefined} />
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {last && (
        <div role="status" className="rounded-2xl bg-pitch-50 px-4 py-3 text-sm font-medium text-pitch-800 ring-1 ring-pitch-200">
          ✓ {last.displayName} is playing for {last.setName}
        </div>
      )}

      {canAdd && slots > 0 && (
        <Card className="p-4">
          <div className="mb-4 grid grid-cols-2 overflow-hidden rounded-xl ring-1 ring-line">
            {(["new", "previous"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} className={cx("min-h-12 text-sm font-semibold", mode === m ? "bg-pitch-700 text-white" : "bg-white text-muted")}>
                {m === "new" ? "New guest" : `Previous guest (${prevGuests.length})`}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="space-y-4">
            {mode === "new" ? (
              <>
                <Field label="Guest's name"><Input autoFocus required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ade (Chidi's friend)" /></Field>
                <Field label="Phone (optional)" hint="Private — admins only."><Input type="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
              </>
            ) : (
              <Field label="Previous guest">
                <Select required value={previous} onChange={(e) => setPrevious(e.target.value)}>
                  <option value="">Choose…</option>
                  {prevGuests.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Team" hint="Automatic picks the team with the fewest players (then the weaker one).">
              <Select value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">Automatic</option>
                {day.sets.filter((s) => s.players.length < size).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.players.length}/{size})</option>)}
              </Select>
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="size-5 accent-pitch-700" checked={feePaid} onChange={(e) => setFeePaid(e.target.checked)} />
              Guest fee paid in cash now (returning guests with 5+ paid days this season play free)
            </label>
            <Button type="submit" size="lg" className="w-full" loading={add.isPending}>Add to a team</Button>
            <p className="text-xs text-muted">
              <Badge tone="amber">Guest</Badge> Guests are marked present, can score and assist, but don't earn league points.
            </p>
          </form>
        </Card>
      )}
      {!canAdd && day.sets.length > 0 && <p className="text-sm text-muted">Guests can't be added to a match day that's {day.day.status}.</p>}
    </div>
  );
}

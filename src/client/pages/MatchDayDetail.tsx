import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { CheckInPanel, DayCards, DayHeaderMeta, MatchesList, SetTable, TeamSheetCountdown, TeamsGrid, WinnerBanner } from "../components/matchday";
import { MvpVote } from "../components/MvpVote";
import { Badge, Button, Card, ConfirmDialog, cx, Empty, ErrorBox, Field, GuestBadge, Input, Loading, SectionTitle, Segmented, Select, StatusBadge, useToast } from "../components/ui";
import { formatDateLong, REG_LABEL } from "../format";
import { useDayMutation, useIsAdmin, useMatchDay } from "../hooks";
import type { MatchDayDetail, Player, Registration } from "../types";

type Tab = "players" | "teams" | "results";

export default function MatchDayDetailPage() {
  const { id } = useParams();
  const { data, isLoading, error } = useMatchDay(id);
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<Tab | null>(null);
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data!;
  const defaultTab: Tab = d.day.status === "in_progress" || d.day.status === "finalized" ? "results" : d.sets.length ? "teams" : "players";
  const current = tab ?? defaultTab;

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={d.day.status} />
          <span className="text-sm text-muted">{d.day.seasonName}</span>
          {d.day.autoCreated && <Badge>Scheduled</Badge>}
        </div>
        <h1 className="mt-2 text-[40px] font-light leading-[0.95] tracking-[-0.045em] sm:text-[52px]">{formatDateLong(d.day.date)}</h1>
        <div className="mt-1">
          <DayHeaderMeta detail={d} />
        </div>
        {d.day.notes && <p className="mt-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-line">📝 {d.day.notes}</p>}
      </header>

      {isAdmin && <AdminControls detail={d} />}

      {["checkin_open", "locked"].includes(d.day.status) && (
        <Card className="p-4">
          <CheckInPanel detail={d} />
        </Card>
      )}
      {d.day.status === "finalized" && d.me?.points != null && (
        <div className={cx("rounded-xl px-4 py-3 text-sm font-semibold", d.me.points > 0 ? "bg-gold-soft text-[#5c4304]" : "bg-stone-100")}>
          {d.me.points > 0 ? `You earned ${d.me.points} league points on this day.` : "You earned no league points on this day."}
        </div>
      )}
      {d.day.status === "cancelled" && (
        <div className="relative overflow-hidden rounded-[22px] border border-red-100 bg-red-50 px-5 py-5 text-ember">
          <span className="watermark !text-ember/10" aria-hidden>Off</span>
          <div className="relative text-sm">Match day cancelled</div>
          <div className="relative mt-1 text-2xl font-light tracking-tight">{d.day.cancelReason ?? "No reason given."}</div>
          <div className="relative mt-1 text-sm text-ember/80">Cancelled days award no points.</div>
        </div>
      )}

      <Segmented
        label="Match day sections"
        value={current}
        onChange={setTab}
        options={[
          { value: "players", label: `Players · ${d.counts.confirmed}` },
          { value: "teams", label: "Teams" },
          { value: "results", label: "Results" },
        ]}
      />

      {current === "players" && <PlayersTab detail={d} isAdmin={isAdmin} />}
      {d.mvp && <MvpVote poll={d.mvp} />}

      {current === "teams" &&
        (!d.day.teamsVisible ? (
          <TeamSheetCountdown detail={d} />
        ) : d.sets.length === 0 ? (
          <Empty title="Teams not picked yet" action={isAdmin && ["checkin_open", "locked"].includes(d.day.status) ? <Link to={`/matchdays/${d.day.id}/teams`}><Button>Pick teams</Button></Link> : undefined}>
            Teams are published once check-in closes.
          </Empty>
        ) : (
          <TeamsGrid detail={d} showAttendance={isAdmin} />
        ))}
      {current === "results" && (
        <div className="space-y-4">
          {isAdmin && d.sets.length > 0 && ["checkin_open", "locked", "in_progress", "finalized"].includes(d.day.status) && (
            <Link to={`/matchdays/${d.day.id}/live`} className="flex items-center justify-between gap-3 rounded-[22px] bg-pitch-700 px-5 py-4 text-white transition hover:bg-pitch-800">
              <span>
                <span className="block text-lg font-medium">{d.day.status === "finalized" ? "Correct results" : "Record results"}</span>
                <span className="text-sm text-white/80">{d.day.status === "in_progress" ? `${d.matches.length} match${d.matches.length === 1 ? "" : "es"} recorded` : d.day.status === "finalized" ? "Changes are audited" : "Start play, then enter each match's score"}</span>
              </span>
              <span aria-hidden className="text-2xl">→</span>
            </Link>
          )}
          <WinnerBanner detail={d} />
          {d.sets.length > 0 && <SetTable detail={d} />}
          <MatchesList detail={d} />
          <DayCards detail={d} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AdminControls({ detail }: { detail: MatchDayDetail }) {
  const { day } = detail;
  const toast = useToast();
  const [confirm, setConfirm] = useState<null | "cancel" | "finalize" | "start">(null);
  const [editing, setEditing] = useState(false);
  const transition = useDayMutation(day.id, (v: { to: string; reason?: string }) => api.post(`/matchdays/${day.id}/transition`, v), "Status updated");
  const start = useDayMutation(day.id, () => api.post(`/matchdays/${day.id}/start`), "Play started — rosters are locked");
  const finalize = useDayMutation(day.id, () => api.post(`/matchdays/${day.id}/finalize`), (d) => (d.alreadyFinalized ? "Already finalized" : "Match day finalized — points awarded"));

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(day.guestLink!);
      toast("Guest link copied");
    } catch {
      toast(day.guestLink!, "success");
    }
  };

  return (
    <Card className="space-y-3 bg-chalk p-5">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted">Admin controls</div>
        {["draft", "checkin_open", "locked", "in_progress"].includes(day.status) && (
          <button className="text-sm font-semibold text-pitch-700 hover:underline" onClick={() => setEditing((e) => !e)}>
            {editing ? "Close" : "Edit details"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {day.status === "draft" && <Button onClick={() => transition.mutate({ to: "checkin_open" })} loading={transition.isPending}>Open check-in</Button>}
        {day.status === "checkin_open" && <Button variant="secondary" onClick={() => transition.mutate({ to: "locked" })} loading={transition.isPending}>Close check-in</Button>}
        {day.status === "locked" && <Button variant="secondary" onClick={() => transition.mutate({ to: "checkin_open" })}>Reopen check-in</Button>}
        {["checkin_open", "locked"].includes(day.status) && (
          <Link to={`/matchdays/${day.id}/teams`}>
            <Button variant={detail.sets.length ? "secondary" : "primary"}>{detail.sets.length ? "Edit teams" : "Pick teams"}</Button>
          </Link>
        )}
        {["checkin_open", "locked"].includes(day.status) && detail.sets.length > 0 && <Button onClick={() => setConfirm("start")}>Start play</Button>}
        {(day.status === "in_progress" || day.status === "finalized" || detail.sets.length > 0) && day.status !== "cancelled" && (
          <Link to={`/matchdays/${day.id}/live`}>
            <Button variant={day.status === "finalized" ? "secondary" : "primary"}>{day.status === "finalized" ? "Correct results" : "Record results"}</Button>
          </Link>
        )}
        {["checkin_open", "locked", "in_progress"].includes(day.status) && detail.sets.length > 0 && (
          <Link to={`/matchdays/${day.id}/add-guest`}>
            <Button variant="secondary">+ Guest on pitch{detail.guestSlots != null && ` (${detail.guestSlots} left)`}</Button>
          </Link>
        )}
        {day.status === "in_progress" && (
          <Button variant="gold" onClick={() => setConfirm("finalize")} disabled={detail.issues.length > 0}>
            Finalize day
          </Button>
        )}
        {day.guestLink && ["draft", "checkin_open"].includes(day.status) && <Button variant="ghost" onClick={copyLink}>Copy guest link</Button>}
        {day.status !== "cancelled" && (
          <Button variant="danger" onClick={() => setConfirm("cancel")}>
            Cancel day
          </Button>
        )}
      </div>
      {day.status === "in_progress" && detail.issues.length > 0 && (
        <div className="rounded-xl bg-white p-3 text-sm ring-1 ring-amber-200">
          <div className="font-semibold text-amber-900">Before finalizing:</div>
          <ul className="mt-1 list-disc pl-5 text-amber-900">
            {detail.issues.map((i) => (
              <li key={i.code + i.message}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
      {day.status === "finalized" && detail.issues.length > 0 && (
        <div className="rounded-xl bg-white p-3 text-sm text-amber-900 ring-1 ring-amber-200">Corrections left these issues: {detail.issues.map((i) => i.message).join(" ")}</div>
      )}
      {editing && <EditDetails detail={detail} onDone={() => setEditing(false)} />}

      <ConfirmDialog
        open={confirm === "start"}
        title="Start play?"
        confirmLabel="Start play"
        loading={start.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => start.mutate(undefined, { onSettled: () => setConfirm(null) })}
      >
        Rosters lock when play starts: no team switches afterwards, and guests in the rosters won't be eligible for points today.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "finalize"}
        title="Finalize match day?"
        confirmLabel="Finalize"
        tone="gold"
        loading={finalize.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => finalize.mutate(undefined, { onSettled: () => setConfirm(null) })}
      >
        This computes the daily winner and awards 3 league points to each eligible player in the winning set. Later changes need an audited correction.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "cancel"}
        title="Cancel this match day?"
        reasonPlaceholder="e.g. Pitch is waterlogged"
        confirmLabel="Cancel day"
        tone="danger"
        requireReason
        loading={transition.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => transition.mutate({ to: "cancelled", reason: reason || undefined }, { onSettled: () => setConfirm(null) })}
      >
        Players see your reason on the match day and the home screen, and it's posted as a pinned announcement. Cancelled days award no points.
        {day.status === "finalized" && " Points already awarded for this day will be removed."}
        {detail.registrations.some((r) => r.feeStatus === "paid") && " Some guests already paid this day's fee — refund them or agree a credit; it isn't automatic."}
      </ConfirmDialog>
    </Card>
  );
}

function EditDetails({ detail, onDone }: { detail: MatchDayDetail; onDone: () => void }) {
  const { day } = detail;
  const started = day.status === "in_progress";
  const [f, setF] = useState({
    date: day.date,
    kickoffTime: day.kickoffTime,
    venue: day.venue,
    capacity: String(day.capacity),
    checkinDeadlineDate: day.checkinDeadlineLocal.date,
    checkinDeadlineTime: day.checkinDeadlineLocal.time,
    teamSize: String(day.teamSize),
    setCount: String(day.setCount),
    tiePolicy: day.tiePolicy,
    notes: day.notes,
    teamSheetTime: day.teamSheetLocal?.time ?? "07:50",
  });
  const save = useDayMutation(
    day.id,
    () =>
      api.patch(
        `/matchdays/${day.id}`,
        started
          ? { tiePolicy: f.tiePolicy, notes: f.notes, teamSheetTime: f.teamSheetTime }
          : { ...f, capacity: Number(f.capacity), teamSize: Number(f.teamSize), setCount: Number(f.setCount) },
      ),
    "Saved",
  );
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className="grid gap-3 rounded-xl bg-white p-3 ring-1 ring-line sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(undefined, { onSuccess: onDone });
      }}
    >
      {!started && (
        <>
          <Field label="Date"><Input type="date" value={f.date} onChange={set("date")} /></Field>
          <Field label="Kick-off"><Input type="time" value={f.kickoffTime} onChange={set("kickoffTime")} /></Field>
          <Field label="Venue"><Input value={f.venue} onChange={set("venue")} /></Field>
          <Field label="Capacity"><Input type="number" min={2} value={f.capacity} onChange={set("capacity")} /></Field>
          <Field label="Check-in closes (date)"><Input type="date" value={f.checkinDeadlineDate} onChange={set("checkinDeadlineDate")} /></Field>
          <Field label="Check-in closes (time)"><Input type="time" value={f.checkinDeadlineTime} onChange={set("checkinDeadlineTime")} /></Field>
          <Field label="Sets"><Input type="number" min={2} max={12} value={f.setCount} onChange={set("setCount")} /></Field>
          <Field label="Players per set"><Input type="number" min={1} value={f.teamSize} onChange={set("teamSize")} /></Field>
        </>
      )}
      <Field label="Tie policy" hint="Can be changed until the day is finalized.">
        <Select value={f.tiePolicy} onChange={set("tiePolicy")}>
          <option value="shared">Shared first place</option>
          <option value="playoff">Playoff match</option>
        </Select>
      </Field>
      <Field label="Notes"><Input value={f.notes} onChange={set("notes")} /></Field>
      <Field label="Team sheet visible from" hint="Local time on match day."><Input type="time" value={f.teamSheetTime} onChange={set("teamSheetTime")} /></Field>
      <div className="sm:col-span-2">
        <Button type="submit" loading={save.isPending}>Save changes</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function PlayersTab({ detail, isAdmin }: { detail: MatchDayDetail; isAdmin: boolean }) {
  const regs = detail.registrations;
  const groups: { title: string; status: Registration["status"]; empty?: string }[] = [
    { title: "Playing", status: "confirmed", empty: "Nobody has checked in yet." },
    { title: "Waiting list", status: "waitlist" },
    { title: "Not available", status: "unavailable" },
    ...(isAdmin ? [{ title: "Guest requests", status: "pending" as const }, { title: "Withdrawn / declined", status: "withdrawn" as const }] : []),
  ];
  const attendanceMode = isAdmin && ["locked", "in_progress", "finalized"].includes(detail.day.status);
  return (
    <div className="space-y-6">
      {isAdmin && ["draft", "checkin_open", "locked"].includes(detail.day.status) && <AddPlayer detail={detail} />}
      {attendanceMode && <AttendanceHelp detail={detail} />}
      {isAdmin && detail.noResponse.length > 0 && (
        <section>
          <SectionTitle>
            No response yet <span className="text-muted">({detail.noResponse.length})</span>
          </SectionTitle>
          <p className="text-sm text-muted">{detail.noResponse.map((p) => p.displayName).join(", ")}</p>
        </section>
      )}
      {groups.map((g) => {
        const rows = regs.filter((r) => (g.status === "withdrawn" ? r.status === "withdrawn" || r.status === "rejected" : r.status === g.status));
        if (rows.length === 0 && !g.empty) return null;
        return (
          <section key={g.title}>
            <SectionTitle>
              {g.title} <span className="text-muted">({rows.length})</span>
            </SectionTitle>
            {rows.length === 0 ? (
              <p className="text-sm text-muted">{g.empty}</p>
            ) : (
              <Card>
                <ul className="divide-y divide-line">
                  {rows.map((r) => (
                    <RegistrationRow key={r.id} reg={r} detail={detail} isAdmin={isAdmin} attendanceMode={attendanceMode && r.status === "confirmed"} />
                  ))}
                </ul>
              </Card>
            )}
          </section>
        );
      })}
    </div>
  );
}

function RegistrationRow({ reg, detail, isAdmin, attendanceMode }: { reg: Registration; detail: MatchDayDetail; isAdmin: boolean; attendanceMode: boolean }) {
  const dayId = detail.day.id;
  const finalized = detail.day.status === "finalized";
  const [pendingAttendance, setPendingAttendance] = useState<boolean | null | undefined>(undefined);
  const act = useDayMutation(dayId, (action: string) => api.post(`/registrations/${reg.id}/${action}`, {}), "Updated");
  const attend = useDayMutation(dayId, (v: { attended: boolean | null; reason?: string }) =>
    api.post(`/matchdays/${dayId}/attendance`, { entries: [{ playerId: reg.playerId, attended: v.attended }], reason: v.reason }),
  );
  const editable = ["draft", "checkin_open", "locked"].includes(detail.day.status);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const fee = useDayMutation(dayId, async (v: { action: "mark-paid" | "waive"; reason?: string }) => {
    await api.post(`/registrations/${reg.id}/fee/${v.action}`, { reason: v.reason });
    return api.get(`/matchdays/${dayId}`);
  }, "Guest fee updated");
  const setAttendance = (attended: boolean | null) => (finalized ? setPendingAttendance(attended) : attend.mutate({ attended }));
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {reg.waitlistPosition && <span className="num text-sm font-bold text-muted">#{reg.waitlistPosition}</span>}
          <Link to={`/players/${reg.playerId}`} className="font-medium hover:underline">
            {reg.displayName}
          </Link>
          {reg.kind === "guest" && <GuestBadge />}
          {reg.status !== "confirmed" && reg.status !== "waitlist" && <Badge>{REG_LABEL[reg.status]}</Badge>}
          {reg.feeStatus === "unpaid" && <Badge tone="red">Fee owed ₦{(reg.feeAmount ?? 0).toLocaleString()}</Badge>}
          {reg.feeStatus === "paid" && <Badge tone="green">Fee paid</Badge>}
          {reg.feeStatus === "free" && <Badge tone="green">Free (5+ paid days)</Badge>}
          {reg.feeStatus === "waived" && <Badge>Fee waived</Badge>}
        </div>
        {isAdmin && (reg.note || reg.contactPhone || reg.contactEmail) && (
          <div className="mt-0.5 text-xs text-muted">{[reg.note, reg.contactPhone, reg.contactEmail].filter(Boolean).join(" · ")}</div>
        )}
      </div>
      {isAdmin && reg.feeStatus === "unpaid" && ["draft", "checkin_open", "locked", "in_progress", "finalized"].includes(detail.day.status) && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" loading={fee.isPending} onClick={() => fee.mutate({ action: "mark-paid" })}>Paid cash</Button>
          <Button size="sm" variant="ghost" onClick={() => setWaiveOpen(true)}>Waive</Button>
        </div>
      )}
      {isAdmin && editable && (
        <div className="flex gap-1.5">
          {reg.status === "pending" && (
            <>
              <Button size="sm" onClick={() => act.mutate("approve")} loading={act.isPending} title="Confirm now; the fee stays owed">Let play (fee owed)</Button>
              <Button size="sm" variant="danger" onClick={() => act.mutate("reject")}>Decline</Button>
            </>
          )}
          {reg.status === "waitlist" && (
            <Button size="sm" variant="secondary" onClick={() => act.mutate("promote")} loading={act.isPending} disabled={detail.counts.confirmed >= detail.day.capacity}>
              Promote
            </Button>
          )}
          {(reg.status === "confirmed" || reg.status === "waitlist") && (
            <Button size="sm" variant="ghost" onClick={() => act.mutate("withdraw")}>Remove</Button>
          )}
          {(reg.status === "withdrawn" || reg.status === "rejected" || reg.status === "unavailable") && (
            <Button size="sm" variant="ghost" onClick={() => act.mutate("restore")}>Restore</Button>
          )}
        </div>
      )}
      {attendanceMode && (
        <div className="flex overflow-hidden rounded-lg ring-1 ring-line" role="group" aria-label={`Attendance for ${reg.displayName}`}>
          <button
            aria-pressed={reg.attended === true}
            onClick={() => setAttendance(true)}
            className={cx("min-h-10 px-3 text-sm font-semibold", reg.attended === true ? "bg-pitch-700 text-white" : "bg-white text-muted")}
          >
            Present
          </button>
          <button
            aria-pressed={reg.attended === false}
            onClick={() => setAttendance(false)}
            className={cx("min-h-10 border-l border-line px-3 text-sm font-semibold", reg.attended === false ? "bg-red-600 text-white" : "bg-white text-muted")}
          >
            Absent
          </button>
        </div>
      )}
      <ConfirmDialog open={waiveOpen} title="Waive guest fee?" requireReason confirmLabel="Waive" onClose={() => setWaiveOpen(false)}
        onConfirm={(reason) => fee.mutate({ action: "waive", reason }, { onSettled: () => setWaiveOpen(false) })}>
        {reg.displayName} won't owe the fee for this match day.
      </ConfirmDialog>
      <ConfirmDialog
        open={pendingAttendance !== undefined}
        title="Correct attendance"
        requireReason
        confirmLabel="Save correction"
        loading={attend.isPending}
        onClose={() => setPendingAttendance(undefined)}
        onConfirm={(reason) => attend.mutate({ attended: pendingAttendance ?? null, reason }, { onSettled: () => setPendingAttendance(undefined) })}
      >
        This day is finalized. Points will be recalculated and the change recorded in the audit log.
      </ConfirmDialog>
    </li>
  );
}

function AttendanceHelp({ detail }: { detail: MatchDayDetail }) {
  const rostered = detail.sets.flatMap((s) => s.players);
  const unmarked = rostered.filter((p) => p.attended === null);
  const markAll = useDayMutation(
    detail.day.id,
    () => api.post(`/matchdays/${detail.day.id}/attendance`, { entries: unmarked.map((p) => ({ playerId: p.playerId, attended: true })) }),
    "Marked present",
  );
  if (detail.day.status === "finalized") return <p className="text-sm text-muted">Attendance changes on a finalized day are audited corrections.</p>;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-line">
      <p className="flex-1 text-sm">
        <b>Actual attendance.</b> Only players marked present can earn points. {unmarked.length > 0 ? `${unmarked.length} rostered player(s) unmarked.` : "All rostered players marked."}
      </p>
      {unmarked.length > 0 && (
        <Button size="sm" onClick={() => markAll.mutate(undefined)} loading={markAll.isPending}>
          Mark rostered present
        </Button>
      )}
    </div>
  );
}

function AddPlayer({ detail }: { detail: MatchDayDetail }) {
  const players = useQuery({ queryKey: ["players"], queryFn: () => api.get<{ players: Player[] }>("/players") });
  const [playerId, setPlayerId] = useState("");
  const add = useDayMutation(detail.day.id, () => api.post(`/matchdays/${detail.day.id}/registrations`, { playerId }), (d) => {
    const r = d.registrations.find((x) => x.playerId === playerId);
    return r?.status === "waitlist" ? "Added to the waiting list (day is full)" : "Player added";
  });
  const taken = new Set(detail.registrations.filter((r) => ["confirmed", "waitlist"].includes(r.status)).map((r) => r.playerId));
  const options = (players.data?.players ?? []).filter((p) => p.active && !taken.has(p.id));
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (playerId) add.mutate(undefined, { onSuccess: () => setPlayerId("") });
      }}
    >
      <Select aria-label="Add a player" value={playerId} onChange={(e) => setPlayerId(e.target.value)} className="flex-1">
        <option value="">Add a member or guest…</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
            {p.kind === "guest" ? " (guest)" : ""}
          </option>
        ))}
      </Select>
      <Button type="submit" disabled={!playerId} loading={add.isPending}>
        Add
      </Button>
      {add.error && <ErrorBox error={add.error} />}
    </form>
  );
}

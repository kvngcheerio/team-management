import { Link } from "react-router";
import { api } from "../api";
import { formatInstant, REG_LABEL, relativeDeadline } from "../format";
import { useDayMutation } from "../hooks";
import type { Match, MatchDayDetail, TeamSet } from "../types";
import type { StandingRow } from "../../shared/rules";
import { Badge, Button, Card, cx, GuestBadge, SetChip } from "./ui";

export function CheckInPanel({ detail }: { detail: MatchDayDetail }) {
  const { day, me, counts } = detail;
  const checkIn = useDayMutation(day.id, () => api.post(`/matchdays/${day.id}/checkin`), (d) =>
    d.me?.registrationStatus === "waitlist" ? "Day is full — you're on the waiting list" : d.me?.registrationStatus === "pending" ? "Request sent for approval" : "You're in! See you on the pitch",
  );
  const withdraw = useDayMutation(day.id, () => api.post(`/matchdays/${day.id}/withdraw`), "You've withdrawn");
  const status = me?.registrationStatus;
  const active = status === "confirmed" || status === "waitlist" || status === "pending";
  const spots = Math.max(0, day.capacity - counts.confirmed);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="num font-semibold">
          {counts.confirmed}/{day.capacity} playing
        </span>
        {counts.waitlist > 0 && <Badge tone="amber">{counts.waitlist} waiting</Badge>}
        {day.status === "checkin_open" && <span className="text-muted">· Check-in {relativeDeadline(day.checkinDeadline)}</span>}
      </div>
      {!me ? (
        <p className="text-sm text-muted">Your login isn't linked to a player profile yet — ask an admin.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {status && (
            <Badge tone={status === "confirmed" ? "green" : status === "waitlist" || status === "pending" ? "amber" : "gray"} className="!text-sm !px-3 !py-1">
              {REG_LABEL[status]}
              {status === "waitlist" && ` #${detail.registrations.find((r) => r.playerId === me.playerId)?.waitlistPosition ?? ""}`}
            </Badge>
          )}
          {me.canCheckIn && !active && (
            <Button size="lg" className="flex-1 sm:flex-none" loading={checkIn.isPending} onClick={() => checkIn.mutate(undefined)}>
              {spots > 0 ? "Check in" : "Join waiting list"}
            </Button>
          )}
          {me.canCheckIn && active && (
            <Button variant="secondary" loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
              Withdraw
            </Button>
          )}
          {!me.canCheckIn && day.status === "checkin_open" && <span className="text-sm text-muted">The check-in deadline has passed.</span>}
        </div>
      )}
    </div>
  );
}

export function TeamCard({ set, highlightPlayerId, showAttendance }: { set: TeamSet; highlightPlayerId?: string; showAttendance?: boolean }) {
  const starters = set.players.filter((p) => p.role === "starter");
  const subs = set.players.filter((p) => p.role === "sub");
  return (
    <Card className={cx("overflow-hidden", set.isDailyWinner && "ring-2 ring-gold")}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3" style={{ borderTop: `5px solid ${set.color}` }}>
        <h3 className="display text-xl font-bold uppercase">{set.name}</h3>
        <div className="flex items-center gap-2">
          {set.record && set.record.played > 0 && (
            <span className="num text-xs font-semibold text-muted">
              {set.record.wins}W {set.record.draws}D {set.record.losses}L
            </span>
          )}
          {set.isDailyWinner && <Badge tone="gold">🏆 Winner</Badge>}
        </div>
      </div>
      <ul className="divide-y divide-line">
        {[...starters, ...subs].map((p) => (
          <li key={p.playerId} className={cx("flex min-h-11 items-center gap-2 px-4 py-2 text-[15px]", p.playerId === highlightPlayerId && "bg-pitch-50 font-semibold")}>
            <Link to={`/players/${p.playerId}`} className="truncate hover:underline">
              {p.displayName}
            </Link>
            {p.isGoalkeeper && <Badge tone="blue">GK</Badge>}
            {p.role === "sub" && <Badge>Sub</Badge>}
            {p.kind === "guest" && <GuestBadge />}
            <span className="ml-auto flex items-center gap-2">
              {showAttendance && p.attended === false && <Badge tone="red">Absent</Badge>}
              {p.points != null && p.points > 0 && <Badge tone="gold">+{p.points}</Badge>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TeamsGrid({ detail, showAttendance }: { detail: MatchDayDetail; showAttendance?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {detail.sets.map((s) => (
        <TeamCard key={s.id} set={s} highlightPlayerId={detail.me?.playerId} showAttendance={showAttendance} />
      ))}
    </div>
  );
}

export function SetTable({ detail }: { detail: MatchDayDetail }) {
  const gd = (s: TeamSet) => (s.record?.goalsFor ?? 0) - (s.record?.goalsAgainst ?? 0);
  const rows = [...detail.sets].sort((a, b) => (b.record?.wins ?? 0) - (a.record?.wins ?? 0) || gd(b) - gd(a));
  return (
    <Card className="overflow-x-auto">
      <table className="num w-full text-left text-sm">
        <caption className="sr-only">Set results for the day</caption>
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2.5 font-semibold">Set</th>
            {["P", "W", "D", "L", "GF", "GA"].map((h) => (
              <th key={h} className="px-2 py-2.5 text-center font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className={cx("border-b border-line last:border-0", s.isDailyWinner && "bg-gold-soft/60")}>
              <td className="px-4 py-3">
                <SetChip name={s.name} color={s.color} /> {s.isDailyWinner && <span aria-label="daily winner">🏆</span>}
              </td>
              <td className="px-2 text-center">{s.record?.played ?? 0}</td>
              <td className="px-2 text-center font-bold">{s.record?.wins ?? 0}</td>
              <td className="px-2 text-center">{s.record?.draws ?? 0}</td>
              <td className="px-2 text-center">{s.record?.losses ?? 0}</td>
              <td className="px-2 text-center">{s.record?.goalsFor ?? 0}</td>
              <td className="px-2 text-center">{s.record?.goalsAgainst ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function nameOf(detail: MatchDayDetail, playerId: string | null) {
  if (!playerId) return "";
  for (const s of detail.sets) {
    const p = s.players.find((x) => x.playerId === playerId);
    if (p) return p.displayName;
  }
  return "Unknown";
}

export function goalLabel(detail: MatchDayDetail, g: Match["goals"][number]) {
  if (g.kind === "unattributed") return "Goal (unattributed)";
  if (g.kind === "own_goal") return `${nameOf(detail, g.scorerPlayerId)} (own goal)`;
  return nameOf(detail, g.scorerPlayerId) + (g.assistPlayerId ? ` · assist ${nameOf(detail, g.assistPlayerId)}` : "");
}

export function MatchesList({ detail }: { detail: MatchDayDetail }) {
  const setById = new Map(detail.sets.map((s) => [s.id, s]));
  if (detail.matches.length === 0) return <p className="text-sm text-muted">No matches recorded yet.</p>;
  return (
    <ol className="space-y-2">
      {detail.matches.map((m) => {
        const home = setById.get(m.homeSetId)!;
        const away = setById.get(m.awaySetId)!;
        return (
          <li key={m.id}>
            <Card className={cx("px-4 py-3", m.status === "void" && "opacity-50")}>
              <div className="flex items-center gap-3">
                <span className="w-6 text-xs font-semibold text-muted">#{m.seq}</span>
                <SetChip name={home.name} color={home.color} className="flex-1 justify-end text-right" />
                <span className={cx("num display min-w-[4.5rem] rounded-lg px-2 py-1 text-center text-2xl font-bold", m.status === "in_progress" ? "bg-sky-100 text-sky-900" : "bg-stone-100")}>
                  {m.homeScore}–{m.awayScore}
                </span>
                <SetChip name={away.name} color={away.color} className="flex-1" />
              </div>
              <div className="mt-1 flex flex-wrap justify-center gap-1.5">
                {m.isPlayoff && <Badge tone="gold">Playoff</Badge>}
                {m.status === "in_progress" && <Badge tone="blue">Live</Badge>}
                {m.status === "void" && <Badge tone="red">Void</Badge>}
                {!m.reconciled && m.status !== "void" && <Badge tone="red">Goals don't match score</Badge>}
              </div>
              {m.goals.length > 0 && (
                <ul className="mt-2 grid grid-cols-2 gap-x-4 text-xs text-muted">
                  <li className="space-y-0.5 text-right">
                    {m.goals.filter((g) => g.setId === m.homeSetId).map((g) => (
                      <div key={g.id}>⚽ {goalLabel(detail, g)}</div>
                    ))}
                  </li>
                  <li className="space-y-0.5">
                    {m.goals.filter((g) => g.setId === m.awaySetId).map((g) => (
                      <div key={g.id}>⚽ {goalLabel(detail, g)}</div>
                    ))}
                  </li>
                </ul>
              )}
            </Card>
          </li>
        );
      })}
    </ol>
  );
}

export function WinnerBanner({ detail }: { detail: MatchDayDetail }) {
  const w = detail.winner;
  const finalized = detail.day.status === "finalized";
  if (w.status === "decided") {
    const names = w.winnerSetIds.map((id) => detail.sets.find((s) => s.id === id)?.name).join(" & ");
    return (
      <div className="rounded-2xl bg-gradient-to-r from-[#7a5a05] to-gold px-5 py-4 text-white shadow">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/80">{finalized ? "Daily winner" : "Leading (provisional)"}</div>
        <div className="display text-3xl font-bold uppercase">
          🏆 {names}
          {w.method === "shared" && " — shared"}
          {w.method === "playoff" && " — via playoff"}
        </div>
        <div className="text-sm text-white/90">
          {w.maxWins} match win{w.maxWins === 1 ? "" : "s"} · eligible players earn 3 league points{finalized ? "" : " when finalized"}
        </div>
      </div>
    );
  }
  if (w.status === "playoff_required") {
    return <div className="rounded-2xl bg-amber-50 px-5 py-4 text-amber-900 ring-1 ring-amber-200">Sets are level on wins — a playoff match is required.</div>;
  }
  if (finalized) return <div className="rounded-2xl bg-stone-100 px-5 py-4 text-sm">No set won a match, so there's no daily winner and no points were awarded.</div>;
  return null;
}

export function StandingsTable({ rows, compact, highlight }: { rows: (StandingRow & { kind?: string })[]; compact?: boolean; highlight?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="num w-full text-left text-[15px]">
        <caption className="sr-only">League table</caption>
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-line">
            <th className="w-12 px-3 py-2.5 font-semibold">Pos</th>
            <th className="px-2 py-2.5 font-semibold">Player</th>
            <th className="px-2 py-2.5 text-center font-semibold" title="League points">
              Pts
            </th>
            <th className="px-2 py-2.5 text-center font-semibold" title="Daily wins">
              DW
            </th>
            {!compact && (
              <th className="px-2 py-2.5 text-center font-semibold" title="Appearances">
                App
              </th>
            )}
            <th className="px-2 py-2.5 text-center font-semibold" title="Goals">
              G
            </th>
            <th className="px-2 py-2.5 pr-3 text-center font-semibold" title="Assists">
              A
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.playerId} className={cx("border-b border-line last:border-0", r.playerId === highlight && "bg-pitch-50 font-semibold", r.position === 1 && "bg-gold-soft/40")}>
              <td className="px-3 py-3 font-bold">
                {r.shared ? "=" : ""}
                {r.position}
              </td>
              <td className="max-w-[10rem] truncate px-2 py-3">
                <Link to={`/players/${r.playerId}`} className="hover:underline">
                  {r.displayName}
                </Link>
              </td>
              <td className="px-2 text-center text-base font-bold text-pitch-800">{r.points}</td>
              <td className="px-2 text-center">{r.dailyWins}</td>
              {!compact && <td className="px-2 text-center">{r.appearances}</td>}
              <td className="px-2 text-center">{r.goals}</td>
              <td className="px-2 pr-3 text-center">{r.assists}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DayHeaderMeta({ detail, onDark }: { detail: MatchDayDetail; onDark?: boolean }) {
  const { day } = detail;
  return (
    <div className={cx("text-sm", onDark ? "text-pitch-100 [&_b]:text-white [&_span]:text-white" : "text-muted")}>
      Kick-off <b className="text-ink">{day.kickoffTime}</b>
      {day.venue && (
        <>
          {" "}
          · <span className="text-ink">{day.venue}</span>
        </>
      )}{" "}
      · {day.setCount} sets of {day.teamSize}
      {day.status === "checkin_open" && <> · Check-in closes {formatInstant(day.checkinDeadline, day.timezone)}</>}
    </div>
  );
}

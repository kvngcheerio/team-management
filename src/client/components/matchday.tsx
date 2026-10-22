import { Link } from "react-router";
import { api } from "../api";
import { formatInstant, REG_LABEL, relativeDeadline } from "../format";
import { useDayMutation } from "../hooks";
import type { Match, MatchDayDetail, TeamSet } from "../types";
import type { StandingRow } from "../../shared/rules";
import { useQuery } from "@tanstack/react-query";
import { formatMoney, placementPoints } from "../../shared/rules";
import { useCheckout } from "./account";
import type { Player } from "../types";
import { Avatar, Badge, Button, Card, CardIcon, cx, GuestBadge, SetChip } from "./ui";

export function CheckInPanel({ detail }: { detail: MatchDayDetail }) {
  const { day, me, counts } = detail;
  const checkIn = useDayMutation(day.id, () => api.post(`/matchdays/${day.id}/checkin`), (d) =>
    d.me?.registrationStatus === "waitlist" ? "Day is full — you're on the waiting list" : d.me?.registrationStatus === "pending" ? "Almost there — pay the guest fee to confirm your place" : "You're in! See you on the pitch",
  );
  const payFee = useCheckout(`/matchdays/${day.id}/guest-fee/checkout`, "Guest fee paid");
  const unavailable = useDayMutation(day.id, () => api.post(`/matchdays/${day.id}/unavailable`), "Got it — marked as not available");
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
      ) : !me.approved ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Your account is waiting for admin approval. You can mark availability once approved.</p>
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
              {spots > 0 ? "✓ I'm available" : "Join waiting list"}
              {me.kind === "guest" && me.guestFee != null && (me.guestFee > 0 ? ` · ${formatMoney(me.guestFee, "NGN")}` : " · free")}
            </Button>
          )}
          {me.feeStatus === "unpaid" && (
            <Button size="lg" variant="gold" className="flex-1 sm:flex-none" loading={payFee.isPending} onClick={() => payFee.mutate({})}>
              Pay {formatMoney(me.feeAmount, "NGN")} {status === "pending" ? "to confirm" : "guest fee"}
            </Button>
          )}
          {me.feeStatus === "free" && <Badge tone="green">Free — you've paid 5 days this season</Badge>}
          {me.canCheckIn && status !== "unavailable" && (!active || me.canWithdraw) && (
            <Button size={active ? "md" : "lg"} variant="secondary" className={active ? "" : "flex-1 sm:flex-none"} loading={unavailable.isPending} onClick={() => unavailable.mutate(undefined)}>
              {active ? "I can't make it any more" : "✗ Can't make it"}
            </Button>
          )}
          {me.canCheckIn && !me.canWithdraw && <span className="text-sm text-muted">{active ? "The deadline has passed, so you can't drop out here — tell an admin." : "The check-in deadline has passed. You can still check in, but it's marked late."}</span>}
        </div>
      )}
    </div>
  );
}

export function TeamCard({ set, highlightPlayerId, showAttendance, avatars }: { set: TeamSet; highlightPlayerId?: string; showAttendance?: boolean; avatars?: Record<string, string | null> }) {
  const starters = set.players.filter((p) => p.role === "starter");
  const subs = set.players.filter((p) => p.role === "sub");
  return (
    <Card className={cx("overflow-hidden", set.isDailyWinner && "border-pitch-700")}>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="h-7 w-1.5 shrink-0 rounded-full" style={{ background: set.color === "#f8fafc" ? "#d6d6d0" : set.color }} aria-hidden />
        <h3 className="mr-auto text-xl font-medium tracking-[-0.02em]">{set.name}</h3>
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
            <Avatar name={p.displayName} url={avatars?.[p.playerId]} size={26} />
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
  const players = useQuery({ queryKey: ["players"], queryFn: () => api.get<{ players: Player[] }>("/players"), staleTime: 60_000 });
  const avatars = Object.fromEntries((players.data?.players ?? []).map((p) => [p.id, p.avatarUrl]));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {detail.sets.map((s) => (
        <TeamCard key={s.id} set={s} highlightPlayerId={detail.me?.playerId} showAttendance={showAttendance} avatars={avatars} />
      ))}
    </div>
  );
}

export function SetTable({ detail }: { detail: MatchDayDetail }) {
  const gd = (s: TeamSet) => (s.record?.goalsFor ?? 0) - (s.record?.goalsAgainst ?? 0);
  const pos = (s: TeamSet) => s.placement?.position ?? Infinity;
  const rows = [...detail.sets].sort((a, b) => pos(a) - pos(b) || (b.record?.wins ?? 0) - (a.record?.wins ?? 0) || gd(b) - gd(a));
  return (
    <Card className="overflow-x-auto">
      <table className="num w-full text-left text-sm">
        <caption className="sr-only">Set results for the day</caption>
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-3 font-normal">Set</th>
            {["P", "W", "D", "L", "GF", "GA", "Pts"].map((h) => (
              <th key={h} className="px-2 py-3 text-center font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className={cx("border-b border-line last:border-0", s.isDailyWinner && "bg-pitch-50")}>
              <td className="px-4 py-3">
                <SetChip name={s.name} color={s.color} /> {s.isDailyWinner && <span aria-label="daily winner">🏆</span>}
              </td>
              <td className="px-2 text-center">{s.record?.played ?? 0}</td>
              <td className="px-2 text-center text-lg font-medium text-pitch-800">{s.record?.wins ?? 0}</td>
              <td className="px-2 text-center">{s.record?.draws ?? 0}</td>
              <td className="px-2 text-center">{s.record?.losses ?? 0}</td>
              <td className="px-2 text-center">{s.record?.goalsFor ?? 0}</td>
              <td className="px-2 text-center">{s.record?.goalsAgainst ?? 0}</td>
              <td className="px-2 text-center font-medium text-pitch-800" title="League points for each eligible player in this set">
                {s.placement?.points ?? 0}
              </td>
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
                <span className={cx("num stat min-w-[5rem] rounded-full px-3 py-1.5 text-center text-3xl", m.status === "in_progress" ? "bg-pitch-50 text-pitch-800" : "bg-chalk")}>
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

/** "1st +3 · 2nd +2 · 3rd +1": league points each eligible player earns by set placement. */
function placementSummary(detail: MatchDayDetail) {
  const ord = ["1st", "2nd", "3rd"];
  const pts = placementPoints(detail.sets.length).filter((p) => p > 0);
  if (pts.length === 1) return `eligible players earn ${pts[0]} league points`;
  return `league points per eligible player: ${pts.map((p, i) => `${ord[i]} +${p}`).join(" · ")}`;
}

export function WinnerBanner({ detail }: { detail: MatchDayDetail }) {
  const w = detail.winner;
  const finalized = detail.day.status === "finalized";
  if (w.status === "decided") {
    const names = w.winnerSetIds.map((id) => detail.sets.find((s) => s.id === id)?.name).join(" & ");
    return (
      <div className="relative overflow-hidden rounded-[22px] border border-line bg-chalk px-5 py-5">
        <span className="watermark" aria-hidden>Winner</span>
        <div className="relative text-sm text-muted">{finalized ? "Daily winner" : "Leading (provisional)"}</div>
        <div className="relative mt-1 text-[34px] font-light leading-tight tracking-[-0.04em] text-pitch-800">
          🏆 {names}
          {w.method === "shared" && <span className="text-muted"> — shared</span>}
          {w.method === "playoff" && <span className="text-muted"> — via playoff</span>}
        </div>
        <div className="relative text-sm text-muted">
          {w.maxWins} match win{w.maxWins === 1 ? "" : "s"} · {placementSummary(detail)}{finalized ? "" : " when finalized"}
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
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th className="w-14 px-4 py-3 font-normal">Pos</th>
            <th className="px-2 py-3 font-normal">Player</th>
            <th className="px-2 py-3 text-center font-normal" title="League points">Pts</th>
            <th className="px-2 py-3 text-center font-normal" title="Daily wins">DW</th>
            {!compact && <th className="px-2 py-3 text-center font-normal" title="Appearances">App</th>}
            <th className="px-2 py-3 text-center font-normal" title="Goals">G</th>
            <th className="px-2 py-3 pr-4 text-center font-normal" title="Assists">A</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.playerId} className={cx("border-b border-line transition last:border-0 hover:bg-chalk", r.playerId === highlight && "bg-pitch-50")}>
              <td className="px-4 py-3.5 text-xl font-light tracking-tight text-muted">
                {r.shared ? "=" : ""}
                {r.position}
              </td>
              <td className="max-w-[10rem] truncate px-2 py-3">
                <Link to={`/players/${r.playerId}`} className="hover:underline">
                  {r.displayName}
                </Link>
              </td>
              <td className="px-2 text-center text-lg font-medium text-pitch-800">{r.points}</td>
              <td className="px-2 text-center">{r.dailyWins}</td>
              {!compact && <td className="px-2 text-center">{r.appearances}</td>}
              <td className="px-2 text-center">{r.goals}</td>
              <td className="px-2 pr-4 text-center">{r.assists}</td>
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

export function DayCards({ detail }: { detail: MatchDayDetail }) {
  const cards = detail.cards.filter((k) => !k.voided);
  if (cards.length === 0) return null;
  return (
    <Card className="p-4">
      <h3 className="mb-2 font-semibold">Cards</h3>
      <ul className="space-y-1.5 text-sm">
        {cards.map((k) => (
          <li key={k.id} className="flex items-center gap-2">
            <CardIcon color={k.color} />
            <Link to={`/players/${k.playerId}`} className="hover:underline">{k.displayName}</Link>
            {k.reason && <span className="text-muted">· {k.reason}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function TeamSheetCountdown({ detail }: { detail: MatchDayDetail }) {
  const at = detail.day.teamSheetAt;
  return (
    <div className="rounded-2xl border border-dashed border-pitch-300 bg-white px-5 py-8 text-center">
      <div className="text-3xl" aria-hidden>📋</div>
      <p className="mt-2 text-[26px] font-medium leading-tight tracking-[-0.025em]">Team sheet coming</p>
      <p className="mt-1 text-sm text-muted">
        Teams are revealed at <b className="text-ink">{detail.day.teamSheetLocal?.time ?? "07:50"}</b> on match day
        {at ? ` (${formatInstant(at, detail.day.timezone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} WAT)` : ""}.
      </p>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api";
import { CheckInPanel, DayHeaderMeta, StandingsTable, TeamsGrid, WinnerBanner } from "../components/matchday";
import { Avatar, Badge, Button, Card, Empty, ErrorBox, Loading, SectionTitle, SetChip, SplitName, StatTile, StatusBadge, TextLink } from "../components/ui";
import { formatDate, formatDateLong } from "../format";
import { useMe } from "../hooks";
import type { Announcement, LeaderRow, MatchDayDetail, Poll } from "../types";
import { MvpVote } from "../components/MvpVote";
import { AnnouncementCard } from "./Announcements";
import type { StandingRow } from "../../shared/rules";

interface Dashboard {
  cancelled: { id: string; date: string; reason: string | null }[];
  myStanding?: (StandingRow & { kind?: string }) | null;
  announcements: Announcement[];
  openPolls: Poll[];
  pendingApprovals?: number;
  pendingTransfers?: number;
  season: { id: string; name: string; startDate: string; endDate: string } | null;
  nextDay: MatchDayDetail | null;
  recent: { id: string; date: string; venue: string; matches: number; winners: { name: string; color: string }[] }[];
  leaders: { table: StandingRow[]; topScorers: LeaderRow[]; topAssists: LeaderRow[] } | null;
  pendingGuests?: number;
}

export default function DashboardPage() {
  const { data: me } = useMe();
  const isAdmin = me?.user?.role === "admin";
  const { data, isLoading, error } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<Dashboard>("/dashboard") });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data!;
  const next = d.nextDay;
  const myRow = d.myStanding ?? null;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4">
        <Avatar name={me?.player?.displayName ?? me?.user?.name ?? "?"} url={me?.player?.avatarUrl} size={64} />
        <div>
          <h1 className="text-[34px] font-medium leading-tight tracking-[-0.035em] sm:text-[42px]">
            <SplitName name={me?.player?.displayName ?? me?.user?.name ?? ""} />
          </h1>
          <div className="text-[15px] text-muted">
            {d.season?.name ?? "No active season"} · {me?.player?.kind === "guest" ? "Guest" : "Member"}
          </div>
        </div>
      </div>

      {myRow && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="League position" value={`${myRow.shared ? "=" : ""}${myRow.position}`} note={d.season?.name} watermark="Pos" />
          <StatTile label="Points" value={myRow.points} note={`${myRow.dailyWins} daily wins`} watermark="Pts" />
          <StatTile label="Goals" value={myRow.goals} watermark="Goals" />
          <StatTile label="Assists" value={myRow.assists} watermark="Ast" />
        </section>
      )}

      {isAdmin && next && (next.day.status === "in_progress" || next.sets.length > 0) && (
        <Link to={`/matchdays/${next.day.id}/live`} className="flex items-center justify-between gap-3 rounded-[22px] bg-pitch-700 px-5 py-4 text-white transition hover:bg-pitch-800">
          <span>
            <span className="block text-lg font-medium">{next.day.status === "in_progress" ? "Match day in progress — record results" : "Record results"}</span>
            <span className="text-sm text-white/80">{formatDateLong(next.day.date)}</span>
          </span>
          <span aria-hidden className="text-2xl">→</span>
        </Link>
      )}
      {isAdmin && (d.pendingTransfers ?? 0) > 0 && (
        <Link to="/admin/finance" className="block rounded-2xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-200">
          {d.pendingTransfers} bank transfer{d.pendingTransfers === 1 ? "" : "s"} waiting for you to confirm →
        </Link>
      )}
      {isAdmin && (d.pendingApprovals ?? 0) > 0 && (
        <Link to="/admin/players" className="block rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-200">
          {d.pendingApprovals} new signup{d.pendingApprovals === 1 ? "" : "s"} waiting for approval →
        </Link>
      )}
      {me?.player && !me.player.approved && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          Welcome! Your account is waiting for admin approval. Meanwhile, <Link to="/me" className="font-semibold underline">add a profile photo</Link>.
        </div>
      )}
      {d.cancelled.map((x) => (
        <Link key={x.id} to={`/matchdays/${x.id}`} className="relative block overflow-hidden rounded-[22px] border border-red-100 bg-red-50 px-5 py-4 text-ember">
          <span className="watermark !text-ember/10" aria-hidden>Off</span>
          <div className="relative text-sm">No football on {formatDateLong(x.date)}</div>
          <div className="relative text-xl font-light tracking-tight">{x.reason ?? "Match day cancelled"}</div>
        </Link>
      ))}
      {d.openPolls.map((p) => <MvpVote key={p.id} poll={p} compact />)}
      {d.announcements.length > 0 && (
        <section>
          <SectionTitle action={<TextLink to="/announcements">All</TextLink>}>Announcements</SectionTitle>
          <div className="space-y-2">{d.announcements.slice(0, 2).map((a) => <AnnouncementCard key={a.id} a={a} />)}</div>
        </section>
      )}
      {isAdmin && (d.pendingGuests ?? 0) > 0 && next && (
        <Link to={`/matchdays/${next.day.id}`} className="block rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-200">
          {d.pendingGuests} guest request{d.pendingGuests === 1 ? "" : "s"} waiting for approval →
        </Link>
      )}

      <section aria-labelledby="next-title">
        <SectionTitle>
          <span id="next-title">{next?.day.status === "in_progress" ? "Today" : "Next match day"}</span>
        </SectionTitle>
        {!next ? (
          <Empty title="Nothing scheduled" action={isAdmin ? <Link to={d.season ? "/matchdays/new" : "/admin/seasons"}><Button>{d.season ? "Schedule a match day" : "Create a season"}</Button></Link> : undefined}>
            {isAdmin ? "Create the next match day so players can check in." : "The next match day hasn't been announced yet."}
          </Empty>
        ) : (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
              <div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={next.day.status} />
                  <span className="text-sm text-muted">{next.day.seasonName}</span>
                </div>
                <div className="mt-3 text-[40px] font-light leading-[0.95] tracking-[-0.045em] sm:text-[52px]">{formatDateLong(next.day.date)}</div>
                <div className="mt-2">
                  <DayHeaderMeta detail={next} />
                </div>
              </div>
              <Link to={`/matchdays/${next.day.id}`}>
                <Button variant="secondary" size="sm">Details</Button>
              </Link>
            </div>
            <div className="mt-5 border-t border-line px-5 py-5 sm:px-6">
              <CheckInPanel detail={next} />
            </div>
          </Card>
        )}
      </section>

      {next && next.sets.length > 0 && (
        <section>
          <SectionTitle action={<TextLink to={`/matchdays/${next.day.id}`}>Full day</TextLink>}>Teams</SectionTitle>
          {next.day.status !== "checkin_open" && next.day.status !== "locked" && <div className="mb-3"><WinnerBanner detail={next} /></div>}
          <TeamsGrid detail={next} />
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <SectionTitle action={d.season && <TextLink to="/standings">Full table</TextLink>}>League leaders</SectionTitle>
          {!d.leaders || d.leaders.table.length === 0 ? (
            <Empty title="No points yet">Standings appear once the first match day is finalized.</Empty>
          ) : (
            <Card>
              <StandingsTable rows={d.leaders.table} compact highlight={me?.player?.id} />
              <div className="grid grid-cols-2 gap-px border-t border-line bg-line text-sm">
                <Leader title="Top scorer" rows={d.leaders.topScorers} value={(r) => r.goals} />
                <Leader title="Top assists" rows={d.leaders.topAssists} value={(r) => r.assists} />
              </div>
            </Card>
          )}
        </section>

        <section>
          <SectionTitle action={<TextLink to="/matchdays">All match days</TextLink>}>Recent results</SectionTitle>
          {d.recent.length === 0 ? (
            <Empty title="No results yet">Finalized match days will show here.</Empty>
          ) : (
            <ul className="space-y-2">
              {d.recent.map((r) => (
                <li key={r.id}>
                  <Link to={`/matchdays/${r.id}`}>
                    <Card className="flex items-center gap-3 px-4 py-3 hover:border-pitch-300">
                      <div className="w-20 shrink-0">
                        <div className="text-lg font-medium leading-tight">{formatDate(r.date, { day: "numeric", month: "short" })}</div>
                        <div className="text-xs text-muted">{r.matches} matches</div>
                      </div>
                      <div className="flex flex-1 flex-wrap items-center gap-2">
                        {r.winners.length === 0 ? (
                          <span className="text-sm text-muted">No winner</span>
                        ) : (
                          r.winners.map((w) => <SetChip key={w.name} name={w.name} color={w.color} />)
                        )}
                        {r.winners.length > 0 && <Badge tone="gold">🏆</Badge>}
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Leader({ title, rows, value }: { title: string; rows: LeaderRow[]; value: (r: LeaderRow) => number }) {
  const top = rows[0];
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-sm text-muted">{title}</div>
      {top ? (
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <Link to={`/players/${top.playerId}`} className="truncate font-semibold hover:underline">
            {top.displayName}
          </Link>
          <span className="num stat text-2xl text-pitch-800">{value(top)}</span>
        </div>
      ) : (
        <div className="mt-0.5 text-muted">—</div>
      )}
    </div>
  );
}

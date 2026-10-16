import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api";
import { CheckInPanel, DayHeaderMeta, StandingsTable, TeamsGrid, WinnerBanner } from "../components/matchday";
import { Badge, Button, Card, Empty, ErrorBox, Loading, SectionTitle, SetChip, StatusBadge, TextLink } from "../components/ui";
import { formatDate, formatDateLong } from "../format";
import { useMe } from "../hooks";
import type { LeaderRow, MatchDayDetail } from "../types";
import type { StandingRow } from "../../shared/rules";

interface Dashboard {
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

  return (
    <div className="space-y-8">
      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-pitch-700">{d.season?.name ?? "No active season"}</div>
        <h1 className="display text-4xl font-bold uppercase leading-none sm:text-5xl">Hi, {me?.player?.displayName ?? me?.user?.name}</h1>
      </div>

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
            <div className="bg-[linear-gradient(135deg,var(--color-pitch-800),var(--color-pitch-950))] px-5 py-5 text-white">
              <div className="flex items-center justify-between gap-2">
                <StatusBadge status={next.day.status} />
                <Link to={`/matchdays/${next.day.id}`} className="text-sm font-semibold text-pitch-100 hover:underline">
                  Details →
                </Link>
              </div>
              <div className="display mt-2 text-3xl font-bold uppercase sm:text-4xl">{formatDateLong(next.day.date)}</div>
              <DayHeaderMeta detail={next} onDark />
            </div>
            <div className="p-5">
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
                        <div className="display text-lg font-bold uppercase leading-tight">{formatDate(r.date, { day: "numeric", month: "short" })}</div>
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
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      {top ? (
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <Link to={`/players/${top.playerId}`} className="truncate font-semibold hover:underline">
            {top.displayName}
          </Link>
          <span className="num display text-2xl font-bold text-pitch-800">{value(top)}</span>
        </div>
      ) : (
        <div className="mt-0.5 text-muted">—</div>
      )}
    </div>
  );
}

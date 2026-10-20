import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { StandingsTable } from "../components/matchday";
import { Card, Empty, ErrorBox, GuestBadge, Loading, PageHeader, Select, StatTile } from "../components/ui";
import { formatDate } from "../format";
import { useMe } from "../hooks";
import type { LeaderRow, Season, Standings } from "../types";

export default function StandingsPage() {
  const { seasonId } = useParams();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: () => api.get<{ seasons: Season[] }>("/seasons") });
  const list = seasons.data?.seasons ?? [];
  const selected = seasonId ?? list.find((s) => s.status === "active")?.id ?? list[0]?.id;
  const standings = useQuery({ queryKey: ["standings", selected], queryFn: () => api.get<Standings>(`/seasons/${selected}/standings`), enabled: Boolean(selected) });

  if (seasons.isLoading) return <Loading />;
  if (seasons.error) return <ErrorBox error={seasons.error} />;
  if (list.length === 0) {
    return (
      <div>
        <PageHeader title="Standings" />
        <Empty title="No seasons yet">An admin needs to create the first season.</Empty>
      </div>
    );
  }
  const s = standings.data;
  const leader = s?.table[0];
  const scorer = s?.goals[0];
  const assister = s?.assists[0];
  const range = s ? `${formatDate(s.season.startDate, { day: "numeric", month: "short", year: "numeric" })} – ${formatDate(s.season.endDate, { day: "numeric", month: "short", year: "numeric" })}` : undefined;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Standings"
        kicker={range}
        action={
          <Select aria-label="Season" className="!w-auto !rounded-full pr-10" value={selected} onChange={(e) => navigate(`/standings/${e.target.value}`)}>
            {list.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.status === "closed" ? " (final)" : ""}
              </option>
            ))}
          </Select>
        }
      />
      {standings.isLoading ? (
        <Loading />
      ) : standings.error ? (
        <ErrorBox error={standings.error} />
      ) : (
        <>
          {s!.frozen && <div className="rounded-2xl bg-chalk px-4 py-3 text-sm ring-1 ring-line">Final table — this season is closed and its results are frozen.</div>}
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label={leader ? `Leader · ${leader.displayName}` : "Leader"} value={leader?.points ?? 0} note={leader ? `${leader.dailyWins} daily wins` : "points"} watermark="Top" />
            <StatTile label={scorer ? `Top scorer · ${scorer.displayName}` : "Top scorer"} value={scorer?.goals ?? 0} note="goals" watermark="Goals" />
            <StatTile label={assister ? `Most assists · ${assister.displayName}` : "Most assists"} value={assister?.assists ?? 0} note="assists" watermark="Ast" />
          </div>

          <section className="space-y-3">
            <div>
              <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">League table</h2>
              <p className="text-sm text-muted">3 points per daily win · ties broken by daily wins, goals, then assists · “=” is a shared position</p>
            </div>
            <Card className="overflow-hidden">
              {s!.table.length === 0 ? (
                <div className="p-5">
                  <Empty title="No points yet">The table fills in as match days are finalized.</Empty>
                </div>
              ) : (
                <StandingsTable rows={s!.table} highlight={me?.player?.id} />
              )}
            </Card>
            <Link to="/rules" className="inline-block text-sm text-muted underline underline-offset-4 hover:text-ink">How scoring works</Link>
          </section>

          <div className="grid gap-6 sm:grid-cols-2">
            <Board title="Goals" rows={s!.goals} value={(r) => r.goals} />
            <Board title="Assists" rows={s!.assists} value={(r) => r.assists} />
          </div>
        </>
      )}
    </div>
  );
}

function Board({ title, rows, value }: { title: string; rows: LeaderRow[]; value: (r: LeaderRow) => number }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">{title}</h2>
      <Card>
        {rows.length === 0 ? (
          <p className="p-5 text-sm text-muted">None yet.</p>
        ) : (
          <ol className="num divide-y divide-line">
            {rows.slice(0, 10).map((r) => (
              <li key={r.playerId} className="flex min-h-12 items-center gap-4 px-5 py-2.5">
                <span className="w-6 text-lg font-light text-muted">{r.position}</span>
                <Link to={`/players/${r.playerId}`} className="truncate hover:underline">{r.displayName}</Link>
                {r.kind === "guest" && <GuestBadge />}
                <span className="stat ml-auto text-3xl text-pitch-800">{value(r)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      {rows.some((r) => r.kind === "guest") && <p className="text-xs text-muted">Guest goals and assists count here, but guests earn no league points.</p>}
    </section>
  );
}

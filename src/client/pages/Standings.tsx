import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { StandingsTable } from "../components/matchday";
import { Badge, Card, Empty, ErrorBox, GuestBadge, Loading, PageHeader, Select } from "../components/ui";
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
  const standings = useQuery({
    queryKey: ["standings", selected],
    queryFn: () => api.get<Standings>(`/seasons/${selected}/standings`),
    enabled: Boolean(selected),
  });

  if (seasons.isLoading) return <Loading />;
  if (seasons.error) return <ErrorBox error={seasons.error} />;
  if (list.length === 0) {
    return (
      <div>
        <PageHeader title="League table" />
        <Empty title="No seasons yet">An admin needs to create the first season.</Empty>
      </div>
    );
  }
  const s = standings.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="League table"
        kicker={s ? `${formatDate(s.season.startDate, { day: "numeric", month: "short", year: "numeric" })} – ${formatDate(s.season.endDate, { day: "numeric", month: "short", year: "numeric" })}` : undefined}
        action={
          <Select aria-label="Season" className="!min-h-10 w-auto" value={selected} onChange={(e) => navigate(`/standings/${e.target.value}`)}>
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
          {s!.frozen && <div className="rounded-xl bg-pitch-900 px-4 py-3 text-sm font-semibold text-white">Final table — this season is closed and its results are frozen.</div>}
          <Card>
            {s!.table.length === 0 ? (
              <div className="p-5">
                <Empty title="No points yet">The table fills in as match days are finalized.</Empty>
              </div>
            ) : (
              <StandingsTable rows={s!.table} highlight={me?.player?.id} />
            )}
          </Card>
          <p className="text-xs text-muted">
            Pts = league points (3 per daily win) · DW = daily wins · App = appearances. Ties are broken by daily wins, goals, then assists; “=” means a shared position.{" "}
            <Link to="/rules" className="underline">
              Scoring rules
            </Link>
          </p>
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
    <section>
      <h2 className="display mb-3 text-2xl font-bold uppercase text-pitch-900">{title}</h2>
      <Card>
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-muted">None yet.</p>
        ) : (
          <ol className="num divide-y divide-line">
            {rows.slice(0, 15).map((r) => (
              <li key={r.playerId} className="flex min-h-11 items-center gap-3 px-4 py-2">
                <span className="w-6 font-bold text-muted">{r.position}</span>
                <Link to={`/players/${r.playerId}`} className="truncate hover:underline">
                  {r.displayName}
                </Link>
                {r.kind === "guest" && <GuestBadge />}
                <span className="display ml-auto text-xl font-bold text-pitch-800">{value(r)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      {rows.some((r) => r.kind === "guest") && (
        <p className="mt-2 text-xs text-muted">
          <Badge tone="amber">Guest</Badge> goals and assists count here, but guests earn no league points.
        </p>
      )}
    </section>
  );
}

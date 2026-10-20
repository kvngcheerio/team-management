import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { MvpVote, OpenSeasonVote } from "../components/MvpVote";
import { Avatar, Badge, Card, CardIcon, cx, Empty, ErrorBox, GuestBadge, Loading, PageHeader, Select, StatTile } from "../components/ui";
import { useIsAdmin, useMe } from "../hooks";
import type { Poll, Season } from "../types";
import { formatMoney } from "../../shared/rules";

interface StatRow {
  playerId: string;
  displayName: string;
  kind: string;
  avatarUrl: string | null;
  appearances: number;
  dailyWins: number;
  winRate: number;
  points: number;
  goals: number;
  assists: number;
  ownGoals: number;
  yellow: number;
  red: number;
  mvpAwards: number;
  seasonMvp: boolean;
  owed?: number;
  paid?: number;
}
interface StatsResponse {
  season: Season;
  players: StatRow[];
  totals: { matchDays: number; goals: number; yellow: number; red: number; owed?: number; paid?: number };
}

const COLUMNS: { key: keyof StatRow; label: string; title: string }[] = [
  { key: "appearances", label: "App", title: "Appearances" },
  { key: "dailyWins", label: "DW", title: "Daily wins" },
  { key: "winRate", label: "Win%", title: "Daily win rate" },
  { key: "goals", label: "G", title: "Goals" },
  { key: "assists", label: "A", title: "Assists" },
  { key: "mvpAwards", label: "MVP", title: "Weekly MVP awards" },
  { key: "yellow", label: "YC", title: "Yellow cards" },
  { key: "red", label: "RC", title: "Red cards" },
];

export default function StatsPage() {
  const { seasonId } = useParams();
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const { data: me } = useMe();
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: () => api.get<{ seasons: Season[] }>("/seasons") });
  const list = seasons.data?.seasons ?? [];
  const selected = seasonId ?? list.find((s) => s.status === "active")?.id ?? list[0]?.id;
  const stats = useQuery({ queryKey: ["stats", selected], queryFn: () => api.get<StatsResponse>(`/seasons/${selected}/stats`), enabled: Boolean(selected) });
  const polls = useQuery({ queryKey: ["polls", selected], queryFn: () => api.get<{ polls: Poll[] }>(`/polls?seasonId=${selected}`), enabled: Boolean(selected) });
  const [sort, setSort] = useState<keyof StatRow>("goals");
  const rows = useMemo(() => [...(stats.data?.players ?? [])].sort((a, b) => (b[sort] as number) - (a[sort] as number) || a.displayName.localeCompare(b.displayName)), [stats.data, sort]);
  const currency = me?.currency ?? "NGN";

  if (seasons.isLoading) return <Loading />;
  if (list.length === 0) return <Empty title="No seasons yet" />;
  const seasonPoll = polls.data?.polls.find((p) => p.kind === "season");
  const weekly = polls.data?.polls.filter((p) => p.kind === "matchday" && !p.cancelled) ?? [];
  const t = stats.data?.totals;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Stats"
        action={
          <Select aria-label="Season" className="!w-auto !rounded-full pr-10" value={selected} onChange={(e) => navigate(`/stats/${e.target.value}`)}>
            {list.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.status === "closed" ? " (final)" : ""}</option>
            ))}
          </Select>
        }
      />
      {stats.isLoading ? <Loading /> : stats.error ? <ErrorBox error={stats.error} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Match days" value={t!.matchDays} note="finalized" watermark="Days" />
            <StatTile label="Goals" value={t!.goals} note={t!.matchDays ? `${(t!.goals / t!.matchDays).toFixed(1)} per day` : undefined} watermark="Goals" />
            <StatTile label="Yellow cards" value={t!.yellow} watermark="Yellow" />
            <StatTile label="Red cards" value={t!.red} tone={t!.red > 0 ? "text-ember" : undefined} watermark="Red" />
          </div>
          {isAdmin && t!.owed !== undefined && (
            <div className="grid grid-cols-2 gap-3">
              <StatTile label="Fines outstanding" value={formatMoney(t!.owed!, currency)} tone="text-ember" note={<Link to="/admin/fines" className="underline">Manage</Link>} watermark="Owed" className="[&_.stat]:text-[40px] sm:[&_.stat]:text-[48px]" />
              <StatTile label="Fines collected" value={formatMoney(t!.paid!, currency)} tone="text-pitch-800" watermark="Paid" className="[&_.stat]:text-[40px] sm:[&_.stat]:text-[48px]" />
            </div>
          )}

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Season MVP</h2>
                <p className="text-sm text-muted">Voted by members once the admin opens it</p>
              </div>
              {isAdmin && !seasonPoll && stats.data!.season.matchDays > 0 && <OpenSeasonVote seasonId={selected!} />}
            </div>
            {seasonPoll ? <MvpVote poll={seasonPoll} /> : <p className="text-sm text-muted">The season MVP vote hasn't opened yet.</p>}
          </section>

          <section className="space-y-3">
          <div>
            <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Players</h2>
            <p className="text-sm text-muted">Tap a column to sort</p>
          </div>
          <Card className="overflow-x-auto">
            {rows.length === 0 ? (
              <div className="p-5"><Empty title="No stats yet">Stats appear after the first finalized match day.</Empty></div>
            ) : (
              <table className="num w-full min-w-[640px] text-left text-sm">
                <caption className="sr-only">Player statistics — tap a column to sort</caption>
                <thead className="text-xs text-muted">
                  <tr className="border-b border-line">
                    <th className="px-5 py-3 font-normal">Player</th>
                    {COLUMNS.map((col) => (
                      <th key={col.key} className="px-1 py-1 text-center">
                        <button title={col.title} onClick={() => setSort(col.key)} className={cx("min-h-9 rounded-full px-3 font-normal", sort === col.key ? "bg-pitch-700 text-white" : "hover:bg-chalk")}>
                          {col.label}
                        </button>
                      </th>
                    ))}
                    {isAdmin && <th className="px-4 py-3 text-right font-normal">Owed</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.playerId} className="border-b border-line transition last:border-0 hover:bg-chalk">
                      <td className="px-5 py-2.5">
                        <Link to={`/players/${r.playerId}`} className="flex items-center gap-2 hover:underline">
                          <Avatar name={r.displayName} url={r.avatarUrl} size={28} />
                          <span className="truncate font-medium">{r.displayName}</span>
                          {r.kind === "guest" && <GuestBadge />}
                          {r.seasonMvp && <Badge tone="gold">Season MVP</Badge>}
                        </Link>
                      </td>
                      {COLUMNS.map((col) => (
                        <td key={col.key} className={cx("px-2 text-center", sort === col.key && "font-medium text-pitch-800")}>
                          {col.key === "yellow" && r.yellow > 0 ? <span className="inline-flex items-center gap-1"><CardIcon color="yellow" />{r.yellow}</span>
                            : col.key === "red" && r.red > 0 ? <span className="inline-flex items-center gap-1"><CardIcon color="red" />{r.red}</span>
                            : col.key === "winRate" ? `${r.winRate}%` : (r[col.key] as number)}
                        </td>
                      ))}
                      {isAdmin && <td className={cx("px-3 text-right", (r.owed ?? 0) > 0 && "font-semibold text-red-700")}>{formatMoney(r.owed ?? 0, currency)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          </section>

          {weekly.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Weekly MVPs</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {weekly.map((p) => <MvpVote key={p.id} poll={p} compact />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

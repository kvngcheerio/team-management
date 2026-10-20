import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { ChartPanel, FormStrip, InvolvementBars, type FormPoint } from "../components/charts";
import { Avatar, Badge, Card, CardIcon, Empty, ErrorBox, GuestBadge, KeyValue, Loading, SetChip, SplitName, StatTile } from "../components/ui";
import { formatDate, formatDateLong } from "../format";
import type { Player } from "../types";

interface Profile {
  player: Player & { memberSince?: string | null };
  isSelf: boolean;
  seasons: { seasonId: string; name: string; status: string; points: number; dailyWins: number; appearances: number; goals: number; assists: number; ownGoals: number }[];
  cards: { seasonId: string; yellow: number; red: number }[];
  history: { matchDayId: string; date: string; venue: string; setName: string | null; setColor: string | null; setWon: number; attended: number; eligible: number; points: number; goals: number; assists: number; ownGoals: number }[];
}

const GK = { none: "Outfield", can: "Can play in goal", prefers: "Goalkeeper" } as const;

export default function PlayerProfilePage() {
  const { id } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["player", id], queryFn: () => api.get<Profile>(`/players/${id}`) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { player, seasons, history, isSelf, cards } = data!;
  const current = seasons[0];
  const currentCards = cards.find((k) => k.seasonId === current?.seasonId);
  const winRate = current && current.appearances > 0 ? Math.round((current.dailyWins / current.appearances) * 100) : 0;
  const form: FormPoint[] = [...history].reverse().map((h) => ({
    key: h.matchDayId,
    date: h.date,
    state: h.attended === 0 ? "absent" : h.setWon === 1 ? "win" : "played",
    points: h.points,
    goals: h.goals,
    assists: h.assists,
  }));

  return (
    <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr]">
      {/* Left: identity + key facts + stat tiles */}
      <div className="space-y-6">
        <div className="flex items-center gap-4 border-b border-line pb-6">
          <Avatar name={player.displayName} url={player.avatarUrl} size={76} />
          <div className="min-w-0">
            <h1 className="truncate text-[34px] font-medium leading-tight tracking-[-0.035em] sm:text-[40px]">
              <SplitName name={player.displayName} />
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[17px] text-ink">
              {current ? (
                <>
                  <span>{current.appearances} apps</span>
                  <span className="size-1 rounded-full bg-line" aria-hidden />
                  <span>{current.goals} goal{current.goals === 1 ? "" : "s"}</span>
                  <span className="size-1 rounded-full bg-line" aria-hidden />
                  <span>{current.assists} assist{current.assists === 1 ? "" : "s"}</span>
                </>
              ) : (
                <span className="text-muted">No finalized matches yet</span>
              )}
              {isSelf && <Badge tone="dark">You</Badge>}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
          <KeyValue label="Preferred name" value={player.displayName.split(" ")[0]} />
          <KeyValue label="Status" value={player.kind === "guest" ? <span className="inline-flex items-center gap-2">Guest <GuestBadge /></span> : "Member"} />
          <KeyValue label="Member since" value={player.memberSince ? formatDate(player.memberSince.slice(0, 10), { month: "short", year: "numeric" }) : "—"} />
          <KeyValue label="Season points" value={current?.points ?? 0} />
          <KeyValue label="Daily wins" value={current?.dailyWins ?? 0} />
          <KeyValue label="Cards" value={<span className="inline-flex items-center gap-3"><span className="inline-flex items-center gap-1"><CardIcon color="yellow" />{currentCards?.yellow ?? 0}</span><span className="inline-flex items-center gap-1"><CardIcon color="red" />{currentCards?.red ?? 0}</span></span>} />
          {player.gkPreference && <KeyValue label="Position" value={GK[player.gkPreference]} />}
          {player.skillRating !== undefined && <KeyValue label="Rating (private)" value={`${player.skillRating}/10`} />}
          {player.contactPhone && <KeyValue label="Phone (private)" value={player.contactPhone} />}
        </div>

        {player.kind === "guest" && <p className="text-sm text-muted">Guests' goals and assists count, but they earn no league points unless they become members.</p>}

        <section>
          <div className="mb-3">
            <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">{current?.name ?? "This season"}</h2>
            <p className="text-sm text-muted">Finalized match days only</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Points" value={current?.points ?? 0} note={`${current?.dailyWins ?? 0} daily wins`} watermark="Pts" />
            <StatTile label="Win rate" value={`${winRate}%`} note={`${current?.appearances ?? 0} apps`} watermark="Win" />
            <StatTile label="Goals" value={current?.goals ?? 0} note={current?.ownGoals ? `${current.ownGoals} own goal${current.ownGoals === 1 ? "" : "s"}` : undefined} watermark="Goals" />
            <StatTile label="Assists" value={current?.assists ?? 0} watermark="Ast" />
          </div>
        </section>
      </div>

      {/* Right: charts panel */}
      <div className="space-y-6">
        {form.length > 0 ? (
          <ChartPanel>
            <div>
              <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Form by match day</h2>
              <p className="text-sm text-muted">Oldest to newest · hover a dot for details</p>
            </div>
            <FormStrip points={form} title="Result on each match day" />
            <div className="border-t border-line" />
            <InvolvementBars points={form} />
          </ChartPanel>
        ) : (
          <Empty title="No match history yet">Charts appear after the first finalized match day.</Empty>
        )}

        {seasons.length > 1 && (
          <Card className="p-5">
            <h3 className="mb-3 text-lg font-medium">Previous seasons</h3>
            <table className="num w-full text-sm">
              <thead className="text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="py-2 text-left font-normal">Season</th>
                  <th className="font-normal">Pts</th>
                  <th className="font-normal">DW</th>
                  <th className="font-normal">App</th>
                  <th className="font-normal">G</th>
                  <th className="font-normal">A</th>
                </tr>
              </thead>
              <tbody>
                {seasons.slice(1).map((s) => (
                  <tr key={s.seasonId} className="border-b border-line text-center last:border-0">
                    <td className="py-2.5 text-left"><Link to={`/standings/${s.seasonId}`} className="hover:underline">{s.name}</Link></td>
                    <td className="font-medium">{s.points}</td>
                    <td>{s.dailyWins}</td>
                    <td>{s.appearances}</td>
                    <td>{s.goals}</td>
                    <td>{s.assists}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {history.length > 0 && (
          <section>
            <h3 className="mb-3 text-lg font-medium">Match history</h3>
            <Card>
              <ul className="divide-y divide-line">
                {history.map((h) => (
                  <li key={h.matchDayId}>
                    <Link to={`/matchdays/${h.matchDayId}`} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-chalk">
                      <span className="w-28 text-sm">{formatDateLong(h.date).replace(/^\w+, /, "")}</span>
                      {h.setName && <SetChip name={h.setName} color={h.setColor ?? "#999"} className="text-sm font-normal" />}
                      {h.setWon === 1 && h.attended === 1 && <Badge tone="green">Won the day</Badge>}
                      {h.attended === 0 && <Badge tone="red">Absent</Badge>}
                      <span className="num ml-auto flex gap-3 text-sm text-muted">
                        {h.goals > 0 && <span>{h.goals}G</span>}
                        {h.assists > 0 && <span>{h.assists}A</span>}
                        <span className="font-medium text-ink">{h.points} pts</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}

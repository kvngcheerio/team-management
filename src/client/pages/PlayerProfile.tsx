import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { Badge, Card, Empty, ErrorBox, GuestBadge, Loading, PageHeader, SetChip } from "../components/ui";
import { formatDate } from "../format";
import type { Player } from "../types";

interface Profile {
  player: Player;
  isSelf: boolean;
  seasons: { seasonId: string; name: string; status: string; points: number; dailyWins: number; appearances: number; goals: number; assists: number; ownGoals: number }[];
  history: { matchDayId: string; date: string; venue: string; setName: string | null; setColor: string | null; setWon: number; attended: number; eligible: number; points: number; goals: number; assists: number; ownGoals: number }[];
}

export default function PlayerProfilePage() {
  const { id } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["player", id], queryFn: () => api.get<Profile>(`/players/${id}`) });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { player, seasons, history, isSelf } = data!;
  const current = seasons[0];
  return (
    <div className="space-y-6">
      <PageHeader
        title={player.displayName}
        kicker={
          <span className="flex items-center gap-2">
            {player.kind === "guest" ? <GuestBadge /> : <Badge tone="green">Member</Badge>}
            {isSelf && <Badge tone="dark">You</Badge>}
          </span>
        }
      />
      {player.kind === "guest" && <p className="text-sm text-muted">Guests' goals and assists are recorded, but they earn no league points unless they become members.</p>}
      {player.skillRating !== undefined && (
        <Card className="p-4 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Private (admins only)</div>
          <div className="mt-1">Rating {player.skillRating}/10 · Goalkeeper: {player.gkPreference} · {player.hasAccount ? `Login: ${player.accountEmail}` : "No login"}</div>
          {(player.contactPhone || player.contactEmail) && <div>{[player.contactPhone, player.contactEmail].filter(Boolean).join(" · ")}</div>}
        </Card>
      )}
      {current ? (
        <section>
          <h2 className="display mb-3 text-2xl font-bold uppercase text-pitch-900">{current.name}</h2>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {[
              ["Points", current.points],
              ["Daily wins", current.dailyWins],
              ["Apps", current.appearances],
              ["Goals", current.goals],
              ["Assists", current.assists],
              ["Own goals", current.ownGoals],
            ].map(([label, value]) => (
              <Card key={label} className="px-3 py-3 text-center">
                <div className="num display text-3xl font-bold text-pitch-800">{value}</div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
              </Card>
            ))}
          </div>
        </section>
      ) : (
        <Empty title="No finalized matches yet">Stats appear after the first finalized match day.</Empty>
      )}
      {seasons.length > 1 && (
        <section>
          <h2 className="display mb-3 text-2xl font-bold uppercase text-pitch-900">Previous seasons</h2>
          <Card>
            <table className="num w-full text-sm">
              <thead className="text-xs uppercase text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 text-left">Season</th>
                  <th className="px-2">Pts</th>
                  <th className="px-2">DW</th>
                  <th className="px-2">App</th>
                  <th className="px-2">G</th>
                  <th className="px-2 pr-4">A</th>
                </tr>
              </thead>
              <tbody>
                {seasons.slice(1).map((s) => (
                  <tr key={s.seasonId} className="border-b border-line text-center last:border-0">
                    <td className="px-4 py-2.5 text-left">
                      <Link to={`/standings/${s.seasonId}`} className="hover:underline">{s.name}</Link>
                    </td>
                    <td className="font-bold">{s.points}</td>
                    <td>{s.dailyWins}</td>
                    <td>{s.appearances}</td>
                    <td>{s.goals}</td>
                    <td className="pr-4">{s.assists}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}
      {history.length > 0 && (
        <section>
          <h2 className="display mb-3 text-2xl font-bold uppercase text-pitch-900">Match history</h2>
          <Card>
            <ul className="divide-y divide-line">
              {history.map((h) => (
                <li key={h.matchDayId}>
                  <Link to={`/matchdays/${h.matchDayId}`} className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-pitch-50">
                    <span className="w-24 text-sm font-semibold">{formatDate(h.date)}</span>
                    {h.setName && <SetChip name={h.setName} color={h.setColor ?? "#999"} className="text-sm" />}
                    {h.setWon === 1 && <Badge tone="gold">🏆</Badge>}
                    {h.attended === 0 && <Badge tone="red">Absent</Badge>}
                    <span className="num ml-auto flex gap-3 text-sm">
                      {h.goals > 0 && <span>⚽ {h.goals}</span>}
                      {h.assists > 0 && <span>🅰 {h.assists}</span>}
                      <span className="font-bold text-pitch-800">{h.points} pts</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { formatDate, formatInstant } from "../format";
import { useMe } from "../hooks";
import type { Poll } from "../types";
import { Avatar, Badge, Button, Card, cx, useToast } from "./ui";

export function MvpVote({ poll, compact }: { poll: Poll; compact?: boolean }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const vote = useMutation({
    mutationFn: (candidatePlayerId: string) => api.post<{ poll: Poll }>(`/polls/${poll.id}/vote`, { candidatePlayerId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["matchday"] });
      qc.invalidateQueries({ queryKey: ["polls"] });
      toast("Vote saved — you can change it until voting closes");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const tz = me?.timezone ?? "Africa/Lagos";
  const title = poll.kind === "season" ? `Season MVP · ${poll.seasonName ?? ""}` : `MVP · ${poll.matchDayDate ? formatDate(poll.matchDayDate) : "match day"}`;
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <h3 className="text-xl font-medium tracking-tight">⭐ {title}</h3>
        <span className="text-xs text-muted">
          {poll.open ? `Closes ${formatInstant(poll.closesAt, tz)}` : "Voting closed"} · {poll.turnout.voted}/{poll.turnout.eligible} voted
        </span>
      </div>
      {poll.results ? (
        <div className="p-4">
          {poll.results.winners.length === 0 ? (
            <p className="text-sm text-muted">No votes were cast.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              {poll.results.winners.map((w) => (
                <div key={w.playerId} className="flex items-center gap-3">
                  <Avatar name={w.displayName} url={w.avatarUrl} size={52} />
                  <div>
                    <div className="text-[26px] font-medium leading-tight tracking-[-0.025em]">{w.displayName}</div>
                    <Badge tone="gold">{poll.results!.winners.length > 1 ? "Shared MVP" : "MVP"}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!compact && poll.results.ranked.length > 0 && (
            <ol className="mt-3 space-y-1 text-sm">
              {poll.results.ranked.map((r) => (
                <li key={r.playerId} className="flex justify-between">
                  <span>{r.displayName}</span>
                  <span className="num font-semibold">{r.votes} vote{r.votes === 1 ? "" : "s"}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : poll.canVote ? (
        <div className="p-4">
          <p className="mb-3 text-sm text-muted">Who was the best player? Results show when voting closes.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {poll.candidates.map((c) => (
              <button
                key={c.playerId}
                disabled={vote.isPending}
                onClick={() => vote.mutate(c.playerId)}
                aria-pressed={poll.myVote === c.playerId}
                className={cx(
                  "flex min-h-14 items-center gap-2 rounded-xl border-2 px-3 text-left text-sm font-semibold",
                  poll.myVote === c.playerId ? "border-gold bg-gold-soft" : "border-line bg-white hover:border-pitch-300",
                )}
              >
                <Avatar name={c.displayName} url={c.avatarUrl} size={30} />
                <span className="truncate">{c.displayName}</span>
                {poll.myVote === c.playerId && <span className="ml-auto" aria-label="your vote">✓</span>}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="p-4 text-sm text-muted">
          {poll.open ? (poll.kind === "matchday" ? "Only players who attended can vote." : "Only approved members can vote.") : "Results unavailable."}
        </p>
      )}
    </Card>
  );
}

export function OpenSeasonVote({ seasonId, onDone }: { seasonId: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const open = useMutation({
    mutationFn: () => api.post(`/seasons/${seasonId}/mvp-poll`, { days: 7 }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast("Season MVP vote is open for 7 days");
      onDone?.();
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  return (
    <Button size="sm" variant="gold" loading={open.isPending} onClick={() => open.mutate()}>
      Open season MVP vote
    </Button>
  );
}

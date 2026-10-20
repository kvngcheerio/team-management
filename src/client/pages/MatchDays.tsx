import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader, StatusBadge } from "../components/ui";
import { formatDate, REG_LABEL } from "../format";
import { useIsAdmin } from "../hooks";
import type { MatchDaySummary } from "../types";

export default function MatchDaysPage() {
  const isAdmin = useIsAdmin();
  const { data, isLoading, error } = useQuery({ queryKey: ["matchdays"], queryFn: () => api.get<{ matchDays: MatchDaySummary[] }>("/matchdays") });
  const days = data?.matchDays ?? [];
  const upcoming = days.filter((d) => !["finalized", "cancelled"].includes(d.status)).reverse();
  const past = days.filter((d) => ["finalized", "cancelled"].includes(d.status));
  return (
    <div>
      <PageHeader
        title="Match days"
        action={
          isAdmin && (
            <Link to="/matchdays/new">
              <Button>New match day</Button>
            </Link>
          )
        }
      />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : days.length === 0 ? (
        <Empty title="No match days yet">{isAdmin ? "Create the first one to open check-in." : "Check back soon."}</Empty>
      ) : (
        <div className="space-y-8">
          {upcoming.length > 0 && <DayList title="Upcoming" days={upcoming} isAdmin={isAdmin} />}
          {past.length > 0 && <DayList title="Past" days={past} isAdmin={isAdmin} />}
        </div>
      )}
    </div>
  );
}

function DayList({ title, days, isAdmin }: { title: string; days: MatchDaySummary[]; isAdmin: boolean }) {
  return (
    <section className="space-y-3">
      <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">{title}</h2>
      <Card>
        <ul className="divide-y divide-line">
          {days.map((d) => (
            <li key={d.id}>
              <Link to={`/matchdays/${d.id}`} className="flex items-center gap-5 px-5 py-4 transition hover:bg-chalk">
                <div className="w-14 shrink-0">
                  <div className="stat text-[44px] leading-none">{formatDate(d.date, { day: "numeric" })}</div>
                  <div className="text-sm text-muted">{formatDate(d.date, { month: "short" })} · {formatDate(d.date, { weekday: "short" })}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={d.status} />
                    {isAdmin && d.status === "in_progress" && <Badge tone="blue">Live · record results</Badge>}
                    {d.myStatus && d.myStatus !== "withdrawn" && <Badge tone={d.myStatus === "confirmed" ? "green" : "amber"}>{d.myStatus === "confirmed" && d.status === "finalized" ? "Played" : REG_LABEL[d.myStatus]}</Badge>}
                    {isAdmin && (d.pending ?? 0) > 0 && <Badge tone="amber">{d.pending} pending</Badge>}
                  </div>
                  <div className="mt-1.5 truncate text-[15px] text-ink">
                    {d.kickoffTime}
                    {d.venue && <span className="text-muted"> · {d.venue}</span>}
                  </div>
                </div>
                <div className="num text-right">
                  <div className="text-2xl font-light tracking-tight">
                    {d.confirmed}
                    <span className="text-muted">/{d.capacity}</span>
                  </div>
                  <div className="text-xs text-muted">{d.waitlist > 0 ? `+${d.waitlist} waiting` : "playing"}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

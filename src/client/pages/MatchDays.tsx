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
    <section>
      <h2 className="display mb-3 text-2xl font-bold uppercase text-pitch-900">{title}</h2>
      <ul className="space-y-2">
        {days.map((d) => (
          <li key={d.id}>
            <Link to={`/matchdays/${d.id}`}>
              <Card className="flex items-center gap-4 px-4 py-3 hover:border-pitch-300">
                <div className="w-16 shrink-0 text-center">
                  <div className="text-xs font-semibold uppercase text-muted">{formatDate(d.date, { weekday: "short" })}</div>
                  <div className="display text-3xl font-bold leading-none">{formatDate(d.date, { day: "numeric" })}</div>
                  <div className="text-xs font-semibold uppercase text-muted">{formatDate(d.date, { month: "short" })}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={d.status} />
                    {d.myStatus && d.myStatus !== "withdrawn" && <Badge tone={d.myStatus === "confirmed" ? "green" : "amber"}>{REG_LABEL[d.myStatus]}</Badge>}
                    {isAdmin && (d.pending ?? 0) > 0 && <Badge tone="amber">{d.pending} pending</Badge>}
                  </div>
                  <div className="mt-1 truncate text-sm text-muted">
                    {d.kickoffTime} {d.venue && `· ${d.venue}`}
                  </div>
                </div>
                <div className="num text-right text-sm">
                  <div className="font-bold">
                    {d.confirmed}/{d.capacity}
                  </div>
                  {d.waitlist > 0 && <div className="text-xs text-muted">+{d.waitlist} waiting</div>}
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

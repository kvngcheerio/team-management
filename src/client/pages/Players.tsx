import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Card, Empty, ErrorBox, GuestBadge, Input, Loading, PageHeader, TextLink } from "../components/ui";
import { useIsAdmin } from "../hooks";
import type { Player } from "../types";

export default function PlayersPage() {
  const isAdmin = useIsAdmin();
  const { data, isLoading, error } = useQuery({ queryKey: ["players"], queryFn: () => api.get<{ players: Player[] }>("/players") });
  const [q, setQ] = useState("");
  const list = (data?.players ?? []).filter((p) => p.active && p.displayName.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader title="Players" action={isAdmin && <TextLink to="/admin/players">Manage players</TextLink>} />
      <Input type="search" placeholder="Search players" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4" aria-label="Search players" />
      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : list.length === 0 ? (
        <Empty title="No players">{isAdmin ? "Add players in the admin area." : "No players match."}</Empty>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {list.map((p) => (
              <li key={p.id}>
                <Link to={`/players/${p.id}`} className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-pitch-50">
                  <span className="grid size-9 place-items-center rounded-full bg-pitch-100 text-sm font-bold text-pitch-800">{p.displayName.slice(0, 1).toUpperCase()}</span>
                  <span className="font-medium">{p.displayName}</span>
                  {p.kind === "guest" && <GuestBadge />}
                  <span className="ml-auto text-muted">›</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

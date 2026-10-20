import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, useToast } from "../components/ui";
import { formatInstant } from "../format";
import { useIsAdmin, useMe } from "../hooks";
import type { Announcement } from "../types";

export function AnnouncementCard({ a, onDelete }: { a: Announcement; onDelete?: () => void }) {
  const { data: me } = useMe();
  return (
    <Card className={a.pinned ? "border-pitch-300 bg-pitch-50/40 p-4" : "p-4"}>
      <div className="flex flex-wrap items-center gap-2">
        {a.pinned && <Badge tone="green">📌 Pinned</Badge>}
        <h3 className="text-lg font-bold">{a.title}</h3>
      </div>
      <p className="mt-1.5 whitespace-pre-line text-[15px] leading-relaxed">{a.body}</p>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <span>
          {a.authorName} · {formatInstant(a.createdAt, me?.timezone ?? "Africa/Lagos")}
        </span>
        {onDelete && (
          <button className="ml-auto font-semibold text-red-700 hover:underline" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </Card>
  );
}

export default function AnnouncementsPage() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ["announcements"], queryFn: () => api.get<{ announcements: Announcement[] }>("/announcements") });
  const [f, setF] = useState({ title: "", body: "", pinned: false });
  const post = useMutation({
    mutationFn: () => api.post("/announcements", f),
    onSuccess: () => {
      setF({ title: "", body: "", pinned: false });
      qc.invalidateQueries({ queryKey: ["announcements"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast("Announcement posted");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.req("DELETE", `/announcements/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["announcements"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="Announcements" />
      {isAdmin && (
        <Card className="p-4">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); post.mutate(); }}>
            <Field label="Title"><Input required maxLength={120} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Message">
              <textarea required maxLength={4000} rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} className="w-full rounded-xl border border-line bg-white px-3.5 py-3 text-base focus:border-pitch-500 focus:outline-none focus:ring-2 focus:ring-pitch-200" />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="size-5 accent-pitch-700" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to the top
            </label>
            <Button type="submit" loading={post.isPending}>Post announcement</Button>
          </form>
        </Card>
      )}
      {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : data!.announcements.length === 0 ? (
        <Empty title="No announcements">News from the organisers will appear here.</Empty>
      ) : (
        <div className="space-y-3">
          {data!.announcements.map((a) => (
            <AnnouncementCard key={a.id} a={a} onDelete={isAdmin ? () => del.mutate(a.id) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, useParams } from "react-router";
import { api } from "../api";
import { Badge, Button, Card, ConfirmDialog, cx, Empty, ErrorBox, Field, GuestBadge, Input, Loading, PageHeader, Select, useToast } from "../components/ui";
import { formatInstant } from "../format";
import { useMe } from "../hooks";
import type { Player, Season } from "../types";
import { defaultSeasonEnd } from "../../shared/rules";

const TABS = [
  { key: "seasons", label: "Seasons" },
  { key: "players", label: "Players" },
  { key: "users", label: "Logins" },
  { key: "settings", label: "Settings" },
  { key: "audit", label: "Audit log" },
] as const;

function useAdminMutation<V>(fn: (v: V) => Promise<unknown>, success: string, keys: string[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      toast(success);
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
}

export default function AdminPage() {
  const { tab = "seasons" } = useParams();
  return (
    <div>
      <PageHeader title="Admin" />
      <nav className="-mx-4 mb-5 flex gap-1 overflow-x-auto px-4" aria-label="Admin sections">
        {TABS.map((t) => (
          <NavLink
            key={t.key}
            to={`/admin/${t.key}`}
            className={() => cx("min-h-10 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold", tab === t.key ? "bg-pitch-800 text-white" : "bg-white text-ink ring-1 ring-line")}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {tab === "seasons" && <SeasonsTab />}
      {tab === "players" && <PlayersTab />}
      {tab === "users" && <UsersTab />}
      {tab === "settings" && <SettingsTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SeasonsTab() {
  const { data, isLoading, error } = useQuery({ queryKey: ["seasons"], queryFn: () => api.get<{ seasons: Season[] }>("/seasons") });
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [closing, setClosing] = useState<Season | null>(null);
  const create = useAdminMutation(
    () => api.post("/seasons", { name, startDate, endDate: endDate || undefined }),
    "Season created",
    [["seasons"], ["dashboard"]],
  );
  const close = useAdminMutation((s: Season) => api.post(`/seasons/${s.id}/close`, {}), "Season closed and table frozen", [["seasons"], ["standings"]]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(undefined, { onSuccess: () => { setName(""); setStartDate(""); setEndDate(""); } });
  };
  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h2 className="display text-2xl font-bold uppercase">New season</h2>
        <p className="mb-3 text-sm text-muted">Seasons run six calendar months. The end date defaults to the day before the same date six months later.</p>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="2026/27 · First half" />
          </Field>
          <Field label="Start date">
            <Input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="End date" hint={startDate ? `Default: ${defaultSeasonEnd(startDate)}` : "Pick a start date"}>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" loading={create.isPending}>Create season</Button>
          </div>
        </form>
      </Card>
      {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : (data?.seasons ?? []).length === 0 ? (
        <Empty title="No seasons yet">Create the first season above.</Empty>
      ) : (
        <ul className="space-y-2">
          {data!.seasons.map((s) => <SeasonRow key={s.id} season={s} onClose={() => setClosing(s)} />)}
        </ul>
      )}
      <ConfirmDialog
        open={!!closing}
        title={`Close ${closing?.name}?`}
        confirmLabel="Close season"
        tone="danger"
        loading={close.isPending}
        onClose={() => setClosing(null)}
        onConfirm={() => close.mutate(closing!, { onSettled: () => setClosing(null) })}
      >
        The final table is frozen and no further corrections are allowed for this season. All match days must be finalized or cancelled.
      </ConfirmDialog>
    </div>
  );
}

function SeasonRow({ season: s, onClose }: { season: Season; onClose: () => void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ name: s.name, startDate: s.startDate, endDate: s.endDate });
  const save = useAdminMutation(() => api.patch(`/seasons/${s.id}`, s.datesEditable ? f : { name: f.name }), "Season updated", [["seasons"]]);
  return (
    <li>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="display text-xl font-bold uppercase">{s.name}</span>
          <Badge tone={s.status === "active" ? "green" : "dark"}>{s.status === "active" ? "Active" : "Closed"}</Badge>
          <span className="text-sm text-muted">{s.startDate} → {s.endDate} · {s.timezone}</span>
          <span className="text-sm text-muted">· {s.finalizedDays}/{s.matchDays} days finalized</span>
          <div className="ml-auto flex gap-2">
            <Link to={`/standings/${s.id}`}><Button size="sm" variant="ghost">Table</Button></Link>
            {s.status === "active" && <Button size="sm" variant="secondary" onClick={() => setEditing((e) => !e)}>Edit</Button>}
            {s.status === "active" && <Button size="sm" variant="danger" onClick={onClose}>Close</Button>}
          </div>
        </div>
        {editing && (
          <form className="mt-3 grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: () => setEditing(false) }); }}>
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Start" hint={s.datesEditable ? undefined : "Locked: play has started"}><Input type="date" disabled={!s.datesEditable} value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
            <Field label="End"><Input type="date" disabled={!s.datesEditable} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
            <div className="sm:col-span-3"><Button type="submit" loading={save.isPending}>Save</Button></div>
          </form>
        )}
      </Card>
    </li>
  );
}

// ---------------------------------------------------------------------------

function PlayersTab() {
  const { data, isLoading, error } = useQuery({ queryKey: ["players"], queryFn: () => api.get<{ players: Player[] }>("/players") });
  const [form, setForm] = useState({ displayName: "", kind: "member", skillRating: "5", gkPreference: "none", contactPhone: "", contactEmail: "" });
  const [showInactive, setShowInactive] = useState(false);
  const create = useAdminMutation(
    () => api.post("/players", { ...form, skillRating: Number(form.skillRating) }),
    "Player added",
    [["players"]],
  );
  const list = (data?.players ?? []).filter((p) => showInactive || p.active);
  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h2 className="display text-2xl font-bold uppercase">Add player</h2>
        <p className="mb-3 text-sm text-muted">Players don't need a login. Send an invite link later to connect one — their history stays attached.</p>
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => { e.preventDefault(); create.mutate(undefined, { onSuccess: () => setForm({ ...form, displayName: "", contactPhone: "", contactEmail: "" }) }); }}
        >
          <Field label="Name"><Input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label="Type">
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="member">Member</option>
              <option value="guest">Guest</option>
            </Select>
          </Field>
          <Field label="Skill rating (private, 1–10)"><Input type="number" min={1} max={10} value={form.skillRating} onChange={(e) => setForm({ ...form, skillRating: e.target.value })} /></Field>
          <Field label="Goalkeeper">
            <Select value={form.gkPreference} onChange={(e) => setForm({ ...form, gkPreference: e.target.value })}>
              <option value="none">Outfield only</option>
              <option value="can">Can play in goal</option>
              <option value="prefers">Prefers goal</option>
            </Select>
          </Field>
          <Field label="Phone (private)"><Input type="tel" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} /></Field>
          <Field label="Email (private)"><Input type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} /></Field>
          <div className="sm:col-span-3"><Button type="submit" loading={create.isPending}>Add player</Button></div>
        </form>
      </Card>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" className="size-5 accent-pitch-700" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive players
      </label>
      {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : list.length === 0 ? <Empty title="No players yet" /> : (
        <Card>
          <ul className="divide-y divide-line">{list.map((p) => <AdminPlayerRow key={p.id} player={p} />)}</ul>
        </Card>
      )}
    </div>
  );
}

function AdminPlayerRow({ player: p }: { player: Player }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ displayName: p.displayName, skillRating: String(p.skillRating ?? 5), gkPreference: p.gkPreference ?? "none", contactPhone: p.contactPhone ?? "", contactEmail: p.contactEmail ?? "", active: p.active });
  const [convert, setConvert] = useState(false);
  const [retro, setRetro] = useState(false);
  const save = useAdminMutation(() => api.patch(`/players/${p.id}`, { ...f, skillRating: Number(f.skillRating) }), "Player saved", [["players"]]);
  const doConvert = useAdminMutation((reason: string) => api.post(`/players/${p.id}/convert`, { retroactive: retro, reason: reason || undefined }), "Converted to member", [["players"], ["standings"]]);
  const unlink = useAdminMutation(() => api.post(`/players/${p.id}/unlink`, { reason: "Login reset by admin" }), "Login unlinked — send a new invite", [["players"], ["users"]]);
  const invite = useMutation({
    mutationFn: () => api.post<{ url: string; expiresAt: string }>(`/players/${p.id}/invite`),
    onSuccess: async (r) => {
      try {
        await navigator.clipboard.writeText(r.url);
        toast("Invite link copied — valid for 14 days");
      } catch {
        prompt("Invite link (valid for 14 days):", r.url);
      }
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/players/${p.id}`} className="font-semibold hover:underline">{p.displayName}</Link>
        {p.kind === "guest" ? <GuestBadge /> : <Badge tone="green">Member</Badge>}
        {!p.active && <Badge tone="red">Inactive</Badge>}
        {p.hasAccount ? <Badge tone="blue">Login</Badge> : <Badge>No login</Badge>}
        <span className="num text-xs text-muted">★{p.skillRating} · GK {p.gkPreference}</span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {!p.hasAccount && <Button size="sm" variant="secondary" loading={invite.isPending} onClick={() => invite.mutate()}>Invite link</Button>}
          {p.hasAccount && <Button size="sm" variant="ghost" loading={unlink.isPending} onClick={() => unlink.mutate(undefined)}>Unlink login</Button>}
          {p.kind === "guest" && <Button size="sm" variant="secondary" onClick={() => setConvert(true)}>Make member</Button>}
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Edit"}</Button>
        </div>
      </div>
      {open && (
        <form className="mt-3 grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined, { onSuccess: () => setOpen(false) }); }}>
          <Field label="Name"><Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
          <Field label="Rating 1–10"><Input type="number" min={1} max={10} value={f.skillRating} onChange={(e) => setF({ ...f, skillRating: e.target.value })} /></Field>
          <Field label="Goalkeeper">
            <Select value={f.gkPreference} onChange={(e) => setF({ ...f, gkPreference: e.target.value as "none" })}>
              <option value="none">Outfield only</option>
              <option value="can">Can play in goal</option>
              <option value="prefers">Prefers goal</option>
            </Select>
          </Field>
          <Field label="Phone"><Input value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
          <label className="flex min-h-12 items-center gap-2 self-end text-sm font-medium">
            <input type="checkbox" className="size-5 accent-pitch-700" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
          </label>
          <div className="sm:col-span-3"><Button type="submit" loading={save.isPending}>Save</Button></div>
        </form>
      )}
      <ConfirmDialog
        open={convert}
        title={`Make ${p.displayName} a member?`}
        confirmLabel="Convert"
        requireReason={retro}
        loading={doConvert.isPending}
        onClose={() => setConvert(false)}
        onConfirm={(reason) => doConvert.mutate(reason, { onSettled: () => setConvert(false) })}
      >
        <p>Their player record, goals and assists are kept. By default this applies from the next roster lock: past days stay as guest appearances.</p>
        <label className="mt-3 flex items-center gap-2 font-medium text-ink">
          <input type="checkbox" className="size-5 accent-pitch-700" checked={retro} onChange={(e) => setRetro(e.target.checked)} /> Also apply to this season's past days (audited correction)
        </label>
      </ConfirmDialog>
    </li>
  );
}

// ---------------------------------------------------------------------------

function UsersTab() {
  const { data: me } = useMe();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: { id: string; name: string; email: string; role: string; playerId: string | null; playerName: string | null }[] }>("/admin/users") });
  const players = useQuery({ queryKey: ["players"], queryFn: () => api.get<{ players: Player[] }>("/players") });
  const role = useAdminMutation((v: { id: string; role: string }) => api.post(`/admin/users/${v.id}/role`, { role: v.role }), "Role updated", [["users"]]);
  const link = useAdminMutation((v: { id: string; playerId: string }) => api.post(`/admin/users/${v.id}/link`, { playerId: v.playerId }), "Linked", [["users"], ["players"]]);
  const unlinked = (players.data?.players ?? []).filter((p) => !p.hasAccount);
  if (users.isLoading) return <Loading />;
  if (users.error) return <ErrorBox error={users.error} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Logins are created through first-time setup or player invite links — public sign-up is disabled. Only admins can grant the admin role.</p>
      <Card>
        <ul className="divide-y divide-line">
          {users.data!.users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{u.name} {u.role === "admin" && <Badge tone="dark">Admin</Badge>}</div>
                <div className="text-xs text-muted">{u.email} · {u.playerName ? `Player: ${u.playerName}` : "Not linked to a player"}</div>
              </div>
              {!u.playerId && unlinked.length > 0 && (
                <Select aria-label="Link to player" className="!min-h-9 w-auto text-sm" defaultValue="" onChange={(e) => e.target.value && link.mutate({ id: u.id, playerId: e.target.value })}>
                  <option value="">Link to player…</option>
                  {unlinked.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                </Select>
              )}
              {u.id !== me?.user?.id && (
                <Button size="sm" variant="secondary" onClick={() => role.mutate({ id: u.id, role: u.role === "admin" ? "member" : "admin" })}>
                  {u.role === "admin" ? "Remove admin" : "Make admin"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SettingsTab() {
  const { data, isLoading } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: Record<string, string> }>("/admin/settings") });
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => { if (data) setF(data.settings); }, [data]);
  const save = useAdminMutation(() => api.put("/admin/settings", f), "Settings saved", [["settings"], ["me"]]);
  if (isLoading) return <Loading />;
  const field = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <Field label={label} hint={hint}><Input {...props} value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
  );
  return (
    <Card className="max-w-2xl p-4">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        {field("group_name", "Group name")}
        {field("timezone", "Timezone", {}, "IANA name, e.g. Africa/Lagos. New seasons use this.")}
        {field("default_venue", "Default venue")}
        {field("default_capacity", "Default capacity", { type: "number", min: 2 })}
        {field("default_set_count", "Default number of sets", { type: "number", min: 2 })}
        {field("default_team_size", "Default players per set", { type: "number", min: 1 })}
        <div className="sm:col-span-2"><Button type="submit" loading={save.isPending}>Save settings</Button></div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface AuditEntry {
  id: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  matchDayId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

function AuditTab() {
  const { data: me } = useMe();
  const q = useInfiniteQuery({
    queryKey: ["audit"],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<{ entries: AuditEntry[] }>(`/admin/audit?limit=50${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.entries.length === 50 ? last.entries[49]!.createdAt : undefined),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const entries = q.data!.pages.flatMap((p) => p.entries);
  if (entries.length === 0) return <Empty title="Nothing logged yet" />;
  return (
    <div className="space-y-3">
      <Card>
        <ul className="divide-y divide-line">
          {entries.map((e) => (
            <li key={e.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={e.action.startsWith("correction") ? "amber" : "gray"}>{e.action}</Badge>
                <span className="font-semibold">{e.actorName}</span>
                <span className="text-muted">{formatInstant(e.createdAt, me?.timezone ?? "Africa/Lagos")}</span>
                {e.matchDayId && <Link to={`/matchdays/${e.matchDayId}`} className="text-pitch-700 hover:underline">match day →</Link>}
              </div>
              {e.reason && <div className="mt-1">Reason: <i>{e.reason}</i></div>}
              {(e.before != null || e.after != null) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted">Before / after</summary>
                  <div className="mt-1 grid gap-2 sm:grid-cols-2">
                    <pre className="overflow-x-auto rounded bg-stone-50 p-2 text-xs">{JSON.stringify(e.before, null, 1)}</pre>
                    <pre className="overflow-x-auto rounded bg-stone-50 p-2 text-xs">{JSON.stringify(e.after, null, 1)}</pre>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {q.hasNextPage && <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button>}
    </div>
  );
}

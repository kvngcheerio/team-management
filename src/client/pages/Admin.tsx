import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, useParams } from "react-router";
import { api } from "../api";
import { Badge, Button, Card, ConfirmDialog, cx, Empty, ErrorBox, Field, GuestBadge, Input, Loading, PageHeader, Select, useToast } from "../components/ui";
import { formatDate, formatInstant } from "../format";
import { scheduledDates } from "../../shared/rules";
import { todayInZone } from "../../shared/time";
import { useMe } from "../hooks";
import type { Player, Season } from "../types";
import { defaultSeasonEnd, formatMoney } from "../../shared/rules";
import FinanceTab from "./Finance";
import { Avatar, CardIcon } from "../components/ui";
import type { Card as FineCard } from "../types";

const TABS = [
  { key: "seasons", label: "Seasons" },
  { key: "schedule", label: "Schedule" },
  { key: "players", label: "Players" },
  { key: "members", label: "Members" },
  { key: "fines", label: "Fines" },
  { key: "finance", label: "Finance" },
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
      {tab === "schedule" && <ScheduleTab />}
      {tab === "players" && <PlayersTab />}
      {tab === "members" && <MembersTab />}
      {tab === "fines" && <FinesTab />}
      {tab === "finance" && <FinanceTab />}
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
        <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">New season</h2>
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
          <span className="text-xl font-medium tracking-[-0.02em]">{s.name}</span>
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
  const list = (data?.players ?? []).filter((p) => p.approved && (showInactive || p.active));
  const pending = (data?.players ?? []).filter((p) => !p.approved);
  return (
    <div className="space-y-6">
      {pending.length > 0 && <PendingApprovals pending={pending} candidates={(data?.players ?? []).filter((p) => p.approved && !p.hasAccount)} />}
      <Card className="p-4">
        <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Add player</h2>
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
        <Avatar name={p.displayName} url={p.avatarUrl} size={32} />
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
      <SignupLinkCard />
      <AdminInvitesCard />
      <p className="text-sm text-muted">Logins come from the shared signup link (admin approval required), personal player invites, or admin invites. Only admins can grant the admin role.</p>
      <Card>
        <ul className="divide-y divide-line">
          {users.data!.users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{u.name} {u.role === "admin" && <Badge tone="dark">Admin</Badge>}</div>
                <div className="text-xs text-muted">{u.email} · {u.playerName ? `Player: ${u.playerName}` : "Not linked to a player"}</div>
              </div>
              {!u.playerId && unlinked.length > 0 && (
                <Select aria-label="Link to player" className="!min-h-9 !w-auto text-sm" defaultValue="" onChange={(e) => e.target.value && link.mutate({ id: u.id, playerId: e.target.value })}>
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
  const { data, isLoading } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: Record<string, string>; signupUrl: string | null }>("/admin/settings") });
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => { if (data) setF(data.settings); }, [data]);
  const save = useAdminMutation(() => {
    const { signup_enabled: _ignored, ...rest } = f;
    return api.put("/admin/settings", rest);
  }, "Settings saved", [["settings"], ["me"]]);
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
        {field("team_sheet_time", "Team sheet visible from", { type: "time" }, "Players see teams from this time on match day (local time).")}
        {field("fine_yellow", "Yellow card fine (₦)", { type: "number", min: 0 })}
        {field("fine_red", "Red card fine (₦)", { type: "number", min: 0 })}
        {field("membership_fee", "Membership fee (₦)", { type: "number", min: 0 }, "Charged per renewal period.")}
        {field("membership_months", "Renewal period (months)", { type: "number", min: 1 })}
        {field("guest_fee", "Guest fee per match day (₦)", { type: "number", min: 0 })}
        {field("guest_free_after", "Guests play free after this many paid days (per season)", { type: "number", min: 0 })}
        {field("referral_credit", "Invite reward (₦ wallet credit)", { type: "number", min: 0 }, "Paid to the inviter when their invitee first pays.")}
        <Field label="How players pay" hint="Bank transfer: players transfer and you confirm under Finance. Test: a simulator for trying things out.">
          <Select value={f.payment_mode ?? "transfer"} onChange={(e) => setF({ ...f, payment_mode: e.target.value })}>
            <option value="transfer">Bank transfer (admin confirms)</option>
            <option value="test">Test mode (simulated)</option>
          </Select>
        </Field>
        {field("bank_name", "Bank")}
        {field("bank_account_number", "Account number", { inputMode: "numeric" })}
        {field("bank_account_name", "Account name")}
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

// ---------------------------------------------------------------------------

async function copy(text: string, toast: (m: string, t?: "success" | "error") => void, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    toast(text);
  }
}

function SignupLinkCard() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: Record<string, string>; signupUrl: string | null }>("/admin/settings") });
  const rotate = useAdminMutation(() => api.post("/admin/signup-link/rotate", {}), "New link created — the old one no longer works", [["settings"]]);
  const toggle = useAdminMutation((on: boolean) => api.put("/admin/settings", { signup_enabled: on ? "1" : "0" }), "Updated", [["settings"]]);
  const enabled = data?.settings.signup_enabled === "1";
  const [confirmRotate, setConfirmRotate] = useState(false);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Signup link</h2>
        <Badge tone={enabled ? "green" : "gray"}>{enabled ? "Active" : "Off"}</Badge>
      </div>
      <p className="text-sm text-muted">Share this in your group chat. New players create their own login; you approve them under Players before they can mark availability.</p>
      {data?.signupUrl && (
        <div className="flex flex-wrap gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-100 px-3 py-2.5 text-sm">{data.signupUrl}</code>
          <Button onClick={() => copy(data.signupUrl!, toast, "Signup link")} disabled={!enabled}>Copy link</Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => toggle.mutate(!enabled)}>{enabled ? "Turn off signups" : "Turn on signups"}</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmRotate(true)}>Reset link</Button>
      </div>
      <ConfirmDialog open={confirmRotate} title="Reset the signup link?" confirmLabel="Reset" onClose={() => setConfirmRotate(false)} onConfirm={() => rotate.mutate(undefined, { onSettled: () => setConfirmRotate(false) })}>
        The current link stops working immediately. Use this if it was shared somewhere it shouldn't be.
      </ConfirmDialog>
    </Card>
  );
}

function AdminInvitesCard() {
  const toast = useToast();
  const [note, setNote] = useState("");
  const list = useQuery({ queryKey: ["admin-invites"], queryFn: () => api.get<{ invites: { id: string; note: string | null; expiresAt: string; usedAt: string | null; usedByEmail: string | null; createdAt: string }[] }>("/admin/admin-invites") });
  const create = useMutation({
    mutationFn: () => api.post<{ url: string; expiresAt: string }>("/admin/admin-invites", { note: note || undefined }),
    onSuccess: async (r) => {
      setNote("");
      list.refetch();
      await copy(r.url, toast, "Admin invite link (valid 7 days, single use)");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const revoke = useAdminMutation((id: string) => api.req("DELETE", `/admin/admin-invites/${id}`), "Invite revoked", [["admin-invites"]]);
  const { data: me } = useMe();
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Invite an admin</h2>
      <p className="text-sm text-muted">Creates a single-use link (valid 7 days) that makes a new account with full admin rights. Send it privately. To promote someone who already has a login, use “Make admin” below.</p>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Input className="min-w-0 flex-1" placeholder="Note, e.g. who it's for (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={100} />
        <Button type="submit" loading={create.isPending}>Create & copy link</Button>
      </form>
      {(list.data?.invites ?? []).length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {list.data!.invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="flex-1">{i.note || "Admin invite"} <span className="text-muted">· {formatInstant(i.createdAt, me?.timezone ?? "Africa/Lagos", { day: "numeric", month: "short" })}</span></span>
              {i.usedAt ? <Badge tone="green">Used by {i.usedByEmail}</Badge> : Date.parse(i.expiresAt) < Date.now() ? <Badge>Expired</Badge> : (
                <>
                  <Badge tone="amber">Waiting</Badge>
                  <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PendingApprovals({ pending, candidates }: { pending: Player[]; candidates: Player[] }) {
  const approve = useAdminMutation((v: { id: string; mergeIntoPlayerId?: string }) => api.post(`/players/${v.id}/approve`, { mergeIntoPlayerId: v.mergeIntoPlayerId }), "Approved", [["players"], ["dashboard"]]);
  const reject = useAdminMutation((id: string) => api.post(`/players/${id}/reject`, {}), "Signup rejected and removed", [["players"], ["dashboard"]]);
  const [merge, setMerge] = useState<Record<string, string>>({});
  return (
    <Card className="border-amber-200 bg-amber-50/50 p-4">
      <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em] text-amber-900">Waiting for approval ({pending.length})</h2>
      <p className="mb-2 text-sm text-amber-900">Signed up through the shared link. If they're already in your player list (added manually), merge them so their history stays together.</p>
      <ul className="divide-y divide-amber-200">
        {pending.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 py-3">
            <Avatar name={p.displayName} url={p.avatarUrl} size={36} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{p.displayName}</div>
              <div className="text-xs text-muted">{[p.accountEmail, p.contactPhone].filter(Boolean).join(" · ")}</div>
            </div>
            {candidates.length > 0 && (
              <Select aria-label="Merge into existing player" className="!min-h-9 !w-auto text-sm" value={merge[p.id] ?? ""} onChange={(e) => setMerge({ ...merge, [p.id]: e.target.value })}>
                <option value="">New player</option>
                {candidates.map((c) => <option key={c.id} value={c.id}>Same as: {c.displayName}</option>)}
              </Select>
            )}
            <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate({ id: p.id, mergeIntoPlayerId: merge[p.id] || undefined })}>Approve</Button>
            <Button size="sm" variant="danger" onClick={() => reject.mutate(p.id)}>Reject</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface FinesSummary {
  currency: string;
  fines: { yellow: number; red: number };
  totals: { owed: number; paid: number; waived: number };
  perPlayer: { playerId: string; displayName: string; yellow: number; red: number; owed: number; paid: number; waived: number }[];
  cards: FineCard[];
}

function FinesTab() {
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-fines"], queryFn: () => api.get<FinesSummary>("/admin/fines") });
  const [action, setAction] = useState<null | { id: string; kind: "void" | "waive" }>(null);
  const act = useAdminMutation((v: { id: string; kind: string; reason?: string }) => api.post(`/cards/${v.id}/${v.kind}`, { reason: v.reason }), "Updated", [["admin-fines"], ["finance"], ["stats"]]);
  const [filter, setFilter] = useState<"unpaid" | "all">("unpaid");
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data!;
  const money = (n: number) => formatMoney(n, d.currency);
  const cards = d.cards.filter((k) => filter === "all" || (k.fineStatus === "unpaid" && !k.voided));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-2">
        {[["Owed", d.totals.owed, "text-red-700"], ["Collected", d.totals.paid, "text-pitch-800"], ["Waived", d.totals.waived, "text-muted"]].map(([l, v, tone]) => (
          <Card key={l as string} className="px-4 py-3">
            <div className="text-sm text-muted">{l}</div>
            <div className={cx("num stat text-2xl", tone as string)}>{money(v as number)}</div>
          </Card>
        ))}
      </div>
      <p className="text-sm text-muted">Yellow {money(d.fines.yellow)} · Red {money(d.fines.red)} — change in Settings. Cards are given from the live results screen.</p>
      {d.perPlayer.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="num w-full text-sm">
            <thead className="text-xs text-muted">
              <tr className="border-b border-line"><th className="px-4 py-2 text-left">Player</th><th>YC</th><th>RC</th><th className="text-right">Owed</th><th className="px-4 text-right">Paid</th></tr>
            </thead>
            <tbody>
              {d.perPlayer.map((r) => (
                <tr key={r.playerId} className="border-b border-line text-center last:border-0">
                  <td className="px-4 py-2.5 text-left"><Link to={`/players/${r.playerId}`} className="hover:underline">{r.displayName}</Link></td>
                  <td>{r.yellow}</td><td>{r.red}</td>
                  <td className={cx("text-right", r.owed > 0 && "font-semibold text-red-700")}>{money(r.owed)}</td>
                  <td className="px-4 text-right">{money(r.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <div className="flex gap-1">
        {(["unpaid", "all"] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)} className={cx("min-h-10 rounded-full px-4 text-sm font-semibold", filter === k ? "bg-pitch-800 text-white" : "bg-white ring-1 ring-line")}>{k === "unpaid" ? "Unpaid" : "All cards"}</button>
        ))}
      </div>
      {cards.length === 0 ? <Empty title={filter === "unpaid" ? "No unpaid fines" : "No cards yet"} /> : (
        <Card>
          <ul className="divide-y divide-line">
            {cards.map((k) => (
              <li key={k.id} className={cx("flex flex-wrap items-center gap-2 px-4 py-3 text-sm", k.voided && "opacity-50")}>
                <CardIcon color={k.color} />
                <span className="min-w-0 flex-1">
                  <Link to={`/players/${k.playerId}`} className="font-medium hover:underline">{k.displayName}</Link>
                  <span className="text-muted"> · {k.date} {k.reason && `· ${k.reason}`}</span>
                  {k.voided && <span className="block text-xs text-muted">Voided: {k.voidReason}</span>}
                </span>
                <span className="num font-semibold">{money(k.fineAmount)}</span>
                {!k.voided && <Badge tone={k.fineStatus === "paid" ? "green" : k.fineStatus === "waived" ? "gray" : "red"}>{k.fineStatus === "paid" ? `Paid (${k.paidVia})` : k.fineStatus}</Badge>}
                {!k.voided && k.fineStatus === "unpaid" && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: k.id, kind: "mark-paid" })}>Paid cash</Button>
                    <Button size="sm" variant="ghost" onClick={() => setAction({ id: k.id, kind: "waive" })}>Waive</Button>
                  </>
                )}
                {!k.voided && k.fineStatus === "waived" && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: k.id, kind: "reopen" })}>Reopen</Button>}
                {!k.voided && !(k.fineStatus === "paid" && k.paidVia === "online") && <Button size="sm" variant="ghost" onClick={() => setAction({ id: k.id, kind: "void" })}>Void card</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ConfirmDialog open={!!action} title={action?.kind === "void" ? "Void this card?" : "Waive this fine?"} requireReason confirmLabel={action?.kind === "void" ? "Void card" : "Waive fine"} tone="danger"
        onClose={() => setAction(null)} onConfirm={(reason) => act.mutate({ id: action!.id, kind: action!.kind, reason }, { onSettled: () => setAction(null) })}>
        {action?.kind === "void" ? "The card is removed from stats and the fine is cancelled." : "The card stays on the record but nothing is owed."}
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface MembersResponse {
  settings: { membershipFee: number; membershipMonths: number; currency: string };
  players: { playerId: string; displayName: string; kind: "member" | "guest"; paidUntil: string | null; status: string; wallet: number; referredBy: string | null; hasAccount: boolean }[];
}

function MembersTab() {
  const { data, isLoading, error } = useQuery({ queryKey: ["memberships"], queryFn: () => api.get<MembersResponse>("/admin/memberships") });
  const [markPaid, setMarkPaid] = useState<{ id: string; name: string } | null>(null);
  const [adjust, setAdjust] = useState<{ id: string; name: string } | null>(null);
  const [adj, setAdj] = useState({ amount: "", note: "" });
  const [filter, setFilter] = useState<"all" | "due" | "guests">("all");
  const pay = useAdminMutation((id: string) => api.post(`/players/${id}/membership/mark-paid`, {}), "Membership recorded (cash)", [["memberships"], ["players"], ["finance"]]);
  const wallet = useAdminMutation((v: { id: string; amount: number; note: string }) => api.post(`/players/${v.id}/wallet/adjust`, { amount: v.amount, note: v.note }), "Wallet updated", [["memberships"]]);
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data!;
  const money = (n: number) => formatMoney(n, d.settings.currency);
  const rows = d.players.filter((p) => filter === "all" || (filter === "guests" ? p.kind === "guest" : p.status === "due_soon" || p.status === "overdue"));
  const counts = { members: d.players.filter((p) => p.kind === "member").length, guests: d.players.filter((p) => p.kind === "guest").length, due: d.players.filter((p) => p.status === "due_soon" || p.status === "overdue").length };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Membership is {money(d.settings.membershipFee)} every {d.settings.membershipMonths} months. Paying online (or you recording a cash payment here) makes a guest a member. Membership never lapses; overdue members just see a renewal reminder.
      </p>
      <div className="flex flex-wrap gap-1">
        {([["all", `Everyone (${d.players.length})`], ["due", `Renewal due (${counts.due})`], ["guests", `Guests (${counts.guests})`]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} className={cx("min-h-10 rounded-full px-4 text-sm font-semibold", filter === k ? "bg-pitch-800 text-white" : "bg-white ring-1 ring-line")}>{l}</button>
        ))}
      </div>
      <Card>
        <ul className="divide-y divide-line">
          {rows.map((p) => (
            <li key={p.playerId} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <Link to={`/players/${p.playerId}`} className="font-semibold hover:underline">{p.displayName}</Link>
                <div className="text-xs text-muted">
                  {p.kind === "member" ? (p.paidUntil ? `Paid until ${p.paidUntil}` : "No membership payment recorded") : "Guest"}
                  {p.referredBy && ` · invited by ${p.referredBy}`}
                  {p.wallet !== 0 && ` · wallet ${money(p.wallet)}`}
                </div>
              </div>
              <Badge tone={p.kind === "guest" ? "amber" : p.status === "overdue" ? "red" : p.status === "due_soon" ? "amber" : "green"}>
                {p.kind === "guest" ? "Guest" : p.status === "overdue" ? "Renewal due" : p.status === "due_soon" ? "Due soon" : "Member"}
              </Badge>
              <Button size="sm" variant="secondary" onClick={() => setMarkPaid({ id: p.playerId, name: p.displayName })}>{p.kind === "member" ? "Record renewal" : "Mark membership paid"}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setAdj({ amount: "", note: "" }); setAdjust({ id: p.playerId, name: p.displayName }); }}>Wallet</Button>
            </li>
          ))}
        </ul>
      </Card>
      <ConfirmDialog open={!!markPaid} title={`Record ${money(d.settings.membershipFee)} cash for ${markPaid?.name}?`} confirmLabel="Record payment" loading={pay.isPending}
        onClose={() => setMarkPaid(null)} onConfirm={() => pay.mutate(markPaid!.id, { onSettled: () => setMarkPaid(null) })}>
        They become (or stay) a member and their paid-until date moves forward {d.settings.membershipMonths} months. It shows in Finance as cash income.
      </ConfirmDialog>
      {adjust && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="Adjust wallet">
          <Card className="w-full max-w-md space-y-3 p-5">
            <h3 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Wallet · {adjust.name}</h3>
            <Field label="Amount (₦)" hint="Positive to add credit, negative to deduct."><Input type="number" step={1} value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></Field>
            <Field label="Note"><Input value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder="e.g. Goodwill credit" /></Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAdjust(null)}>Cancel</Button>
              <Button loading={wallet.isPending} disabled={!Number(adj.amount) || adj.note.trim().length < 3}
                onClick={() => wallet.mutate({ id: adjust.id, amount: Number(adj.amount), note: adj.note }, { onSuccess: () => setAdjust(null) })}>Save</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const WEEKDAYS = [
  { n: 1, short: "Mon" },
  { n: 2, short: "Tue" },
  { n: 3, short: "Wed" },
  { n: 4, short: "Thu" },
  { n: 5, short: "Fri" },
  { n: 6, short: "Sat" },
  { n: 7, short: "Sun" },
];

/** The check-in reminder exactly as players receive it (addressed to you, for the next match day). */
function EmailPreview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["email-preview"],
    queryFn: () => api.get<{ to: string; subject: string; html: string; text: string; matchDayDate: string | null; emailFrom: string | null }>("/admin/email-preview"),
    enabled: open,
    staleTime: 0,
  });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="Email preview" onClick={onClose}>
      <Card className="flex max-h-[90vh] w-full max-w-xl flex-col gap-3 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">Check-in reminder</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} />
        ) : data ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">From</dt><dd className="break-all">{data.emailFrom ?? "— (EMAIL_FROM not set)"}</dd>
              <dt className="text-muted">To</dt><dd className="break-all">{data.to}</dd>
              <dt className="text-muted">Subject</dt><dd className="font-medium">{data.subject}</dd>
            </dl>
            <iframe title="Email body" sandbox="" srcDoc={data.html} className="min-h-[320px] w-full flex-1 rounded-xl border border-line bg-white" />
            <p className="text-xs text-muted">
              {data.matchDayDate ? `Shown for the next match day (${formatDate(data.matchDayDate)}).` : "No upcoming match day, so this uses sample details."} Sent on match day, 2 hours before kick-off, to players who haven't checked in or said they're unavailable.
            </p>
          </>
        ) : null}
      </Card>
    </div>
  );
}

function ScheduleTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: Record<string, string>; emailConfigured: boolean }>("/admin/settings") });
  const [f, setF] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (data && !f) setF(data.settings);
  }, [data, f]);
  const save = useMutation({
    mutationFn: () =>
      api.put("/admin/settings", {
        checkin_reminders_enabled: f!.checkin_reminders_enabled ?? "1",
        match_weekdays: f!.match_weekdays ?? "",
        schedule_kickoff: f!.schedule_kickoff,
        schedule_open_days_before: f!.schedule_open_days_before,
        schedule_close_hours_before: f!.schedule_close_hours_before,
        schedule_weeks_ahead: f!.schedule_weeks_ahead,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast("Schedule saved");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const testSend = useMutation({
    mutationFn: () => api.post<{ to: string; provider: string; simulated: boolean }>("/admin/email-test", {}),
    onSuccess: (r) =>
      toast(r.simulated ? "Local dev: Cloudflare email is simulated, nothing was delivered. Add RESEND_API_KEY to .dev.vars to really send." : `Test email sent to ${r.to} via ${r.provider === "resend" ? "Resend" : "Cloudflare"}`),
    onError: (e: Error) => toast(e.message, "error"),
  });
  const run = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return api.post<{ created: string[]; opened: string[] }>("/admin/schedule/run", {});
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["matchdays"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast(r.created.length || r.opened.length ? `Created ${r.created.length}, opened check-in on ${r.opened.length}` : "Everything is already up to date");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  if (isLoading || !f) return <Loading />;
  const selected = new Set((f.match_weekdays ?? "").split(",").filter(Boolean).map(Number));
  const toggle = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setF({ ...f, match_weekdays: [...next].sort().join(",") });
  };
  const tz = f.timezone ?? "Africa/Lagos";
  const today = todayInZone(tz);
  const preview = scheduledDates(today, Number(f.schedule_weeks_ahead ?? 2) * 7, [...selected]);
  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <Card className="space-y-6 p-5 sm:p-6">
        <div>
          <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Match days</h2>
          <p className="text-sm text-muted">Pick the days you play. Match days are created automatically each morning and check-in opens on its own.</p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Match weekdays">
          {WEEKDAYS.map((w) => (
            <button
              key={w.n}
              type="button"
              aria-pressed={selected.has(w.n)}
              onClick={() => toggle(w.n)}
              className={cx("min-h-12 min-w-16 rounded-full border px-4 text-[15px] transition", selected.has(w.n) ? "border-pitch-700 bg-pitch-700 text-white" : "border-line bg-white text-ink hover:border-pitch-700/50")}
            >
              {w.short}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kick-off"><Input type="time" value={f.schedule_kickoff ?? "07:00"} onChange={(e) => setF({ ...f, schedule_kickoff: e.target.value })} /></Field>
          <Field label="Create match days this many weeks ahead"><Input type="number" min={1} max={8} value={f.schedule_weeks_ahead ?? "2"} onChange={(e) => setF({ ...f, schedule_weeks_ahead: e.target.value })} /></Field>
          <Field label="Check-in opens (days before)"><Input type="number" min={0} max={14} value={f.schedule_open_days_before ?? "3"} onChange={(e) => setF({ ...f, schedule_open_days_before: e.target.value })} /></Field>
          <Field label="Check-in deadline (hours before kick-off)" hint="Players can still check in after it (marked late) until you close check-in."><Input type="number" min={0} max={72} value={f.schedule_close_hours_before ?? "11"} onChange={(e) => setF({ ...f, schedule_close_hours_before: e.target.value })} /></Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-5 accent-pitch-700"
            checked={(f.checkin_reminders_enabled ?? "1") === "1"}
            onChange={(e) => setF({ ...f, checkin_reminders_enabled: e.target.checked ? "1" : "0" })}
          />
          <span>
            Email check-in reminders
            <span className="block text-muted">On match day, 2 hours before kick-off, players who haven't checked in or said they're unavailable get an email. Players can turn it off on their profile.</span>
            {data && !data.emailConfigured && <span className="block text-ember">Email isn't configured on the server yet (EMAIL_FROM plus the EMAIL binding or RESEND_API_KEY).</span>}
          </span>
        </label>
        <div className="-mt-3 flex flex-wrap gap-2 pl-7">
          <Button size="sm" variant="secondary" onClick={() => setPreviewOpen(true)}>Preview email</Button>
          <Button size="sm" variant="ghost" loading={testSend.isPending} onClick={() => testSend.mutate()}>Send me a test</Button>
        </div>
        <EmailPreview open={previewOpen} onClose={() => setPreviewOpen(false)} />
        <p className="text-sm text-muted">
          Venue, capacity, sets and players per set come from <Link to="/admin/settings" className="underline">Settings</Link>. Team sheets show at {f.team_sheet_time ?? "07:50"} on match day. Each day can still be edited or cancelled on its own.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button loading={save.isPending && !run.isPending} onClick={() => save.mutate()}>Save schedule</Button>
          <Button variant="secondary" loading={run.isPending} disabled={selected.size === 0} onClick={() => run.mutate()}>Save & create upcoming days now</Button>
        </div>
      </Card>
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-[22px] border border-line bg-chalk p-5">
          <span className="watermark" aria-hidden>Next</span>
          <div className="relative text-[15px]">Coming up</div>
          {preview.length === 0 ? (
            <p className="relative mt-6 text-sm text-muted">No weekdays selected — match days are only created by hand.</p>
          ) : (
            <ul className="relative mt-4 space-y-3">
              {preview.map((d) => (
                <li key={d} className="flex items-baseline gap-3">
                  <span className="stat w-12 text-[34px]">{formatDate(d, { day: "numeric" })}</span>
                  <span className="text-[15px]">{formatDate(d, { weekday: "long" })}, {formatDate(d, { month: "long" })}</span>
                  <span className="ml-auto text-sm text-muted">{f.schedule_kickoff ?? "07:00"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="px-1 text-xs text-muted">Dates outside an active season are skipped. Cancelled dates are never recreated. The daily job runs at 06:00 WAT.</p>
      </div>
    </div>
  );
}

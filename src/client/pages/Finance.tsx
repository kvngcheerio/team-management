import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Badge, Button, Card, CardIcon, ConfirmDialog, cx, Empty, ErrorBox, Field, Input, Loading, Select, useToast } from "../components/ui";
import { formatDate, formatInstant } from "../format";
import { formatMoney } from "../../shared/rules";
import { todayInZone } from "../../shared/time";

interface Finance {
  currency: string;
  timezone: string;
  totals: { fineIncome: number; guestFeeIncome: number; membershipIncome: number; otherIncome: number; income: number; expenses: number; balance: number; outstandingFines: number; walletRedeemed: number };
  guestFees: { id: string; paidAt: string; playerId: string; displayName: string; matchDate: string; amount: number; method: "online" | "cash"; reference: string | null }[];
  memberships: { id: string; paidAt: string; playerId: string; displayName: string; amount: number; walletAmount: number; method: "online" | "cash" | "wallet"; period: { start: string; end: string }; reference: string | null }[];
  expensesByCategory: { category: string; amount: number }[];
  payments: { cardId: string; paidAt: string; playerId: string; displayName: string; color: "yellow" | "red"; amount: number; method: "online" | "cash" | "wallet"; reference: string | null }[];
  entries: { id: string; kind: "expense" | "income"; date: string; category: string; description: string; amount: number; createdByName: string; voided: boolean; voidReason: string | null }[];
  categories: { expense: string[]; income: string[] };
}

export default function FinanceTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [range, setRange] = useState({ from: "", to: "" });
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const { data, isLoading, error } = useQuery({ queryKey: ["finance", qs], queryFn: () => api.get<Finance>(`/admin/finance${qs ? `?${qs}` : ""}`) });
  const [f, setF] = useState({ kind: "expense" as "expense" | "income", date: "", category: "", description: "", amount: "" });
  const [voiding, setVoiding] = useState<string | null>(null);
  const [view, setView] = useState<"all" | "payments" | "expense" | "income">("all");

  const add = useMutation({
    mutationFn: () => api.post("/admin/finance/entries", { ...f, date: f.date || todayInZone(data?.timezone ?? "Africa/Lagos"), category: f.category || (f.kind === "expense" ? data!.categories.expense[0] : data!.categories.income[0]), amount: Number(f.amount) }),
    onSuccess: () => {
      setF({ ...f, description: "", amount: "" });
      qc.invalidateQueries({ queryKey: ["finance"] });
      toast(f.kind === "expense" ? "Expenditure recorded" : "Income recorded");
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
  const voidEntry = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.post(`/admin/finance/entries/${v.id}/void`, { reason: v.reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["finance"] }),
    onError: (e: Error) => toast(e.message, "error"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data!;
  const money = (n: number) => formatMoney(n, d.currency);

  // Unified, newest-first ledger.
  const rows = [
    ...d.payments.map((p) => ({ key: `p-${p.cardId}`, date: p.paidAt.slice(0, 10), sort: p.paidAt, type: "payment" as const, p })),
    ...d.guestFees.map((g) => ({ key: `g-${g.id}`, date: g.paidAt.slice(0, 10), sort: g.paidAt, type: "guest" as const, g })),
    ...d.memberships.map((m) => ({ key: `m-${m.id}`, date: m.paidAt.slice(0, 10), sort: m.paidAt, type: "membership" as const, m })),
    ...d.entries.map((e) => ({ key: `e-${e.id}`, date: e.date, sort: `${e.date}T99`, type: e.kind, e })),
  ]
    .filter((r) => view === "all" || (view === "payments" ? ["payment", "guest", "membership"].includes(r.type) : r.type === view))
    .sort((a, b) => b.sort.localeCompare(a.sort));

  return (
    <div className="space-y-6">
      <TransfersQueue />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Balance" value={money(d.totals.balance)} tone={d.totals.balance < 0 ? "text-red-700" : "text-pitch-800"} big />
        <Stat label="Money in" value={money(d.totals.income)} hint={`Membership ${money(d.totals.membershipIncome)} · Guest fees ${money(d.totals.guestFeeIncome)} · Fines ${money(d.totals.fineIncome)} · Other ${money(d.totals.otherIncome)}`} />
        <Stat label="Money out" value={money(d.totals.expenses)} tone="text-red-700" />
        <Stat label="Fines still owed" value={money(d.totals.outstandingFines)} hint={<>{d.totals.walletRedeemed > 0 && `${money(d.totals.walletRedeemed)} paid with wallet credit · `}<Link to="/admin/fines" className="underline">Manage fines</Link></>} />
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        {(range.from || range.to) && <Button variant="ghost" onClick={() => setRange({ from: "", to: "" })}>All time</Button>}
      </Card>

      <Card className="p-4">
        <h2 className="text-[26px] font-medium leading-tight tracking-[-0.025em]">Record money in or out</h2>
        <form className="mt-3 grid gap-3 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <div className="sm:col-span-2">
            <Field label="Type">
              <div className="grid grid-cols-2 overflow-hidden rounded-xl ring-1 ring-line">
                {(["expense", "income"] as const).map((k) => (
                  <button type="button" key={k} onClick={() => setF({ ...f, kind: k, category: "" })} aria-pressed={f.kind === k}
                    className={cx("min-h-12 text-sm font-semibold", f.kind === k ? (k === "expense" ? "bg-red-600 text-white" : "bg-pitch-700 text-white") : "bg-white text-muted")}>
                    {k === "expense" ? "Expenditure" : "Income"}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Category">
              <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                {(f.kind === "expense" ? d.categories.expense : d.categories.income).map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </Select>
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Date"><Input type="date" value={f.date || todayInZone(d.timezone)} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          </div>
          <div className="sm:col-span-4">
            <Field label="Description"><Input required maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={f.kind === "expense" ? "e.g. Pitch hire, 2 hours" : "e.g. Weekly dues"} /></Field>
          </div>
          <div className="sm:col-span-2">
            <Field label={`Amount (${d.currency})`}><Input required type="number" inputMode="numeric" min={1} step={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          </div>
          <div className="sm:col-span-6"><Button type="submit" variant={f.kind === "expense" ? "danger" : "primary"} loading={add.isPending}>Save {f.kind === "expense" ? "expenditure" : "income"}</Button></div>
        </form>
      </Card>

      {d.expensesByCategory.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-3 font-semibold">Spending by category</h3>
          <ul className="space-y-2">
            {d.expensesByCategory.map((c) => (
              <li key={c.category} className="text-sm">
                <div className="flex justify-between"><span>{c.category}</span><span className="num font-semibold">{money(c.amount)}</span></div>
                <div className="mt-1 h-2 rounded-full bg-stone-100">
                  <div className="h-2 rounded-full bg-red-500" style={{ width: `${Math.max(3, (c.amount / d.totals.expenses) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section>
        <div className="mb-3 flex flex-wrap gap-1">
          {([["all", "Everything"], ["payments", "Payments received"], ["expense", "Expenditures"], ["income", "Other income"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} className={cx("min-h-10 rounded-full px-4 text-sm font-semibold", view === k ? "bg-pitch-800 text-white" : "bg-white ring-1 ring-line")}>{l}</button>
          ))}
        </div>
        {rows.length === 0 ? <Empty title="Nothing recorded">Payments and expenditures will appear here.</Empty> : (
          <Card>
            <ul className="divide-y divide-line">
              {rows.map((r) => r.type === "guest" ? (
                <li key={r.key} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="w-20 text-muted">{formatDate(r.date, { day: "numeric", month: "short" })}</span>
                  <Badge tone="amber">Guest fee</Badge>
                  <span className="min-w-0 flex-1">
                    <Link to={`/players/${r.g.playerId}`} className="font-medium hover:underline">{r.g.displayName}</Link> · match day {formatDate(r.g.matchDate, { day: "numeric", month: "short" })}
                    <span className="block text-xs text-muted">{r.g.method === "online" ? `Online · ${r.g.reference ?? ""}` : "Cash"}</span>
                  </span>
                  <span className="num font-semibold text-pitch-800">+{money(r.g.amount)}</span>
                </li>
              ) : r.type === "membership" ? (
                <li key={r.key} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="w-20 text-muted">{formatDate(r.date, { day: "numeric", month: "short" })}</span>
                  <Badge tone="green">Membership</Badge>
                  <span className="min-w-0 flex-1">
                    <Link to={`/players/${r.m.playerId}`} className="font-medium hover:underline">{r.m.displayName}</Link> · {formatDate(r.m.period.start, { day: "numeric", month: "short" })} → {formatDate(r.m.period.end, { day: "numeric", month: "short", year: "numeric" })}
                    <span className="block text-xs text-muted">{r.m.method === "online" ? `Online · ${r.m.reference ?? ""}` : r.m.method === "cash" ? "Cash (recorded by admin)" : "Wallet"}{r.m.walletAmount > 0 && ` · ${money(r.m.walletAmount)} from wallet`}</span>
                  </span>
                  <span className="num font-semibold text-pitch-800">+{money(r.m.amount - r.m.walletAmount)}</span>
                </li>
              ) : r.type === "payment" ? (
                <li key={r.key} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="w-20 text-muted">{formatDate(r.date, { day: "numeric", month: "short" })}</span>
                  <CardIcon color={r.p.color} />
                  <span className="min-w-0 flex-1">
                    <Link to={`/players/${r.p.playerId}`} className="font-medium hover:underline">{r.p.displayName}</Link> paid a {r.p.color} card fine
                    <span className="block text-xs text-muted">{r.p.method === "online" ? `Online · ${r.p.reference ?? ""}` : r.p.method === "wallet" ? "Wallet credit (no cash)" : "Cash (marked by admin)"} · {formatInstant(r.p.paidAt, d.timezone, { hour: "2-digit", minute: "2-digit" })}</span>
                  </span>
                  <span className="num font-semibold text-pitch-800">+{money(r.p.amount)}</span>
                </li>
              ) : (
                <li key={r.key} className={cx("flex flex-wrap items-center gap-3 px-4 py-3 text-sm", r.e.voided && "opacity-50")}>
                  <span className="w-20 text-muted">{formatDate(r.date, { day: "numeric", month: "short" })}</span>
                  <Badge tone={r.e.kind === "expense" ? "red" : "green"}>{r.e.category}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className={cx("font-medium", r.e.voided && "line-through")}>{r.e.description}</span>
                    <span className="block text-xs text-muted">by {r.e.createdByName}{r.e.voided && ` · voided: ${r.e.voidReason}`}</span>
                  </span>
                  <span className={cx("num font-semibold", r.e.kind === "expense" ? "text-red-700" : "text-pitch-800")}>{r.e.kind === "expense" ? "−" : "+"}{money(r.e.amount)}</span>
                  {!r.e.voided && <button className="text-xs font-semibold text-muted hover:text-red-700" onClick={() => setVoiding(r.e.id)}>Void</button>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <ConfirmDialog open={!!voiding} title="Void this entry?" requireReason tone="danger" confirmLabel="Void" loading={voidEntry.isPending}
        onClose={() => setVoiding(null)} onConfirm={(reason) => voidEntry.mutate({ id: voiding!, reason }, { onSettled: () => setVoiding(null) })}>
        The entry stays on record (crossed out) and no longer counts towards totals.
      </ConfirmDialog>
    </div>
  );
}

function Stat({ label, value, hint, tone = "text-ink", big }: { label: string; value: string; hint?: React.ReactNode; tone?: string; big?: boolean }) {
  return (
    <Card className={cx("px-4 py-3", big && "bg-pitch-50")}>
      <div className="text-sm text-muted">{label}</div>
      <div className={cx("num display font-bold", big ? "text-3xl" : "text-2xl", tone)}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

interface QueuedPayment {
  id: string;
  playerId: string;
  displayName: string;
  purpose: "fines" | "membership" | "guest_fee";
  amount: number;
  walletAmount: number;
  currency: string;
  reference: string;
  submittedAt: string | null;
  matchDay: { date: string } | null;
  membership: { periodStart: string; periodEnd: string } | null;
}

/** Bank transfers players say they've sent. Check the bank app for the reference, then confirm. */
function TransfersQueue() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ["admin-payments"], queryFn: () => api.get<{ payments: QueuedPayment[] }>("/admin/payments?status=submitted") });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const done = (msg: string) => () => {
    for (const k of ["admin-payments", "finance", "dashboard", "admin-fines", "memberships"]) qc.invalidateQueries({ queryKey: [k] });
    toast(msg);
  };
  const confirm = useMutation({ mutationFn: (id: string) => api.post(`/admin/payments/${id}/confirm`, {}), onSuccess: done("Payment confirmed"), onError: (e: Error) => toast(e.message, "error") });
  const reject = useMutation({ mutationFn: (v: { id: string; reason: string }) => api.post(`/admin/payments/${v.id}/reject`, { reason: v.reason }), onSuccess: done("Payment rejected"), onError: (e: Error) => toast(e.message, "error") });
  const list = data?.payments ?? [];
  if (list.length === 0) return null;
  const what = (p: QueuedPayment) => (p.purpose === "membership" ? "Membership" : p.purpose === "guest_fee" ? `Guest fee${p.matchDay ? ` · ${formatDate(p.matchDay.date, { day: "numeric", month: "short" })}` : ""}` : "Card fines");
  return (
    <Card className="border-amber-200 p-4">
      <h2 className="text-2xl font-medium tracking-tight">Transfers to confirm <span className="text-muted">({list.length})</span></h2>
      <p className="mb-2 text-sm text-muted">Find each reference in the bank account before confirming. Confirming marks it paid and credits any invite reward.</p>
      <ul className="divide-y divide-line">
        {list.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
            <span className="min-w-0 flex-1">
              <Link to={`/players/${p.playerId}`} className="font-medium hover:underline">{p.displayName}</Link> · {what(p)}
              <span className="block text-xs text-muted">Ref <b className="text-ink">{p.reference}</b>{p.submittedAt && ` · sent ${formatInstant(p.submittedAt, "Africa/Lagos", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}{p.walletAmount > 0 && ` · plus ${formatMoney(p.walletAmount, p.currency)} wallet`}</span>
            </span>
            <span className="num text-lg">{formatMoney(p.amount, p.currency)}</span>
            <Button size="sm" loading={confirm.isPending && confirm.variables === p.id} onClick={() => confirm.mutate(p.id)}>Confirm</Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(p.id)}>Reject</Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog open={!!rejecting} title="Reject this transfer?" requireReason tone="danger" confirmLabel="Reject" onClose={() => setRejecting(null)}
        onConfirm={(reason) => reject.mutate({ id: rejecting!, reason }, { onSettled: () => setRejecting(null) })}>
        The player sees your reason and can start a new payment.
      </ConfirmDialog>
    </Card>
  );
}

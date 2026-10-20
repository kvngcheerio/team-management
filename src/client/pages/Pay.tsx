import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { Badge, Button, Card, CardIcon, ErrorBox, Loading, PageHeader, useToast } from "../components/ui";
import { formatDate } from "../format";
import type { Payment } from "../types";
import { formatMoney } from "../../shared/rules";

const TITLES = { membership: "Membership", guest_fee: "Guest fee", fines: "Pay fines" } as const;

/**
 * Checkout. Until Paystack is integrated, payments are bank transfers that an admin confirms; in
 * test mode a simulator replaces the transfer step. No card or bank details are ever collected here.
 */
export default function PayPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ["payment", id], queryFn: () => api.get<{ payment: Payment }>(`/payments/${id}`) });
  const refresh = (r: { payment: Payment }) => {
    qc.setQueryData(["payment", id], r);
    for (const k of ["my-fines", "me", "account", "matchday", "dashboard"]) qc.invalidateQueries({ queryKey: [k] });
  };
  const simulate = useMutation({ mutationFn: (outcome: "success" | "failure" | "cancel") => api.post<{ payment: Payment }>(`/payments/${id}/simulate`, { outcome }), onSuccess: refresh });
  const submit = useMutation({ mutationFn: () => api.post<{ payment: Payment }>(`/payments/${id}/submit`, {}), onSuccess: refresh });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const p = data!.payment;
  const money = (n: number) => formatMoney(n, p.currency);
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`);
    } catch {
      toast(text);
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-4">
      <PageHeader title={TITLES[p.purpose]} kicker="Checkout" />
      <Card className="divide-y divide-line">
        {p.purpose === "membership" && <Line label={`Membership${p.membership ? ` · ${formatDate(p.membership.periodStart)} → ${formatDate(p.membership.periodEnd)}` : ""}`} value={money(p.total)} />}
        {p.purpose === "guest_fee" && <Line label={`Guest fee${p.matchDay ? ` · ${formatDate(p.matchDay.date)}` : ""}`} value={money(p.total)} />}
        {p.cards.map((k) => (
          <div key={k.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <CardIcon color={k.color} />
            <span className="flex-1 capitalize">{k.color} card{k.date && ` · ${formatDate(k.date)}`}</span>
            <span className="num font-semibold">{money(k.fineAmount)}</span>
          </div>
        ))}
        {p.walletAmount > 0 && <Line label="Wallet credit applied" value={`−${money(p.walletAmount)}`} tone="text-pitch-800" />}
        <div className="flex items-center justify-between px-4 py-4">
          <span className="font-medium">To pay</span>
          <span className="num text-4xl font-light tracking-tight">{money(p.amount)}</span>
        </div>
      </Card>

      {p.bank && (p.status === "pending" || p.status === "submitted") && (
        <Card className="space-y-4 p-5">
          <div>
            <div className="text-sm text-muted">Pay by bank transfer to</div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Bank" value={p.bank.bankName} />
              <Field label="Account name" value={p.bank.accountName} />
              <div className="col-span-2 flex items-end justify-between gap-3 rounded-2xl bg-chalk px-4 py-3">
                <Field label="Account number" value={p.bank.accountNumber} big />
                <Button size="sm" variant="secondary" onClick={() => copy(p.bank!.accountNumber, "Account number")}>Copy</Button>
              </div>
              <div className="col-span-2 flex items-end justify-between gap-3 rounded-2xl bg-chalk px-4 py-3">
                <Field label="Narration / reference" value={p.reference} big />
                <Button size="sm" variant="secondary" onClick={() => copy(p.reference, "Reference")}>Copy</Button>
              </div>
            </div>
          </div>
          <p className="text-sm text-muted">
            Transfer exactly <b className="text-ink">{money(p.amount)}</b> and put the reference in the narration so we can match it.
          </p>
          {p.status === "pending" ? (
            <Button size="lg" className="w-full" loading={submit.isPending} onClick={() => submit.mutate()}>
              I've made the transfer
            </Button>
          ) : (
            <div role="status" className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <b>Waiting for confirmation.</b> An admin will check the transfer and confirm it — usually the same day.
            </div>
          )}
        </Card>
      )}

      {!p.bank && p.status === "pending" && (
        <>
          <div className="rounded-2xl bg-sky-50 px-4 py-3 text-sm text-sky-900">
            <b>Test mode.</b> This is a simulated payment — no money moves and no card details are needed.
          </div>
          <Button size="lg" className="w-full" loading={simulate.isPending} onClick={() => simulate.mutate("success")}>Simulate successful payment</Button>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => simulate.mutate("failure")}>Simulate failure</Button>
            <Button variant="ghost" onClick={() => simulate.mutate("cancel")}>Cancel</Button>
          </div>
        </>
      )}
      <ErrorBox error={simulate.error ?? submit.error} />

      {["succeeded", "failed", "cancelled"].includes(p.status) && (
        <Card className="p-5 text-center">
          <Badge tone={p.status === "succeeded" ? "green" : p.status === "failed" ? "red" : "gray"} className="!text-sm">
            {p.status === "succeeded" ? "Payment confirmed" : p.status === "failed" ? "Payment not confirmed" : "Payment cancelled"}
          </Badge>
          <p className="mt-2 text-sm text-muted">
            {p.status === "succeeded"
              ? p.purpose === "membership"
                ? "You're a member — welcome!"
                : p.purpose === "guest_fee"
                  ? p.matchDay?.registrationStatus === "confirmed" ? "Your place is confirmed. See you on the pitch!" : "Paid — you're on the waiting list; an admin will sort your place."
                  : "Your fines are marked as paid."
              : p.reviewNote ?? "Nothing was charged."}
          </p>
          <Link to="/me" className="mt-4 inline-block"><Button variant="secondary">Back to my profile</Button></Link>
        </Card>
      )}
      <p className="text-center text-xs text-muted">Reference {p.reference}</p>
    </div>
  );
}

function Line({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 text-sm ${tone ?? ""}`}>
      <span className="flex-1">{label}</span>
      <span className="num font-semibold">{value}</span>
    </div>
  );
}

function Field({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={big ? "num text-2xl font-light tracking-tight" : "text-lg"}>{value}</div>
    </div>
  );
}

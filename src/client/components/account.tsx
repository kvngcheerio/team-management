import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { formatDate, formatDateLong } from "../format";
import type { Account, CheckoutResult } from "../types";
import { formatMoney } from "../../shared/rules";
import { Badge, Button, Card, Empty, SectionTitle, useToast } from "./ui";

export function useAccount() {
  return useQuery({ queryKey: ["account"], queryFn: () => api.get<Account>("/me/account") });
}

/** Start a checkout; wallet-only payments complete immediately, others go to the (test-mode) checkout page. */
export function useCheckout(path: string, successMessage: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (body: object) => api.post<CheckoutResult>(path, body),
    onSuccess: (r) => {
      if (r.completed) {
        qc.invalidateQueries();
        toast(successMessage);
      } else {
        navigate(`/pay/${r.paymentId}`);
      }
    },
    onError: (e: Error) => toast(e.message, "error"),
  });
}

export function MembershipCard({ account }: { account: Account }) {
  const m = account.membership;
  const money = (n: number) => formatMoney(n, account.currency);
  const [useWallet, setUseWallet] = useState(account.wallet.balance > 0);
  const checkout = useCheckout("/membership/checkout", "Membership paid with wallet credit");
  const walletPart = useWallet ? Math.min(account.wallet.balance, account.fees.membership) : 0;
  const isMember = m.kind === "member";
  const tone = m.status === "overdue" ? "red" : m.status === "due_soon" ? "amber" : isMember ? "green" : "gray";
  return (
    <section>
      <SectionTitle>Membership</SectionTitle>
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone} className="!text-sm">
            {!isMember ? "Guest" : m.status === "overdue" ? "Renewal overdue" : m.status === "due_soon" ? "Renewal due soon" : "Member"}
          </Badge>
          {isMember && m.paidUntil && <span className="text-sm text-muted">Paid until {formatDateLong(m.paidUntil)}</span>}
        </div>
        <p className="text-sm text-muted">
          {isMember
            ? `Membership is ${money(account.fees.membership)} every ${account.fees.membershipMonths} months. Members earn league points.`
            : `You're a guest: ${money(account.fees.guest)} per match day (free after ${account.fees.guestFreeAfter} paid days in a season), no league points. Become a member for ${money(account.fees.membership)} / ${account.fees.membershipMonths} months.`}
        </p>
        <div className="rounded-xl bg-stone-50 p-3 text-sm">
          {isMember ? "Paying now covers" : "Membership would cover"} <b>{formatDate(m.next.start, { day: "numeric", month: "short", year: "numeric" })}</b> → <b>{formatDate(m.next.end, { day: "numeric", month: "short", year: "numeric" })}</b>
        </div>
        {account.wallet.balance > 0 && (
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
            <input type="checkbox" className="size-5 accent-pitch-700" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
            Use wallet credit ({money(Math.min(account.wallet.balance, account.fees.membership))})
          </label>
        )}
        <Button size="lg" className="w-full sm:w-auto" loading={checkout.isPending} onClick={() => checkout.mutate({ useWallet })}>
          {isMember ? "Renew" : "Become a member"} · {money(account.fees.membership - walletPart)}
        </Button>
      </Card>
    </section>
  );
}

export function WalletCard({ account }: { account: Account }) {
  const money = (n: number) => formatMoney(n, account.currency);
  return (
    <section>
      <SectionTitle>Wallet</SectionTitle>
      <Card className="p-5">
        <div className="text-sm text-muted">Balance</div>
        <div className="num stat text-4xl text-pitch-800">{money(account.wallet.balance)}</div>
        <p className="mt-1 text-sm text-muted">Use it for membership renewal or card fines.</p>
        {account.wallet.transactions.length > 0 && (
          <ul className="mt-3 divide-y divide-line text-sm">
            {account.wallet.transactions.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate">{t.note ?? t.kind}</span>
                <span className={`num font-semibold ${t.amount > 0 ? "text-pitch-800" : "text-red-700"}`}>{t.amount > 0 ? "+" : "−"}{money(Math.abs(t.amount))}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

export function InviteCard({ account }: { account: Account }) {
  const toast = useToast();
  const money = (n: number) => formatMoney(n, account.currency);
  const share = async () => {
    const text = `Come play with us! Sign up here: ${account.referral.url}`;
    try {
      if (navigator.share) await navigator.share({ title: "Join us", text, url: account.referral.url });
      else {
        await navigator.clipboard.writeText(account.referral.url);
        toast("Invite link copied");
      }
    } catch {
      /* share sheet dismissed */
    }
  };
  return (
    <section>
      <SectionTitle>Invite friends</SectionTitle>
      <Card className="space-y-3 p-5">
        <p className="text-sm">
          Earn <b>{money(account.fees.referralCredit)}</b> wallet credit for every friend who signs up with your link and makes their first payment.
        </p>
        <div className="flex flex-wrap gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-100 px-3 py-2.5 text-sm">{account.referral.url}</code>
          <Button onClick={share}>Share link</Button>
        </div>
        {account.referral.invited.length > 0 && (
          <ul className="divide-y divide-line text-sm">
            {account.referral.invited.map((i) => (
              <li key={i.playerId} className="flex items-center justify-between py-2">
                <span>{i.displayName}</span>
                {i.credited ? <Badge tone="green">+{money(account.fees.referralCredit)} earned</Badge> : <Badge>Not paid yet</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

export function GuestFeesOwed({ account }: { account: Account }) {
  if (account.guestFeesOwed.length === 0) return null;
  return (
    <section>
      <SectionTitle>Guest fees due</SectionTitle>
      <Card>
        <ul className="divide-y divide-line">
          {account.guestFeesOwed.map((g) => (
            <GuestFeeRow key={g.registrationId} matchDayId={g.matchDayId} date={g.date} amount={g.amount} currency={account.currency} pending={g.status === "pending"} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function GuestFeeRow({ matchDayId, date, amount, currency, pending }: { matchDayId: string; date: string; amount: number; currency: string; pending: boolean }) {
  const checkout = useCheckout(`/matchdays/${matchDayId}/guest-fee/checkout`, "Guest fee paid");
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <span className="flex-1">
        <b>{formatDate(date)}</b> {pending ? "· pay to confirm your place" : "· you played, fee still owed"}
      </span>
      <Button size="sm" loading={checkout.isPending} onClick={() => checkout.mutate({})}>Pay {formatMoney(amount, currency)}</Button>
    </li>
  );
}

export function TransfersCard({ account }: { account: Account }) {
  const navigate = useNavigate();
  if (account.transfers.length === 0) return null;
  const label = { membership: "Membership", guest_fee: "Guest fee", fines: "Fines" } as Record<string, string>;
  return (
    <section>
      <SectionTitle>Bank transfers</SectionTitle>
      <Card>
        <ul className="divide-y divide-line">
          {account.transfers.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 flex-1">
                {label[t.purpose] ?? t.purpose} · {formatMoney(t.amount, account.currency)} <span className="text-muted">· {t.reference}</span>
                {t.status === "failed" && t.reviewNote && <span className="block text-xs text-red-700">Not confirmed: {t.reviewNote}</span>}
              </span>
              {t.status === "pending" && <Button size="sm" onClick={() => navigate(`/pay/${t.id}`)}>Finish payment</Button>}
              {t.status === "submitted" && <Badge tone="amber">Waiting for confirmation</Badge>}
              {t.status === "failed" && <Badge tone="red">Not confirmed</Badge>}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

export function AccountSections() {
  const { data } = useAccount();
  if (!data) return null;
  return (
    <>
      <TransfersCard account={data} />
      <GuestFeesOwed account={data} />
      <MembershipCard account={data} />
      <WalletCard account={data} />
      <InviteCard account={data} />
    </>
  );
}

export { Empty };

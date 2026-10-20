import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { PublicCard } from "../components/PublicCard";
import { Button, ErrorBox, Field, Input, Loading } from "../components/ui";

export default function JoinPage({ referral = false }: { referral?: boolean }) {
  const { token } = useParams();
  const endpoint = referral ? `/public/r/${token}` : `/public/signup/${token}`;
  const info = useQuery({
    queryKey: ["signup", referral, token],
    queryFn: () => api.get<{ groupName: string; referrerName?: string; guestFee?: number; guestFreeAfter?: number; membershipFee?: number; currency?: string }>(endpoint),
    retry: false,
  });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState({ name: "", email: "", phone: "", password: "", website: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (info.isLoading) return <Loading />;
  if (info.error) {
    return (
      <PublicCard title="Join">
        <ErrorBox error={info.error} />
      </PublicCard>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(endpoint, { ...f, phone: f.phone || undefined, website: f.website || undefined });
      await qc.invalidateQueries();
      navigate("/me", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <PublicCard title="Join the group" kicker={info.data!.groupName}>
      {info.data!.referrerName && (
        <p className="mb-3 rounded-xl bg-pitch-50 px-3 py-2 text-sm font-medium text-pitch-900">{info.data!.referrerName} invited you to play with {info.data!.groupName}.</p>
      )}
      <p className="mb-4 text-sm text-muted">
        You'll join as a guest
        {info.data!.guestFee != null && ` (₦${info.data!.guestFee.toLocaleString()} per match day, free after ${info.data!.guestFreeAfter} paid days in a season)`}. You can become a member any time from your profile
        {info.data!.membershipFee != null && ` for ₦${info.data!.membershipFee.toLocaleString()}`}.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name" hint="As your teammates know you.">
          <Input required maxLength={60} autoComplete="name" value={f.name} onChange={set("name")} />
        </Field>
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label="Phone (optional)" hint="Only admins can see it.">
          <Input type="tel" maxLength={30} autoComplete="tel" value={f.phone} onChange={set("phone")} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" required minLength={10} autoComplete="new-password" value={f.password} onChange={set("password")} />
        </Field>
        <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} />
        </div>
        <ErrorBox error={error} />
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Create account
        </Button>
        <p className="text-center text-sm text-muted">
          Already have an account? <a href="/signin" className="font-semibold text-pitch-700 underline">Sign in</a>
        </p>
      </form>
    </PublicCard>
  );
}

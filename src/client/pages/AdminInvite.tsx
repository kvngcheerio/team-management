import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { PublicCard } from "../components/PublicCard";
import { Button, ErrorBox, Field, Input, Loading } from "../components/ui";

export default function AdminInvitePage() {
  const { token } = useParams();
  const info = useQuery({ queryKey: ["admin-invite", token], queryFn: () => api.get<{ groupName: string }>(`/public/admin-invites/${token}`), retry: false });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState({ name: "", email: "", password: "", alsoPlayer: true });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (info.isLoading) return <Loading />;
  if (info.error) {
    return (
      <PublicCard title="Admin invite">
        <ErrorBox error={info.error} />
      </PublicCard>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/public/admin-invites/${token}/accept`, f);
      await qc.invalidateQueries();
      navigate("/admin", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PublicCard title="Become an admin" kicker={info.data!.groupName}>
      <p className="mb-4 text-sm text-muted">You've been invited to help run the group. This link works once.</p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
        <Field label="Email"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
        <Field label="Password" hint="At least 10 characters."><Input type="password" required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <input type="checkbox" className="size-5 accent-pitch-700" checked={f.alsoPlayer} onChange={(e) => setF({ ...f, alsoPlayer: e.target.checked })} />I also play (create my player profile)
        </label>
        <ErrorBox error={error} />
        <Button type="submit" size="lg" className="w-full" loading={busy}>Create admin account</Button>
      </form>
    </PublicCard>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { PublicCard } from "../components/PublicCard";
import { Button, ErrorBox, Field, Input, Loading } from "../components/ui";

export default function InvitePage() {
  const { token } = useParams();
  const invite = useQuery({ queryKey: ["invite", token], queryFn: () => api.get<{ playerName: string; groupName: string }>(`/public/invites/${token}`), retry: false });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (invite.isLoading) return <Loading />;
  if (invite.error) {
    return (
      <PublicCard title="Invite">
        <ErrorBox error={invite.error} />
      </PublicCard>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/public/invites/${token}/accept`, { email, password });
      await qc.invalidateQueries();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PublicCard title={`Welcome, ${invite.data!.playerName}`} kicker={invite.data!.groupName}>
      <p className="mb-4 text-sm text-muted">Create your login. Your existing match history and stats stay attached to your profile.</p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Create login
        </Button>
      </form>
    </PublicCard>
  );
}

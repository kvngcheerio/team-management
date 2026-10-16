import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { PublicCard } from "../components/PublicCard";
import { Button, ErrorBox, Field, Input, Loading } from "../components/ui";
import { useMe } from "../hooks";

export default function SignInPage() {
  const { data, isLoading } = useMe();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get("next")?.startsWith("/") ? params.get("next")! : "/";

  if (isLoading) return <Loading />;
  if (data?.needsSetup) return <Navigate to="/setup" replace />;
  if (data?.user) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/sign-in/email", { email, password });
      await qc.invalidateQueries();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicCard title="Sign in" kicker={data?.groupName}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Sign in
        </Button>
        <p className="text-center text-sm text-muted">No account? Ask an admin for your personal invite link.</p>
      </form>
    </PublicCard>
  );
}

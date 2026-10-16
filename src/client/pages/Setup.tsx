import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { api } from "../api";
import { PublicCard } from "../components/PublicCard";
import { Button, ErrorBox, Field, Input, Loading } from "../components/ui";

export default function SetupPage() {
  const status = useQuery({ queryKey: ["setup-status"], queryFn: () => api.get<{ needsSetup: boolean; setupTokenConfigured: boolean }>("/setup/status") });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ token: "", name: "", email: "", password: "", alsoPlayer: true });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (status.isLoading) return <Loading />;
  if (status.data && !status.data.needsSetup) return <Navigate to="/signin" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/setup", form);
      await qc.invalidateQueries();
      navigate("/admin", { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: k === "alsoPlayer" ? e.target.checked : e.target.value });

  return (
    <PublicCard title="First-time setup" kicker="Create the admin account">
      {!status.data?.setupTokenConfigured && (
        <div className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Setup is disabled until the <code className="font-mono">SETUP_TOKEN</code> secret is configured. See the README.
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Setup token" hint="The value of the SETUP_TOKEN secret. Remove the secret after setup.">
          <Input type="password" required value={form.token} onChange={set("token")} autoComplete="off" />
        </Field>
        <Field label="Your name">
          <Input required value={form.name} onChange={set("name")} autoComplete="name" />
        </Field>
        <Field label="Email">
          <Input type="email" required value={form.email} onChange={set("email")} autoComplete="email" />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" required minLength={10} value={form.password} onChange={set("password")} autoComplete="new-password" />
        </Field>
        <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <input type="checkbox" className="size-5 accent-pitch-700" checked={form.alsoPlayer} onChange={set("alsoPlayer")} />I also play (create my player profile)
        </label>
        <ErrorBox error={error} />
        <Button type="submit" size="lg" className="w-full" loading={busy}>
          Create admin
        </Button>
      </form>
    </PublicCard>
  );
}

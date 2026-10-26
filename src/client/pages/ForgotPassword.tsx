import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { PublicCard } from "../components/PublicCard";
import { Button, ErrorBox, Field, Input } from "../components/ui";

/** Two steps: email a 6-digit code, then set a new password with it. All sessions are signed out on reset. */
export default function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [step, setStep] = useState<"email" | "reset">(params.get("email") ? "reset" : "email");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const requestCode = (e?: FormEvent) => {
    e?.preventDefault();
    return run(async () => {
      await api.post("/auth/email-otp/request-password-reset", { email: email.trim() });
      setOtp("");
      setStep("reset");
      setNotice(`If ${email.trim()} has an account, a 6-digit code is on its way. It expires in 10 minutes.`);
    });
  };

  const reset = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError(new Error("The passwords don't match."));
      return;
    }
    return run(async () => {
      await api.post("/auth/email-otp/reset-password", { email: email.trim(), otp: otp.trim(), password });
      navigate("/signin?reset=1", { replace: true });
    });
  };

  return (
    <PublicCard title="Reset password">
      {step === "email" ? (
        <form onSubmit={requestCode} className="space-y-4">
          <p className="text-sm text-muted">Enter the email you sign in with and we'll send you a code to reset your password.</p>
          <Field label="Email">
            <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" size="lg" className="w-full" loading={busy}>
            Send code
          </Button>
          <p className="text-center text-sm">
            <Link to="/signin" className="text-muted underline underline-offset-4 hover:text-ink">Back to sign in</Link>
          </p>
        </form>
      ) : (
        <form onSubmit={reset} className="space-y-4">
          {notice ? <p className="text-sm text-muted">{notice}</p> : <p className="text-sm text-muted">Enter the code we emailed to {email}.</p>}
          <Field label="Code">
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <Input type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" size="lg" className="w-full" loading={busy}>
            Reset password
          </Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="text-muted underline underline-offset-4 hover:text-ink" onClick={() => setStep("email")}>
              Use a different email
            </button>
            <button type="button" disabled={busy || !email} className="text-muted underline underline-offset-4 hover:text-ink" onClick={() => requestCode()}>
              Send a new code
            </button>
          </div>
        </form>
      )}
    </PublicCard>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { api } from "../api";
import { PublicCard } from "../components/PublicCard";
import { Button, ErrorBox, Field, Input, Loading } from "../components/ui";
import { formatDateLong, formatInstant } from "../format";

interface PublicDay {
  groupName: string;
  date: string;
  kickoffTime: string;
  venue: string;
  status: string;
  timezone: string;
  checkinDeadline: string;
  spotsLeft: number;
  open: boolean;
}

export default function GuestRegisterPage() {
  const { token } = useParams();
  const day = useQuery({ queryKey: ["public-day", token], queryFn: () => api.get<PublicDay>(`/public/matchdays/${token}`), retry: false });
  const startedAt = useRef(Date.now());
  const [form, setForm] = useState({ name: "", email: "", phone: "", note: "", website: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (day.isLoading) return <Loading />;
  if (day.error) {
    return (
      <PublicCard title="Guest sign-up">
        <ErrorBox error={day.error} />
      </PublicCard>
    );
  }
  const d = day.data!;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/public/matchdays/${token}/guests`, {
        name: form.name,
        email: form.email || undefined,
        phone: form.phone || undefined,
        note: form.note || undefined,
        website: form.website || undefined,
        elapsedMs: Date.now() - startedAt.current,
      });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <PublicCard title="Play as a guest" kicker={d.groupName}>
      <div className="mb-5 rounded-xl bg-pitch-50 p-4">
        <div className="display text-2xl font-bold uppercase text-pitch-900">{formatDateLong(d.date)}</div>
        <div className="mt-1 text-sm text-pitch-900">
          Kick-off {d.kickoffTime}
          {d.venue && ` · ${d.venue}`}
        </div>
        <div className="mt-1 text-xs text-muted">
          Sign-ups close {formatInstant(d.checkinDeadline, d.timezone)} · {d.spotsLeft} place{d.spotsLeft === 1 ? "" : "s"} left
        </div>
      </div>
      {done ? (
        <div role="status" className="rounded-xl border border-pitch-200 bg-pitch-50 p-4">
          <p className="display text-2xl font-bold uppercase text-pitch-900">Request sent</p>
          <p className="mt-1 text-sm text-pitch-900">An admin will review it. Guests can play and score but don't earn league points. You're not confirmed until approved.</p>
        </div>
      ) : !d.open ? (
        <p className="rounded-xl bg-stone-100 p-4 text-sm font-medium">Guest sign-ups for this match day are closed.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Your name">
            <Input required maxLength={60} value={form.name} onChange={set("name")} autoComplete="name" />
          </Field>
          <Field label="Phone (optional)" hint="Only admins can see your contact details.">
            <Input type="tel" maxLength={30} value={form.phone} onChange={set("phone")} autoComplete="tel" />
          </Field>
          <Field label="Email (optional)">
            <Input type="email" maxLength={200} value={form.email} onChange={set("email")} autoComplete="email" />
          </Field>
          <Field label="Note for the organiser (optional)">
            <Input maxLength={200} value={form.note} onChange={set("note")} placeholder="e.g. Friend of Chidi" />
          </Field>
          {/* Honeypot: hidden from people, often filled by bots. */}
          <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label>
              Website
              <input tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
            </label>
          </div>
          <ErrorBox error={error} />
          <Button type="submit" size="lg" className="w-full" loading={busy}>
            Request a place
          </Button>
        </form>
      )}
    </PublicCard>
  );
}

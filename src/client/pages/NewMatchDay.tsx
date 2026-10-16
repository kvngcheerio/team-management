import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Select } from "../components/ui";
import type { MatchDayDetail, Season } from "../types";
import { addDays } from "../../shared/rules";
import { todayInZone } from "../../shared/time";

export default function NewMatchDayPage() {
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: () => api.get<{ seasons: Season[] }>("/seasons") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: Record<string, string> }>("/admin/settings") });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const active = seasons.data?.seasons.filter((s) => s.status === "active") ?? [];
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings.data || !seasons.data || form.seasonId !== undefined) return;
    const s = settings.data.settings;
    const tz = s.timezone ?? "Africa/Lagos";
    // Default: next Saturday 07:00, check-in closes the evening before.
    const today = todayInZone(tz);
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    const date = addDays(today, ((6 - dow + 7) % 7) || 7);
    setForm({
      seasonId: active[0]?.id ?? "",
      date,
      kickoffTime: "07:00",
      venue: s.default_venue ?? "",
      capacity: s.default_capacity ?? "20",
      teamSize: s.default_team_size ?? "5",
      setCount: s.default_set_count ?? "4",
      checkinDeadlineDate: addDays(date, -1),
      checkinDeadlineTime: "20:00",
      tiePolicy: "shared",
      notes: "",
    });
  }, [settings.data, seasons.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (seasons.isLoading || settings.isLoading) return <Loading />;
  if (active.length === 0) {
    return (
      <div>
        <PageHeader title="New match day" />
        <Empty title="No active season" action={<Link to="/admin/seasons"><Button>Create a season</Button></Link>}>
          Match days belong to a season.
        </Empty>
      </div>
    );
  }
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<MatchDayDetail>("/matchdays", {
        ...form,
        capacity: Number(form.capacity),
        teamSize: Number(form.teamSize),
        setCount: Number(form.setCount),
      });
      qc.invalidateQueries({ queryKey: ["matchdays"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      navigate(`/matchdays/${res.day.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-2xl">
      <PageHeader title="New match day" kicker="Admin" />
      <Card className="p-5">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Season">
              <Select value={form.seasonId ?? ""} onChange={set("seasonId")}>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.startDate} → {s.endDate})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Date">
            <Input type="date" required value={form.date ?? ""} onChange={set("date")} />
          </Field>
          <Field label="Kick-off">
            <Input type="time" required value={form.kickoffTime ?? ""} onChange={set("kickoffTime")} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Venue">
              <Input value={form.venue ?? ""} onChange={set("venue")} maxLength={120} placeholder="e.g. Astro pitch, Lekki" />
            </Field>
          </div>
          <Field label="Capacity" hint="Players beyond this join the waiting list.">
            <Input type="number" inputMode="numeric" min={2} max={200} required value={form.capacity ?? ""} onChange={set("capacity")} />
          </Field>
          <Field label="Tie policy" hint="How a tie on wins is settled.">
            <Select value={form.tiePolicy ?? "shared"} onChange={set("tiePolicy")}>
              <option value="shared">Shared first place (default)</option>
              <option value="playoff">Playoff match</option>
            </Select>
          </Field>
          <Field label="Number of sets">
            <Input type="number" inputMode="numeric" min={2} max={12} required value={form.setCount ?? ""} onChange={set("setCount")} />
          </Field>
          <Field label="Players per set">
            <Input type="number" inputMode="numeric" min={1} max={30} required value={form.teamSize ?? ""} onChange={set("teamSize")} />
          </Field>
          <Field label="Check-in closes (date)">
            <Input type="date" required value={form.checkinDeadlineDate ?? ""} onChange={set("checkinDeadlineDate")} />
          </Field>
          <Field label="Check-in closes (time)" hint={`Times are in ${settings.data?.settings.timezone ?? "Africa/Lagos"}.`}>
            <Input type="time" required value={form.checkinDeadlineTime ?? ""} onChange={set("checkinDeadlineTime")} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes (optional)">
              <Input value={form.notes ?? ""} onChange={set("notes")} maxLength={500} placeholder="Bring both kits" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <ErrorBox error={error} className="mb-3" />
            <Button type="submit" size="lg" className="w-full sm:w-auto" loading={busy}>
              Create as draft
            </Button>
            <p className="mt-2 text-xs text-muted">Drafts are only visible to admins until you open check-in.</p>
          </div>
        </form>
      </Card>
    </div>
  );
}

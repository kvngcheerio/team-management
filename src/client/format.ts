export function formatDate(date: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatDateLong(date: string) {
  return formatDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** Format a UTC timestamp in the configured timezone. */
export function formatInstant(iso: string, tz: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) {
  return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tz }).format(new Date(iso));
}

export function relativeDeadline(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "closed";
  const h = Math.floor(ms / 3600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  checkin_open: "Check-in open",
  locked: "Check-in closed",
  in_progress: "In progress",
  finalized: "Final",
  cancelled: "Cancelled",
};

export const REG_LABEL: Record<string, string> = {
  pending: "Awaiting approval",
  confirmed: "Playing",
  waitlist: "Waiting list",
  withdrawn: "Withdrawn",
  rejected: "Declined",
};

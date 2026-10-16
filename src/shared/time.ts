/** Timezone helpers. Timestamps are stored in UTC; display and input use the configured IANA zone. */

/** Offset (minutes) of `tz` from UTC at the given instant. */
export function tzOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** Convert a local wall-clock date (YYYY-MM-DD) and time (HH:MM) in `tz` to a UTC ISO string. */
export function zonedToUtcIso(date: string, time: string, tz: string): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes handle DST transitions for zones that have them.
  let offset = tzOffsetMinutes(new Date(guess), tz);
  let ts = guess - offset * 60000;
  const offset2 = tzOffsetMinutes(new Date(ts), tz);
  if (offset2 !== offset) {
    offset = offset2;
    ts = guess - offset * 60000;
  }
  return new Date(ts).toISOString();
}

/** Split a UTC instant into local date and time strings in `tz`. */
export function utcToZoned(iso: string, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** Today's calendar date in `tz`. */
export function todayInZone(tz: string, now = new Date()): string {
  return utcToZoned(now.toISOString(), tz).date;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

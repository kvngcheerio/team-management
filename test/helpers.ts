import { exports } from "cloudflare:workers";

let ipCounter = 1;

/** Minimal HTTP client with a cookie jar that calls the Worker in-process. */
export class Client {
  cookies = new Map<string, string>();
  ip = `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { Origin: "http://localhost", "CF-Connecting-IP": this.ip, ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await (exports as any).default.fetch(
      new Request(`http://localhost/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    );
    for (const sc of res.headers.getSetCookie() as string[]) {
      const kv = sc.split(";")[0]!;
      const i = kv.indexOf("=");
      const value = kv.slice(i + 1);
      if (value === "" || /max-age=0/i.test(sc)) this.cookies.delete(kv.slice(0, i));
      else this.cookies.set(kv.slice(0, i), value);
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status as number, body: json as T };
  }
  get<T = any>(path: string) {
    return this.req<T>("GET", path);
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.req<T>("POST", path, body);
  }
  patch<T = any>(path: string, body: unknown) {
    return this.req<T>("PATCH", path, body);
  }
  put<T = any>(path: string, body: unknown) {
    return this.req<T>("PUT", path, body);
  }
}

export const PASSWORD = "correct-horse-battery";

export async function setupAdmin(name = "Ada Admin") {
  const admin = new Client();
  const res = await admin.post("/setup", { token: "test-setup-token", name, email: "admin@example.com", password: PASSWORD, alsoPlayer: true });
  if (res.status !== 200) throw new Error(`setup failed ${res.status} ${JSON.stringify(res.body)}`);
  const me = await admin.get("/me");
  return { admin, adminPlayerId: me.body.player.id as string };
}

let emailCounter = 0;

export async function createPlayer(
  admin: Client,
  displayName: string,
  opts: { login?: boolean; kind?: "member" | "guest"; skillRating?: number; gkPreference?: "none" | "can" | "prefers" } = {},
) {
  const res = await admin.post("/players", {
    displayName,
    kind: opts.kind ?? "member",
    skillRating: opts.skillRating ?? 5,
    gkPreference: opts.gkPreference ?? "none",
  });
  if (res.status !== 201) throw new Error(`create player failed ${res.status} ${JSON.stringify(res.body)}`);
  const playerId = res.body.player.id as string;
  if (!opts.login) return { playerId, client: null as Client | null };
  const invite = await admin.post(`/players/${playerId}/invite`);
  const token = (invite.body.url as string).split("/invite/")[1]!;
  const client = new Client();
  const accept = await client.post(`/public/invites/${token}/accept`, { email: `p${++emailCounter}-${Date.now()}@example.com`, password: PASSWORD });
  if (accept.status !== 200) throw new Error(`accept failed ${accept.status} ${JSON.stringify(accept.body)}`);
  return { playerId, client: client as Client | null };
}

export async function createSeason(admin: Client, startDate = "2026-10-01") {
  const res = await admin.post("/seasons", { name: "Test Season", startDate });
  if (res.status !== 201) throw new Error(`season failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.season as { id: string; startDate: string; endDate: string };
}

export async function createMatchDay(admin: Client, seasonId: string, over: Record<string, unknown> = {}) {
  const res = await admin.post("/matchdays", {
    seasonId,
    date: "2026-11-07",
    kickoffTime: "07:30",
    venue: "Astro Pitch",
    capacity: 12,
    checkinDeadlineDate: "2026-11-06",
    checkinDeadlineTime: "20:00",
    teamSize: 4,
    setCount: 2,
    tiePolicy: "shared",
    ...over,
  });
  if (res.status !== 201) throw new Error(`matchday failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

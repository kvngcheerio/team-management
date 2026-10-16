import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { Client, createMatchDay, createPlayer, createSeason, PASSWORD, setupAdmin } from "./helpers";

let admin: Client;
let member: Client;
let memberPlayerId: string;
let seasonId: string;

describe("first-admin setup", () => {
  it("rejects a wrong setup token and creates no admin", async () => {
    const c = new Client();
    expect((await c.get("/setup/status")).body.needsSetup).toBe(true);
    const bad = await c.post("/setup", { token: "nope", name: "Mallory", email: "m@example.com", password: PASSWORD });
    expect(bad.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user").first("n")).toBe(0);
  });

  it("creates the first admin once, then refuses", async () => {
    ({ admin } = await setupAdmin());
    expect((await admin.get("/me")).body.user.role).toBe("admin");
    const again = await new Client().post("/setup", { token: "test-setup-token", name: "Second", email: "second@example.com", password: PASSWORD });
    expect(again.status).toBe(409);
    expect((await new Client().get("/setup/status")).body.needsSetup).toBe(false);
  });
});

describe("authentication and authorization", () => {
  beforeAll(async () => {
    const p = await createPlayer(admin, "Mo Member", { login: true });
    member = p.client!;
    memberPlayerId = p.playerId;
    seasonId = (await createSeason(admin)).id;
  });

  it("blocks public sign-up (no self-made accounts or admins)", async () => {
    const c = new Client();
    const res = await c.post("/auth/sign-up/email", { name: "Eve", email: "eve@example.com", password: PASSWORD, role: "admin" });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM user WHERE email = 'eve@example.com'").first("n")).toBe(0);
  });

  it("does not let a member change their own role through the auth API", async () => {
    await member.post("/auth/update-user", { role: "admin" });
    expect((await member.get("/me")).body.user.role).toBe("member");
    expect((await member.get("/admin/settings")).status).toBe(403);
  });

  it("requires a session for protected reads", async () => {
    const anon = new Client();
    for (const path of ["/dashboard", "/seasons", "/players", "/matchdays", `/seasons/${seasonId}/standings`]) {
      expect((await anon.get(path)).status, path).toBe(401);
    }
  });

  it("rejects members on every admin mutation", async () => {
    const day = await createMatchDay(admin, seasonId);
    const id = day.day.id;
    const attempts: [string, string, unknown][] = [
      ["POST", "/seasons", { name: "x", startDate: "2027-05-01" }],
      ["POST", `/seasons/${seasonId}/close`, {}],
      ["POST", "/players", { displayName: "x" }],
      ["PATCH", `/players/${memberPlayerId}`, { skillRating: 10 }],
      ["POST", `/players/${memberPlayerId}/invite`, {}],
      ["POST", "/matchdays", { seasonId }],
      ["PATCH", `/matchdays/${id}`, { capacity: 3 }],
      ["POST", `/matchdays/${id}/transition`, { to: "checkin_open" }],
      ["POST", `/matchdays/${id}/start`, {}],
      ["POST", `/matchdays/${id}/finalize`, {}],
      ["POST", `/matchdays/${id}/registrations`, { playerId: memberPlayerId }],
      ["POST", `/matchdays/${id}/attendance`, { entries: [{ playerId: memberPlayerId, attended: true }] }],
      ["POST", `/matchdays/${id}/teams/generate`, { mode: "random" }],
      ["POST", `/matchdays/${id}/matches`, { homeSetId: "a", awaySetId: "b" }],
      ["PATCH", "/matches/x", { homeScore: 1 }],
      ["POST", "/matches/x/goals", { setId: "a", kind: "unattributed" }],
      ["POST", "/goals/x/delete", {}],
      ["POST", "/registrations/x/approve", {}],
      ["GET", "/admin/users", undefined],
      ["PUT", "/admin/settings", { group_name: "pwned" }],
      ["POST", "/admin/users/x/role", { role: "admin" }],
    ];
    for (const [method, path, body] of attempts) {
      expect((await member.req(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
  });

  it("hides private player fields from members", async () => {
    const asMember = await member.get("/players");
    expect(asMember.body.players[0].skillRating).toBeUndefined();
    expect(asMember.body.players[0].contactEmail).toBeUndefined();
    const asAdmin = await admin.get("/players");
    expect(asAdmin.body.players[0].skillRating).toBeDefined();
  });

  it("blocks cross-origin state-changing requests and non-JSON bodies", async () => {
    const res = await member.req("POST", "/matchdays/x/checkin", {}, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const form = await (exports as any).default.fetch(
      new Request("http://localhost/api/public/matchdays/x/guests", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost" },
        body: "name=bot",
      }),
    );
    expect(form.status).toBe(415);
  });

  it("signs in and out with email/password; wrong passwords fail", async () => {
    const c = new Client();
    expect((await c.post("/auth/sign-in/email", { email: "admin@example.com", password: "wrong-password-123" })).status).toBe(401);
    const ok = await c.post("/auth/sign-in/email", { email: "admin@example.com", password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await c.get("/me")).body.user.role).toBe("admin");
    await c.post("/auth/sign-out", {});
    expect((await c.get("/dashboard")).status).toBe(401);
  });

  it("rate-limits repeated sign-in attempts", async () => {
    const c = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await c.post("/auth/sign-in/email", { email: "nobody@example.com", password: "x-wrong-password" })).status);
    expect(statuses.slice(-1)[0]).toBe(429);
  });

  it("never stores plaintext passwords", async () => {
    const row = await env.DB.prepare("SELECT password FROM account WHERE password IS NOT NULL LIMIT 1").first<{ password: string }>();
    expect(row!.password).toMatch(/^pbkdf2_sha256\$100000\$/);
    expect(row!.password).not.toContain(PASSWORD);
  });

  it("keeps the last admin", async () => {
    const me = (await admin.get("/me")).body.user;
    const res = await admin.post(`/admin/users/${me.id}/role`, { role: "member" });
    expect(res.status).toBe(409);
  });

  it("invite links are single-use and link the existing player without duplicating it", async () => {
    const p = await createPlayer(admin, "Late Joiner");
    const inv = await admin.post(`/players/${p.playerId}/invite`);
    const token = inv.body.url.split("/invite/")[1];
    const c = new Client();
    expect((await c.get(`/public/invites/${token}`)).body.playerName).toBe("Late Joiner");
    expect((await c.post(`/public/invites/${token}/accept`, { email: "late@example.com", password: PASSWORD })).status).toBe(200);
    expect((await c.get("/me")).body.player.id).toBe(p.playerId);
    expect((await new Client().post(`/public/invites/${token}/accept`, { email: "late2@example.com", password: PASSWORD })).status).toBe(410);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE display_name = 'Late Joiner'").first("n")).toBe(1);
  });
});

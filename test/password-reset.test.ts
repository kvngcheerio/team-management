import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, PASSWORD, setupAdmin } from "./helpers";

const ADMIN_EMAIL = "admin@example.com";
const NEW_PASSWORD = "brand-new-password-42";

// Resend's API is stubbed; the worker runs in this isolate, so it sees the stub and the test key.
const realFetch = globalThis.fetch;
const realKey = (env as { RESEND_API_KEY?: string }).RESEND_API_KEY;
const sent: { to: string; subject: string; text: string }[] = [];
beforeAll(() => {
  (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = "re_test_reset";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "https://api.resend.com/emails") return realFetch(input as RequestInfo, init);
    const body = JSON.parse(String(init?.body));
    sent.push({ to: body.to[0], subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = realKey;
});

/** The email is sent via waitUntil, after the response. */
async function nextCode(to: string, after: number) {
  for (let i = 0; i < 50; i++) {
    const mail = sent.slice(after).find((m) => m.to === to);
    if (mail) return mail.subject.match(/^(\d{6}) /)![1]!;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no reset email to ${to}`);
}

let admin: Client;
beforeAll(async () => {
  ({ admin } = await setupAdmin());
});

describe("forgot password with an emailed code", () => {
  it("answers the same for unknown emails and sends nothing", async () => {
    const before = sent.length;
    const res = await new Client().post("/auth/email-otp/request-password-reset", { email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.length).toBe(before);
  });

  it("rejects a wrong code, then resets with the right one and signs out other sessions", async () => {
    const before = sent.length;
    const anon = new Client();
    expect((await anon.post("/auth/email-otp/request-password-reset", { email: ADMIN_EMAIL.toUpperCase() })).status).toBe(200);
    const code = await nextCode(ADMIN_EMAIL, before);
    expect(sent.at(-1)!.text).toContain(code);

    const wrong = code === "000000" ? "111111" : "000000";
    expect((await anon.post("/auth/email-otp/reset-password", { email: ADMIN_EMAIL, otp: wrong, password: NEW_PASSWORD })).status).toBe(400);
    expect((await anon.post("/auth/email-otp/reset-password", { email: ADMIN_EMAIL, otp: code, password: "short" })).status).toBe(400);
    expect((await anon.post("/auth/email-otp/reset-password", { email: ADMIN_EMAIL, otp: code, password: NEW_PASSWORD })).status).toBe(200);

    // The code is single-use, the old session is revoked, and only the new password works.
    expect((await anon.post("/auth/email-otp/reset-password", { email: ADMIN_EMAIL, otp: code, password: PASSWORD })).status).toBe(400);
    expect((await admin.get("/me")).body.user).toBeFalsy();
    expect((await new Client().post("/auth/sign-in/email", { email: ADMIN_EMAIL, password: PASSWORD })).status).toBe(401);
    const fresh = new Client();
    expect((await fresh.post("/auth/sign-in/email", { email: ADMIN_EMAIL, password: NEW_PASSWORD })).status).toBe(200);
    expect((await fresh.get("/me")).body.user.email).toBe(ADMIN_EMAIL);
  });

  it("keeps OTP sign-in and the other plugin endpoints closed", async () => {
    const c = new Client();
    expect((await c.post("/auth/sign-in/email-otp", { email: ADMIN_EMAIL, otp: "123456" })).status).toBe(404);
    expect((await c.post("/auth/email-otp/send-verification-otp", { email: ADMIN_EMAIL, type: "sign-in" })).status).toBe(404);
    expect((await c.post("/auth/forget-password/email-otp", { email: ADMIN_EMAIL })).status).toBe(404);
  });

  it("rate-limits code requests per client", async () => {
    const c = new Client();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await c.post("/auth/email-otp/request-password-reset", { email: "nobody@example.com" })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

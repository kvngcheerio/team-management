import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { allowedOrigins, createAuth } from "./auth";
import type { AppEnv, SessionUser } from "./env";
import { HttpError } from "./lib/db";
import { rateLimit } from "./lib/rate-limit";
import { sendCheckinReminders } from "./lib/reminders";
import { runSchedule } from "./lib/schedule";
import { adminRoutes } from "./routes/admin";
import { announcementRoutes } from "./routes/announcements";
import { disciplineRoutes } from "./routes/discipline";
import { mvpRoutes } from "./routes/mvp";
import { financeRoutes } from "./routes/finance";
import { paymentRoutes } from "./routes/payments";
import { matchRoutes } from "./routes/matches";
import { matchDayRoutes } from "./routes/matchdays";
import { playerRoutes } from "./routes/players";
import { publicRoutes } from "./routes/public";
import { seasonRoutes } from "./routes/seasons";
import { viewRoutes } from "./routes/views";

const app = new Hono<AppEnv>().basePath("/api");

app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));
app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

/**
 * Request protection: state-changing requests must come from our own origin. Session cookies are
 * SameSite=Lax and the API only accepts JSON (which needs a CORS preflight we never grant), so this is
 * defence in depth against CSRF.
 */
app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    const allowed = new Set([new URL(c.req.url).origin, ...allowedOrigins(c.env, c.env.BETTER_AUTH_URL || new URL(c.req.url).origin)]);
    if (origin && !allowed.has(origin)) throw new HttpError(403, "Cross-origin request blocked.");
    const ct = c.req.header("Content-Type") ?? "";
    const hasBody = c.req.header("Content-Length") !== "0" && c.req.raw.body !== null;
    if (hasBody && !ct.includes("application/json")) throw new HttpError(415, "Requests must be JSON.");
  }
  await next();
});

// Load the session (if any) for every request.
app.use("*", async (c, next) => {
  c.set("user", null);
  if (c.req.header("Cookie")?.includes("better-auth")) {
    const auth = createAuth(c.env, c.req.url);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) {
      const u = session.user as typeof session.user & { role?: string };
      c.set("user", { id: u.id, name: u.name, email: u.email, role: u.role === "admin" ? "admin" : "member" } satisfies SessionUser);
    }
  }
  await next();
});

// Better Auth endpoints. Public sign-up is disabled: accounts are created only via first-admin
// setup or a player invite link (both handled server-side in routes/public.ts).
app.on(["POST"], "/auth/sign-up/*", () => {
  throw new HttpError(403, "Sign-up is by invite only. Ask an admin for an invite link.");
});
app.on(["POST"], "/auth/sign-in/*", async (c, next) => {
  await rateLimit(c, "sign-in", 10, 600);
  await next();
});
app.on(["GET", "POST"], "/auth/*", (c) => createAuth(c.env, c.req.url).handler(c.req.raw));

app.get("/health", (c) => c.json({ ok: true }));

app.route("/", publicRoutes);
app.route("/", viewRoutes);
app.route("/", seasonRoutes);
app.route("/", playerRoutes);
app.route("/", matchDayRoutes);
app.route("/", matchRoutes);
app.route("/", disciplineRoutes);
app.route("/", mvpRoutes);
app.route("/", financeRoutes);
app.route("/", paymentRoutes);
app.route("/", announcementRoutes);
app.route("/", adminRoutes);

const DAILY_CRON = "0 5 * * *";

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, details: err.details }, err.status as 400);
  }
  console.error("Unhandled error", err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

export default {
  fetch: app.fetch,
  /**
   * Crons (see wrangler.jsonc triggers): daily 05:00 UTC creates scheduled match days and opens check-in;
   * every 15 minutes sends match-day check-in reminders 2 hours before kick-off.
   */
  async scheduled(event: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    if (event.cron === DAILY_CRON) ctx.waitUntil(runSchedule(env.DB).then((r) => console.log("schedule", JSON.stringify(r))));
    else ctx.waitUntil(sendCheckinReminders(env).then((r) => r.days > 0 && console.log("reminders", JSON.stringify(r))));
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;

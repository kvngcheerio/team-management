import type { Context } from "hono";

export interface Bindings {
  DB: D1Database;
  APP_ENV: string;
  /** Secret used by Better Auth to sign cookies/tokens. `wrangler secret put BETTER_AUTH_SECRET`. */
  BETTER_AUTH_SECRET: string;
  /** Public origin, e.g. https://matchday.example.com. Falls back to the request origin. */
  BETTER_AUTH_URL?: string;
  /** Extra origins allowed to sign in / send requests (comma-separated), e.g. the workers.dev URL. */
  APP_ORIGINS?: string;
  /** One-time token that authorises creating the first admin. Remove it after setup. */
  SETUP_TOKEN?: string;
  /** Sender for outgoing email, e.g. "Matchday <noreply@pluvialhq.com>". Its domain must be verified in Resend. */
  EMAIL_FROM?: string;
  /** Resend API key: all email is sent through Resend. `wrangler secret put RESEND_API_KEY`. */
  RESEND_API_KEY?: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

export interface Variables {
  user: SessionUser | null;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
export type Ctx = Context<AppEnv>;

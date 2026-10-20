import { betterAuth } from "better-auth";
import type { Bindings } from "./env";
import { HttpError } from "./lib/db";
import { hashPassword, verifyPassword } from "./lib/crypto";

/** Better Auth is created per request because D1 bindings only exist at request time. */
export function createAuth(env: Bindings, requestUrl: string) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new HttpError(500, "Server misconfigured: set the BETTER_AUTH_SECRET secret (at least 32 characters).");
  }
  const baseURL = env.BETTER_AUTH_URL || new URL(requestUrl).origin;
  return betterAuth({
    appName: "Matchday",
    baseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: allowedOrigins(env, baseURL),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    user: {
      additionalFields: {
        // Never accepted from client input; only changed by server-side admin routes.
        role: { type: "string", required: false, defaultValue: "member", input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
    },
    // Rate limiting is done with our D1 limiter (see lib/rate-limit.ts) so it works across isolates.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** The main origin plus any extra ones (custom domain + workers.dev, for example). */
export function allowedOrigins(env: Bindings, baseURL: string): string[] {
  const extra = (env.APP_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return null;
      }
    })
    .filter((o): o is string => Boolean(o));
  return [...new Set([new URL(baseURL).origin, ...extra])];
}

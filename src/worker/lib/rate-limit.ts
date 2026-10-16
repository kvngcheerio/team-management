import type { Ctx } from "../env";
import { HttpError } from "./db";
import { sha256Hex } from "./crypto";

/** Hashed client IP (never stored raw). */
export async function clientKey(c: Ctx): Promise<string> {
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
  return (await sha256Hex(`${c.env.BETTER_AUTH_SECRET}:${ip}`)).slice(0, 32);
}

/** Fixed-window counter in D1; works across isolates and regions. Throws 429 when exceeded. */
export async function rateLimit(c: Ctx, bucket: string, limit: number, windowSeconds: number) {
  const key = `${bucket}:${await clientKey(c)}`;
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = await c.env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if (Math.random() < 0.02) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(windowStart - 86400).run(),
    );
  }
  if ((row?.count ?? 0) > limit) {
    throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.");
  }
}

import { createMiddleware } from "hono/factory";
import type { AppEnv, Ctx, SessionUser } from "../env";
import { HttpError } from "./db";

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) throw new HttpError(401, "Please sign in.");
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) throw new HttpError(401, "Please sign in.");
  if (user.role !== "admin") throw new HttpError(403, "Admins only.");
  await next();
});

export function currentUser(c: Ctx): SessionUser {
  const user = c.get("user");
  if (!user) throw new HttpError(401, "Please sign in.");
  return user;
}

export const isAdmin = (c: Ctx) => c.get("user")?.role === "admin";

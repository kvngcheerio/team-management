import { z } from "zod";
import type { Ctx } from "../env";
import { HttpError } from "./db";

export async function body<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new HttpError(422, `${where}${first?.message ?? "Invalid input."}`, parsed.error.issues);
  }
  return parsed.data;
}

export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
export const zName = z.string().trim().min(1, "Required").max(60);
export const zReason = z.string().trim().max(500).optional().nullable();
export const zId = z.string().min(1).max(64);

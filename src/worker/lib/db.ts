import type { Ctx } from "../env";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 415 | 422 | 429 | 500,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

export async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

export function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

/**
 * Insert `changes()` of the previous statement into a CHECK(ok > 0) table. When the previous
 * conditional UPDATE matched no rows, this fails and D1 rolls back the whole batch.
 */
export function guard(db: D1Database): D1PreparedStatement {
  return db.prepare("INSERT INTO _batch_guard (ok) VALUES (changes())");
}
function guardCleanup(db: D1Database): D1PreparedStatement {
  return db.prepare("DELETE FROM _batch_guard");
}

export class ConflictError extends HttpError {
  constructor(message = "This record was changed by someone else. Refresh and try again.") {
    super(409, message);
  }
}

/** Runs statements atomically. A failed guard surfaces as a 409 conflict. */
export async function atomic(db: D1Database, statements: D1PreparedStatement[], conflictMessage?: string) {
  try {
    return await db.batch([...statements, guardCleanup(db)]);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes("CHECK constraint failed") && msg.includes("ok > 0")) throw new ConflictError(conflictMessage);
    if (msg.includes("UNIQUE constraint failed")) throw new HttpError(409, conflictMessage ?? "That record already exists.");
    throw err;
  }
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  matchDayId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

export function auditStmt(c: Ctx, entry: AuditEntry): D1PreparedStatement {
  const user = c.get("user");
  return stmt(
    c.env.DB,
    `INSERT INTO audit_log (id, actor_user_id, actor_name, action, entity_type, entity_id, match_day_id, reason, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    user?.id ?? null,
    user?.name ?? "system",
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.matchDayId ?? null,
    entry.reason ?? null,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    nowIso(),
  );
}

export async function getSetting(db: D1Database, key: string, fallback: string): Promise<string> {
  const row = await first<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", key);
  return row?.value ?? fallback;
}

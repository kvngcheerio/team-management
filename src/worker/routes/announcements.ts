import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { all, atomic, auditStmt, first, guard, HttpError, newId, nowIso, stmt } from "../lib/db";
import { requireAdmin, requireUser } from "../lib/guards";
import { body } from "../lib/validate";

export const announcementRoutes = new Hono<AppEnv>();

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  pinned: number;
  author_name: string;
  created_at: string;
  updated_at: string;
}
const shape = (a: AnnouncementRow) => ({
  id: a.id,
  title: a.title,
  body: a.body,
  pinned: a.pinned === 1,
  authorName: a.author_name,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
});

export async function latestAnnouncements(db: D1Database, limit: number) {
  const rows = await all<AnnouncementRow>(db, "SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT ?", limit);
  return rows.map(shape);
}

announcementRoutes.get("/announcements", requireUser, async (c) => c.json({ announcements: await latestAnnouncements(c.env.DB, 100) }));

const zAnnouncement = z.object({
  title: z.string().trim().min(1, "Add a title").max(120),
  body: z.string().trim().min(1, "Write something").max(4000),
  pinned: z.boolean().default(false),
});

announcementRoutes.post("/announcements", requireAdmin, async (c) => {
  const input = await body(c, zAnnouncement);
  const db = c.env.DB;
  const id = newId();
  const now = nowIso();
  const user = c.get("user")!;
  await atomic(db, [
    stmt(
      db,
      "INSERT INTO announcements (id, title, body, pinned, author_user_id, author_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.title,
      input.body,
      input.pinned ? 1 : 0,
      user.id,
      user.name,
      now,
      now,
    ),
    auditStmt(c, { action: "announcement.create", entityType: "announcement", entityId: id, after: { title: input.title } }),
  ]);
  return c.json({ announcement: shape((await first<AnnouncementRow>(db, "SELECT * FROM announcements WHERE id = ?", id))!) }, 201);
});

announcementRoutes.patch("/announcements/:id", requireAdmin, async (c) => {
  const input = await body(c, zAnnouncement.partial());
  const db = c.env.DB;
  const a = await first<AnnouncementRow>(db, "SELECT * FROM announcements WHERE id = ?", c.req.param("id"));
  if (!a) throw new HttpError(404, "Announcement not found.");
  await atomic(db, [
    stmt(
      db,
      "UPDATE announcements SET title = ?, body = ?, pinned = ?, updated_at = ? WHERE id = ?",
      input.title ?? a.title,
      input.body ?? a.body,
      input.pinned === undefined ? a.pinned : input.pinned ? 1 : 0,
      nowIso(),
      a.id,
    ),
    auditStmt(c, { action: "announcement.update", entityType: "announcement", entityId: a.id, before: { title: a.title }, after: input }),
  ]);
  return c.json({ announcement: shape((await first<AnnouncementRow>(db, "SELECT * FROM announcements WHERE id = ?", a.id))!) });
});

announcementRoutes.delete("/announcements/:id", requireAdmin, async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  await atomic(db, [
    stmt(db, "DELETE FROM announcements WHERE id = ?", id),
    guard(db),
    auditStmt(c, { action: "announcement.delete", entityType: "announcement", entityId: id }),
  ], "Announcement not found.");
  return c.json({ ok: true });
});

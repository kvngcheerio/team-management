import type { Bindings } from "../env";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendResult = { ok: true; provider: "resend"; id: string | null } | { ok: false; provider: "resend"; error: string };

/** Send one email through Resend (https://resend.com). Never throws: callers record the outcome. */
export async function sendEmail(env: Pick<Bindings, "EMAIL_FROM" | "RESEND_API_KEY">, msg: OutgoingEmail): Promise<SendResult> {
  const from = env.EMAIL_FROM;
  if (!from) return { ok: false, provider: "resend", error: "EMAIL_FROM is not configured" };
  if (!env.RESEND_API_KEY) return { ok: false, provider: "resend", error: "RESEND_API_KEY is not configured" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    });
    const body = await res.text();
    if (res.ok) return { ok: true, provider: "resend", id: (JSON.parse(body) as { id?: string }).id ?? null };
    return { ok: false, provider: "resend", error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, provider: "resend", error: String((err as Error).message ?? err) };
  }
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

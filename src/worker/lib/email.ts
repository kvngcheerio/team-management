import type { Bindings } from "../env";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendResult = { ok: true; provider: "cloudflare" | "resend" } | { ok: false; provider: string; error: string };

/**
 * Send one email. Prefers Cloudflare Email Service (the `EMAIL` send_email binding); falls back to
 * Resend when the binding is missing or rejects the message and `RESEND_API_KEY` is set.
 * Never throws: callers record the outcome. In local dev the binding is only simulated (nothing is
 * delivered), so a RESEND_API_KEY in .dev.vars takes priority there.
 */
export async function sendEmail(env: Pick<Bindings, "EMAIL" | "EMAIL_FROM" | "RESEND_API_KEY"> & { APP_ENV?: string }, msg: OutgoingEmail): Promise<SendResult> {
  const from = env.EMAIL_FROM;
  if (!from) return { ok: false, provider: "none", error: "EMAIL_FROM is not configured" };
  let cfError: string | null = null;
  if (env.EMAIL && !(env.APP_ENV === "development" && env.RESEND_API_KEY)) {
    try {
      await env.EMAIL.send({ from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
      return { ok: true, provider: "cloudflare" };
    } catch (err) {
      const e = err as Error & { code?: string };
      cfError = `${e.code ?? "error"}: ${e.message}`;
    }
  }
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
      });
      if (res.ok) return { ok: true, provider: "resend" };
      return { ok: false, provider: "resend", error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}${cfError ? ` (cloudflare: ${cfError})` : ""}` };
    } catch (err) {
      return { ok: false, provider: "resend", error: String((err as Error).message ?? err) };
    }
  }
  return { ok: false, provider: env.EMAIL ? "cloudflare" : "none", error: cfError ?? "No email provider configured (EMAIL binding or RESEND_API_KEY)" };
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

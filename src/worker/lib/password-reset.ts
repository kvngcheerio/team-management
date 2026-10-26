import type { Bindings } from "../env";
import { getSetting } from "./db";
import { escapeHtml, sendEmail } from "./email";
import { emailLayout } from "./email-layout";

/** Email a password-reset code. Runs in the background (waitUntil), so failures are only logged. */
export async function sendPasswordResetOtp(env: Pick<Bindings, "DB" | "EMAIL_FROM" | "RESEND_API_KEY">, origin: string, to: string, otp: string) {
  const groupName = await getSetting(env.DB, "group_name", "Matchday");
  const sent = await sendEmail(env, passwordResetEmail(to, otp, groupName, origin.replace(/\/$/, ""), new Date()));
  if (!sent.ok) console.error(`password reset email to ${to} failed: ${sent.error}`);
}

export function passwordResetEmail(to: string, otp: string, groupName: string, origin: string, now: Date) {
  const muted = "color:rgba(6,32,16,0.6)";
  const resetUrl = `${origin}/forgot-password?email=${encodeURIComponent(to)}`;
  const subject = `${otp} is your ${groupName} password reset code`;
  const text = [
    `Use this code to reset your ${groupName} password: ${otp}`,
    "",
    `It expires in 10 minutes. Enter it at ${resetUrl}`,
    "",
    "If you didn't ask to reset your password, you can ignore this email; your password stays the same.",
  ].join("\n");
  const html = emailLayout({
    title: subject,
    preheader: `Your password reset code is ${otp}. It expires in 10 minutes.`,
    brand: groupName,
    brandUrl: origin || "#",
    bodyHtml: `<p>Use this code to reset your <b>${escapeHtml(groupName)}</b> password:</p>
<p style="font-size:30px;font-weight:700;letter-spacing:0.3em;margin:18px 0;">${escapeHtml(otp)}</p>
<p>It expires in 10 minutes. Enter it on the <a href="${escapeHtml(resetUrl)}" style="color:#2f5d46;font-weight:600;">reset password</a> page.</p>
<p style="${muted};">If you didn't ask to reset your password, you can ignore this email; your password stays the same.</p>`,
    footerHtml: `You're receiving this because a password reset was requested for your account on ${escapeHtml(groupName)}.<br>
© ${now.getUTCFullYear()} ${escapeHtml(groupName)}`,
  });
  return { to, subject, html, text };
}

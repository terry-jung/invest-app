/**
 * Resend wrapper for transactional email. RESEND_API_KEY and EMAIL_FROM
 * must be set as env vars; we throw on send if either is missing so
 * the route handler can surface a 500 rather than silently dropping.
 */

import { Resend } from "resend";

let _client: Resend | null = null;

function client(): Resend {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set.");
  _client = new Resend(key);
  return _client;
}

function fromAddress(): string {
  const addr = process.env.EMAIL_FROM;
  if (!addr) throw new Error("EMAIL_FROM is not set.");
  return addr;
}

export async function sendMagicLink(toEmail: string, link: string): Promise<void> {
  const ttlMin = 15;
  const subject = "Your invest.app sign-in link";
  const text =
`Click the link below to sign in to invest.app. It expires in ${ttlMin} minutes.

${link}

If you didn't request this, you can safely ignore this email.`;
  const html = `
<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="font-weight:600;font-size:20px;margin-bottom:8px;">Sign in to invest.app</h2>
  <p style="font-size:14px;color:#444;line-height:1.55;margin:0 0 20px;">
    Click the button below to sign in. This link expires in ${ttlMin} minutes.
  </p>
  <p style="margin:0 0 24px;">
    <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;">Sign in</a>
  </p>
  <p style="font-size:12px;color:#888;margin:0;word-break:break-all;">
    Or paste this URL into your browser:<br>${link}
  </p>
  <p style="font-size:12px;color:#888;margin:24px 0 0;">
    If you didn't request this, you can safely ignore this email.
  </p>
</body></html>`;

  const { error } = await client().emails.send({
    from: fromAddress(),
    to: toEmail,
    subject,
    text,
    html,
  });
  if (error) throw new Error(`Resend error: ${error.message ?? JSON.stringify(error)}`);
}

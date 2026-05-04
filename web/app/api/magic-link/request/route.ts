import type { NextRequest } from "next/server";
import { getUserByEmail, isValidEmail } from "@/lib/users";
import { makeMagicToken } from "@/lib/magic-link";
import { sendMagicLink } from "@/lib/email";

export const runtime = "nodejs";

/**
 * Magic-link sign-in: user enters email, we email them a one-time link
 * if (and only if) the email is on a real account. Response is
 * deliberately ambiguous so an attacker can't enumerate accounts.
 */
export async function POST(req: NextRequest) {
  let body: { email?: string };
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const email = (body.email ?? "").toString();
  if (!isValidEmail(email)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const user = getUserByEmail(email);

  // Build the absolute link from the request, so this works on Railway,
  // localhost, preview deployments — without an explicit APP_URL var.
  const proto = req.headers.get("x-forwarded-proto") ?? (req.url.startsWith("https") ? "https" : "http");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const origin = `${proto}://${host}`;

  // Send the email only when the user actually exists. The response
  // shape is identical either way so callers can't tell.
  if (user) {
    try {
      const token = makeMagicToken(user.id);
      const link = `${origin}/api/magic-link/verify?t=${encodeURIComponent(token)}`;
      await sendMagicLink(user.email, link);
    } catch (err) {
      console.error("[magic-link request] send failed:", err);
      // Don't leak the failure to the caller (could be an enum oracle).
      // The user will just not get an email; they can retry.
    }
  }

  // Brief delay to flatten timing differences between "user exists" and
  // "user doesn't exist" branches.
  await new Promise((r) => setTimeout(r, 300));

  return Response.json({ ok: true });
}

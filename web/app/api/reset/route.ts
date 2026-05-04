import type { NextRequest } from "next/server";
import { buildSetCookie, makeSessionToken, SESSION_MAX_AGE_SEC } from "@/lib/auth";
import { getUserByEmail, isValidEmail, isValidPassword, updatePassword } from "@/lib/users";
import { isInviteRedeemable, redeemInvite } from "@/lib/invites";

export const runtime = "nodejs";

/**
 * Password reset, gated by a fresh invite code instead of email-based
 * magic link. Flow:
 *   1. User provides email + invite code + new password
 *   2. We verify email exists AND invite is redeemable
 *   3. Atomically redeem the invite (race-safe)
 *   4. Update the user's password hash
 *   5. Issue a session cookie — they're logged in immediately
 *
 * Step ordering is deliberate: the slow bcrypt hash happens BEFORE
 * any state mutation. If hashing fails we've changed nothing. If the
 * invite redemption fails (race), we've still changed nothing.
 */
export async function POST(req: NextRequest) {
  let body: { email?: string; inviteCode?: string; newPassword?: string };
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const email = (body.email ?? "").toString();
  const inviteCode = (body.inviteCode ?? "").toString().trim().toUpperCase();
  const newPassword = (body.newPassword ?? "").toString();

  if (!isValidEmail(email)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!isValidPassword(newPassword)) {
    return Response.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  if (!inviteCode) {
    return Response.json({ error: "Invite code required." }, { status: 400 });
  }

  const user = getUserByEmail(email);
  if (!user) {
    // Constant-ish delay so existence isn't trivially probeable. The user
    // gets the same message either way.
    await new Promise((r) => setTimeout(r, 400));
    return Response.json({ error: "No account with that email, or invalid invite." }, { status: 400 });
  }
  if (!isInviteRedeemable(inviteCode)) {
    await new Promise((r) => setTimeout(r, 400));
    return Response.json({ error: "No account with that email, or invalid invite." }, { status: 400 });
  }

  // Atomic redemption — survives a race with another reset/signup.
  if (!redeemInvite(inviteCode, user.id, "reset")) {
    return Response.json({ error: "Invite was claimed by someone else just now." }, { status: 409 });
  }

  await updatePassword(user.id, newPassword);

  return new Response(JSON.stringify({ user: { id: user.id, email: user.email } }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildSetCookie(makeSessionToken(user.id), SESSION_MAX_AGE_SEC),
    },
  });
}

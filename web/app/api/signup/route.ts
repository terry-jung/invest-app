import type { NextRequest } from "next/server";
import { buildSetCookie, makeSessionToken, SESSION_MAX_AGE_SEC } from "@/lib/auth";
import { createUser, isValidEmail, isValidPassword } from "@/lib/users";
import { isInviteRedeemable, redeemInvite } from "@/lib/invites";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string; inviteCode?: string };
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const email = (body.email ?? "").toString();
  const password = (body.password ?? "").toString();
  const inviteCode = (body.inviteCode ?? "").toString().trim().toUpperCase();

  if (!isValidEmail(email)) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (!isValidPassword(password)) {
    return Response.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  if (!inviteCode) {
    return Response.json({ error: "Invite code required." }, { status: 400 });
  }
  if (!isInviteRedeemable(inviteCode)) {
    return Response.json({ error: "That invite code is invalid or already used." }, { status: 400 });
  }

  let user;
  try {
    user = await createUser(email, password);
  } catch (err) {
    if (err instanceof Error && err.message === "EMAIL_TAKEN") {
      return Response.json({ error: "An account with that email already exists." }, { status: 409 });
    }
    throw err;
  }

  // Redeem the invite AFTER user creation so we have a real user id to
  // attribute it to. If redemption fails (race: two signups raced for the
  // same code), the second user is created but uninvited — we surface
  // this clearly so the admin can clean up if needed.
  if (!redeemInvite(inviteCode, user.id, "signup")) {
    return Response.json({ error: "Invite was claimed by someone else just now. Try a different code." }, { status: 409 });
  }

  return new Response(JSON.stringify({ user: { id: user.id, email: user.email } }), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildSetCookie(makeSessionToken(user.id), SESSION_MAX_AGE_SEC),
    },
  });
}

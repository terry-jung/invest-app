import type { NextRequest } from "next/server";
import { buildSetCookie, makeSessionToken, SESSION_MAX_AGE_SEC } from "@/lib/auth";
import { verifyUserPassword } from "@/lib/users";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { email?: string; password?: string };
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const email = (body.email ?? "").toString();
  const password = (body.password ?? "").toString();
  if (!email || !password) {
    return new Response("Missing email or password", { status: 400 });
  }

  const user = await verifyUserPassword(email, password);
  if (!user) {
    // Fixed delay so timing doesn't reveal whether the email exists.
    await new Promise((r) => setTimeout(r, 400));
    return new Response("Invalid email or password", { status: 401 });
  }

  return new Response(JSON.stringify({ user: { id: user.id, email: user.email } }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildSetCookie(makeSessionToken(user.id), SESSION_MAX_AGE_SEC),
    },
  });
}

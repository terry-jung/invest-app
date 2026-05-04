import type { NextRequest } from "next/server";
import { buildSetCookie, makeSessionToken, SESSION_MAX_AGE_SEC } from "@/lib/auth";
import { verifyMagicToken } from "@/lib/magic-link";
import { getUserById } from "@/lib/users";

export const runtime = "nodejs";

/**
 * GET /api/magic-link/verify?t=<token>
 *
 * Validates the magic token, sets a session cookie, and 303-redirects
 * to the app root. On failure, redirects to /?magic-link=expired so
 * the UI can show a friendly message.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  const verified = verifyMagicToken(token);

  if (!verified) {
    return Response.redirect(new URL("/?magic-link=expired", url), 303);
  }
  // Make sure the user still exists (could have been deleted between
  // link issuance and click).
  const user = getUserById(verified.userId);
  if (!user) {
    return Response.redirect(new URL("/?magic-link=expired", url), 303);
  }

  const headers = new Headers({ Location: new URL("/?magic-link=ok", url).toString() });
  headers.append("Set-Cookie", buildSetCookie(makeSessionToken(user.id), SESSION_MAX_AGE_SEC));
  return new Response(null, { status: 303, headers });
}

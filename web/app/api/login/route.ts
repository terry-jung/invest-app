import type { NextRequest } from "next/server";
import {
  buildSetCookie,
  makeSessionToken,
  SESSION_MAX_AGE_SEC,
  verifyPassphrase,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { passphrase?: string };
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON", { status: 400 }); }

  const pass = (body.passphrase ?? "").toString();
  if (!pass) return new Response("Missing passphrase", { status: 400 });

  if (!verifyPassphrase(pass)) {
    // Small fixed delay to take the edge off online brute force.
    await new Promise((r) => setTimeout(r, 400));
    return new Response("Invalid passphrase", { status: 401 });
  }

  return new Response(JSON.stringify({ owner: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildSetCookie(makeSessionToken(), SESSION_MAX_AGE_SEC),
    },
  });
}

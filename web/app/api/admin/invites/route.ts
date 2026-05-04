import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/auth";
import { createInvite, listInvites } from "@/lib/invites";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    await new Promise((r) => setTimeout(r, 400));
    return new Response("Forbidden", { status: 403 });
  }
  return Response.json({ invites: listInvites() });
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    await new Promise((r) => setTimeout(r, 400));
    return new Response("Forbidden", { status: 403 });
  }
  let body: { note?: string };
  try { body = await req.json(); } catch { body = {}; }
  const note = body.note ? String(body.note).slice(0, 200) : null;
  const invite = createInvite(note);
  return Response.json({ invite }, { status: 201 });
}

import type { NextRequest } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { getUserById } from "@/lib/users";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const userId = getSessionUserId(req);
  if (!userId) return Response.json({ user: null });
  const user = getUserById(userId);
  if (!user) return Response.json({ user: null });
  return Response.json({ user: { id: user.id, email: user.email } });
}

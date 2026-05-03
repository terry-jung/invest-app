import type { NextRequest } from "next/server";
import { isOwner } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  return Response.json({ owner: isOwner(req) });
}

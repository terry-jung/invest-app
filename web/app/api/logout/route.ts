import type { NextRequest } from "next/server";
import { buildClearCookie } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(_req: NextRequest) {
  return new Response(JSON.stringify({ owner: false }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildClearCookie(),
    },
  });
}

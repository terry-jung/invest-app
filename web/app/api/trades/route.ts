import type { NextRequest } from "next/server";
import { getSessionUserId } from "@/lib/auth";
import { createTrade, listTradesForUser, type Trade } from "@/lib/trades";

export const runtime = "nodejs";

/**
 * GET  /api/trades            — list all trades for the signed-in user
 * POST /api/trades            — create a new trade for the signed-in user
 *
 * The signed-out case returns 401 rather than empty so the client can
 * fall back to a sign-in prompt instead of silently swallowing.
 */

export async function GET(req: NextRequest) {
  const userId = getSessionUserId(req);
  if (!userId) return new Response("Unauthorized", { status: 401 });
  const items = listTradesForUser(userId);
  return Response.json({ items });
}

export async function POST(req: NextRequest) {
  const userId = getSessionUserId(req);
  if (!userId) return new Response("Unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const ticker = String(body.ticker ?? "");
  const action = String(body.action ?? "");
  const trade_date = String(body.trade_date ?? "");
  const price = Number(body.price);
  const shares = Number(body.shares);
  const notes = body.notes != null ? String(body.notes) : null;
  const analysis_id = body.analysis_id != null ? String(body.analysis_id) : null;

  let trade: Trade;
  try {
    trade = createTrade({ userId, ticker, action, trade_date, price, shares, notes, analysis_id });
  } catch (err) {
    const code = err instanceof Error ? err.message : "INVALID";
    const messages: Record<string, string> = {
      INVALID_TICKER: "Enter a valid ticker symbol.",
      INVALID_ACTION: "Action must be buy, trim, or sell.",
      INVALID_DATE: "Date must be YYYY-MM-DD.",
      INVALID_PRICE: "Price must be a positive number.",
      INVALID_SHARES: "Shares must be a positive number.",
    };
    return Response.json({ error: messages[code] ?? "Invalid trade." }, { status: 400 });
  }

  return Response.json({ trade });
}

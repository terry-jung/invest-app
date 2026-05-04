import { addStar, removeStar } from "@/lib/saved";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function PUT(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const auth = requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth;

  const { ticker } = await ctx.params;
  let name: string | undefined;
  try { const body = await req.json(); name = body?.name; } catch { /* optional */ }
  if (!/^[A-Za-z]{1,6}(\.[A-Za-z]{1,2})?$/.test(ticker)) {
    return Response.json({ error: "invalid ticker" }, { status: 400 });
  }
  const entry = await addStar(userId, ticker, name);
  return Response.json({ ticker: ticker.toUpperCase(), ...entry });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const auth = requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth;

  const { ticker } = await ctx.params;
  const ok = await removeStar(userId, ticker);
  return Response.json({ ok });
}

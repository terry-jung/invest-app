import { addStar, removeStar } from "@/lib/saved";

export const runtime = "nodejs";

export async function PUT(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  let name: string | undefined;
  try { const body = await req.json(); name = body?.name; } catch { /* optional */ }
  if (!/^[A-Za-z]{1,6}(\.[A-Za-z]{1,2})?$/.test(ticker)) {
    return Response.json({ error: "invalid ticker" }, { status: 400 });
  }
  const entry = await addStar(ticker, name);
  return Response.json({ ticker: ticker.toUpperCase(), ...entry });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  const ok = await removeStar(ticker);
  return Response.json({ ok });
}

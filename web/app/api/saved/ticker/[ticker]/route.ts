import { deleteTicker } from "@/lib/saved";

export const runtime = "nodejs";

export async function DELETE(_req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  const n = await deleteTicker(ticker);
  return Response.json({ deleted: n });
}

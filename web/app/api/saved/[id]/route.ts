import { getSaved, deleteSaved } from "@/lib/saved";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const item = await getSaved(id);
  if (!item) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(item);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteSaved(id);
  return Response.json({ ok });
}

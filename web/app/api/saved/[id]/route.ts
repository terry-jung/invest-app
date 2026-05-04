import { getSaved, deleteSaved } from "@/lib/saved";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth;

  const { id } = await ctx.params;
  const item = await getSaved(userId, id);
  if (!item) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(item);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth;

  const { id } = await ctx.params;
  const ok = await deleteSaved(userId, id);
  return Response.json({ ok });
}

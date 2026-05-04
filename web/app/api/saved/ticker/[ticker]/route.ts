import { deleteTicker } from "@/lib/saved";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function DELETE(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const auth = requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth;

  const { ticker } = await ctx.params;
  const n = await deleteTicker(userId, ticker);
  return Response.json({ deleted: n });
}

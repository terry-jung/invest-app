import { listSaved, loadStarred } from "@/lib/saved";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth;

  const [items, starred] = await Promise.all([listSaved(userId), loadStarred(userId)]);
  return Response.json({ items, starred });
}

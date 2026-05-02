import { listSaved, loadStarred } from "@/lib/saved";

export const runtime = "nodejs";

export async function GET() {
  const [items, starred] = await Promise.all([listSaved(), loadStarred()]);
  return Response.json({ items, starred });
}

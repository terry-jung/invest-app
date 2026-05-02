import { fetchQuote } from "@/lib/quote";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ticker = url.searchParams.get("ticker");
  if (!ticker) return Response.json({ error: "missing ticker" }, { status: 400 });
  if (!/^[A-Za-z]{1,6}(\.[A-Za-z]{1,2})?$/.test(ticker)) {
    return Response.json({ error: "invalid ticker" }, { status: 400 });
  }
  const q = await fetchQuote(ticker);
  if (!q) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(q);
}

import { saveAnalysis, newId, parsePriceNumber, type SavedAnalysis } from "@/lib/saved";
import { parseReport } from "@/lib/parse";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth;

  let body: { ticker?: string; markdown?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }

  const ticker = (body.ticker ?? "").trim().toUpperCase();
  const markdown = body.markdown ?? "";
  if (!ticker || !markdown) return Response.json({ error: "missing ticker or markdown" }, { status: 400 });

  const parsed = parseReport(markdown);
  const savedAt = new Date().toISOString();
  const id = newId(savedAt);
  const item: SavedAnalysis = {
    id,
    ticker,
    name: parsed.company || ticker,
    savedAt,
    verdict: parsed.verdict,
    qualifier: parsed.verdictQualifier,
    metaLine: parsed.metaLine,
    rangesLine: parsed.rangesLine,
    asOf: parsed.asOf,
    price: parsed.price,
    priceNumber: parsePriceNumber(parsed.price),
    marketCap: parsed.marketCap,
    body: markdown,
  };
  await saveAnalysis(userId, item);
  return Response.json(item);
}

import { query } from "@anthropic-ai/claude-agent-sdk";

export const runtime = "nodejs";
export const maxDuration = 120;

type HunterTicker = {
  symbol: string;
  name: string;
  exchange: string;
  rationale: string;
};

const SYSTEM = `You are a sharp buy-side investment analyst. Given a user's request, recommend exactly 10 publicly-traded tickers ordered from most strongly recommended (rank 1) to least (rank 10).

Output ONLY a single JSON object — no markdown fences, no preamble, no closing meta-commentary, no thinking tags. Output must parse cleanly with JSON.parse() on the entire response.

Required shape:
{"tickers":[{"symbol":"...","name":"...","exchange":"...","rationale":"..."}, ...exactly 10]}

Rules:
- Prefer US-listed equities. If a foreign primary listing is more appropriate, prefix with the appropriate exchange (e.g. "TYO:7203", "ASX:CBA").
- "rationale" is 1–2 sentences max, specific to the user's request — name the catalyst, the moat, the metric, or the mismatch. No generic boilerplate.
- "name" is the company's full legal name.
- "exchange" is the listing exchange (NYSE, NASDAQ, NYSE American, OTC, TYO, ASX, etc.).
- Order matters: ticker 1 must be the strongest fit for the user's request, ticker 10 the weakest of the 10.
- If the user's request is too narrow to find 10 sensible names, fill remaining slots with the next-best adjacent fits and reflect that in the rationale.`;

export async function POST(req: Request) {
  let body: { prompt?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
  const userPrompt = (body.prompt ?? "").trim();
  if (!userPrompt) return Response.json({ error: "missing prompt" }, { status: 400 });
  if (userPrompt.length > 2000) return Response.json({ error: "prompt too long" }, { status: 400 });

  const fullPrompt = `${SYSTEM}\n\nUser's request:\n${userPrompt}`;

  let text = "";
  try {
    for await (const msg of query({
      prompt: fullPrompt,
      options: {
        permissionMode: "bypassPermissions",
        // Pinned to Opus for sharper picks on this reasoning-heavy task.
        // Uses CLI alias so it auto-resolves to whatever Opus is current.
        // Override with HUNTER_MODEL=sonnet (or a full name) if you want to A/B.
        model: process.env.HUNTER_MODEL || "opus",
        // Railway: explicit binary path (see analyze/route.ts comment).
        ...(process.env.CLAUDE_CODE_EXECUTABLE
          ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE }
          : {}),
        stderr: (data: string) => {
          console.error("[claude-cli hunt]", data);
        },
      },
    })) {
      if (req.signal?.aborted) {
        return Response.json({ error: "cancelled" }, { status: 499 });
      }
      if (msg.type === "assistant") {
        const blocks = msg.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string") text += b.text;
        }
      } else if (msg.type === "result") {
        break;
      }
    }
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("[hunt] SDK error:", err);
    return Response.json({ error: m }, { status: 500 });
  }

  // Extract JSON object — agent sometimes wraps in fences despite the prompt.
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return Response.json({ error: "no JSON in response", raw: text }, { status: 502 });
  }
  try {
    const parsed = JSON.parse(match[0]) as { tickers?: HunterTicker[] };
    if (!parsed.tickers || !Array.isArray(parsed.tickers)) {
      return Response.json({ error: "invalid shape", raw: text }, { status: 502 });
    }
    // Light sanitization
    const tickers: HunterTicker[] = parsed.tickers.slice(0, 10).map((t) => ({
      symbol: String(t.symbol ?? "").trim().toUpperCase(),
      name: String(t.name ?? "").trim(),
      exchange: String(t.exchange ?? "").trim(),
      rationale: String(t.rationale ?? "").trim(),
    }));
    return Response.json({ tickers });
  } catch (e) {
    return Response.json({ error: "JSON parse failed", raw: text, detail: String(e) }, { status: 502 });
  }
}

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type QAMessage = { role: "user" | "assistant"; content: string };

type Evt =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; text: string };

function buildSystemPrompt(ticker: string): string {
  const t = ticker || "the ticker covered in the report below";
  return `You are a sharp follow-up analyst for a single ticker: ${t}. The user has just finished reading an investment analysis report on this name (provided below in <report>) and now wants to pressure-test it, fill gaps, or pull fresh information.

GROUND RULES:
1. STAY ON THE TICKER. Only answer questions related to ${t} — its business, financials, market position, peers, sector dynamics, regulatory environment, recent news, valuation, or anything else specific to this company. If asked about unrelated topics (off-topic companies, weather, general advice), politely decline in one sentence and steer back. Comparisons to peers and sector context ARE on-topic.
2. THE REPORT IS A STARTING POINT, NOT A CEILING. Use the report as primary context, but you are NOT limited to it. Use WebSearch freely to pull fresh prices, recent news, latest filings, peer data, macro context — anything that sharpens the answer. The whole point is pressure-testing.
3. DISAGREE WHEN WARRANTED. If fresh data contradicts the report or you spot a weak link in its reasoning, say so directly. The report is one analyst's view; you're an independent check.
4. CITE WHAT YOU FETCH. When you bring in outside info, name the source briefly (e.g. "per the latest 10-Q" or "Bloomberg, ${new Date().toISOString().slice(0, 10)}"). When you reference the report, point to the section.
5. KEEP IT TIGHT. Two to five short paragraphs. Bullets or small tables when they help. No preamble, no closing meta-commentary, no emoji.

The user is informed and reading at a desk — treat them as a peer.`;
}

export async function POST(req: NextRequest) {
  let body: { report?: string; question?: string; history?: QAMessage[]; ticker?: string };
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }

  const reportMd = (body.report ?? "").toString();
  const question = (body.question ?? "").trim();
  const ticker = (body.ticker ?? "").trim().toUpperCase();
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  if (!reportMd || !question) {
    return new Response("Missing report or question", { status: 400 });
  }
  if (question.length > 2000) {
    return new Response("Question too long", { status: 400 });
  }

  // BYOK — same pattern as the analyze route.
  const userKey = req.headers.get("x-anthropic-key")?.trim();
  if (userKey) {
    if (!/^sk-ant-/.test(userKey)) {
      return new Response("Invalid Anthropic API key format", { status: 400 });
    }
    process.env.ANTHROPIC_API_KEY = userKey;
  }

  // Build the contextualised prompt. We bake the report into the system message
  // so the user message is just their question.
  const fullPrompt = [
    `${buildSystemPrompt(ticker)}\n\n<report>\n${reportMd}\n</report>`,
    "",
    history.length > 0 ? "<conversation_history>" : "",
    ...history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`),
    history.length > 0 ? "</conversation_history>" : "",
    "",
    `User question: ${question}`,
  ].filter(Boolean).join("\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let canceled = false;
      let closed = false;
      const send = (evt: Evt) => {
        if (canceled) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)); }
        catch { canceled = true; }
      };
      // Same rationale as analyze route: SSE comments keep Railway's edge
      // proxy from dropping the connection during silent stretches (e.g. a
      // 30s WebSearch call). Comments are ignored by the client parser.
      const heartbeat = setInterval(() => {
        if (canceled || closed) return;
        try { controller.enqueue(encoder.encode(`: keepalive\n\n`)); }
        catch { canceled = true; }
      }, 15_000);
      const safeClose = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      try {
        for await (const message of query({
          prompt: fullPrompt,
          options: {
            permissionMode: "bypassPermissions",
            // Sonnet by default — Q&A is light reasoning, no need for Opus cost.
            // Override with ASK_MODEL=opus in .env.local if desired.
            model: process.env.ASK_MODEL || "sonnet",
            // Railway: explicit binary path (see analyze/route.ts comment).
            ...(process.env.CLAUDE_CODE_EXECUTABLE
              ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE }
              : {}),
            stderr: (data: string) => {
              console.error("[claude-cli ask]", data);
            },
          },
        })) {
          if (canceled) break;
          if (message.type === "assistant") {
            const blocks = message.message?.content ?? [];
            for (const b of blocks) {
              if (b.type === "text" && typeof b.text === "string") {
                send({ type: "delta", text: b.text });
              }
            }
          } else if (message.type === "result") {
            const r = message as { is_error?: boolean; result?: string };
            if (r.is_error) send({ type: "error", text: r.result || "Agent reported an error." });
            send({ type: "done" });
            safeClose();
            return;
          }
        }
        send({ type: "done" });
        safeClose();
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        console.error("[ask] SDK error:", err);
        send({ type: "error", text: m });
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type QAMessage = { role: "user" | "assistant"; content: string };

type Evt =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; text: string };

const SYSTEM = `You are answering follow-up questions about a single specific investment analysis report. The full report markdown is provided below in the <report> tag.

GROUND RULES — non-negotiable:
1. ONLY answer questions that relate to the company, ticker, financials, business model, market position, valuation, risks, catalysts, or analytical framework discussed in this report.
2. If the user asks anything off-topic — weather, unrelated companies the report doesn't cover, general programming, life advice, etc. — politely refuse in one sentence and redirect to the report's content. Don't be lectury about it.
3. Cite specifics from the report when relevant (e.g. "the 18-month horizon", "the 22% implied growth at 15% required return", named catalysts).
4. If the report doesn't contain enough information to answer, say so explicitly. Don't fabricate.
5. Keep answers tight — one to four short paragraphs. Use bullets where they aid clarity. No preamble, no closing meta-commentary, no emoji.

The user is reading this report on a desk and wants to extract more from it — pressure-test the thesis, compare assumptions, get clarification, or stress-test conclusions. Treat them as informed.`;

export async function POST(req: NextRequest) {
  let body: { report?: string; question?: string; history?: QAMessage[] };
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }

  const reportMd = (body.report ?? "").toString();
  const question = (body.question ?? "").trim();
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
    `${SYSTEM}\n\n<report>\n${reportMd}\n</report>`,
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
      const send = (evt: Evt) => {
        if (canceled) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)); }
        catch { canceled = true; }
      };
      try {
        for await (const message of query({
          prompt: fullPrompt,
          options: {
            permissionMode: "bypassPermissions",
            // Sonnet by default — Q&A is light reasoning, no need for Opus cost.
            // Override with ASK_MODEL=opus in .env.local if desired.
            model: process.env.ASK_MODEL || "sonnet",
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
            controller.close();
            return;
          }
        }
        send({ type: "done" });
        controller.close();
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        send({ type: "error", text: m });
        controller.close();
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

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
// Investment analysis can take several minutes. On Railway we run as a
// long-lived Node process so this isn't enforced; the value is here for
// any serverless platforms we might also target.
export const maxDuration = 800;

const TICKER_RE = /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/;

type Evt =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; text: string };

export async function POST(req: NextRequest) {
  let body: { ticker?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const ticker = (body.ticker ?? "").trim().toUpperCase();
  if (!ticker || !TICKER_RE.test(ticker)) {
    return new Response("Invalid ticker", { status: 400 });
  }

  // BYOK: per-request user-supplied API key takes precedence over the server
  // default. Setting process.env at request scope is fine for low concurrency
  // (personal app). The Agent SDK reads ANTHROPIC_API_KEY at each query() call.
  const userKey = req.headers.get("x-anthropic-key")?.trim();
  if (userKey) {
    if (!/^sk-ant-/.test(userKey)) {
      return new Response("Invalid Anthropic API key format", { status: 400 });
    }
    process.env.ANTHROPIC_API_KEY = userKey;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      // `canceled` flips when controller.enqueue() throws, which happens when
      // the client has closed the connection (Cancel button, page navigation).
      // We deliberately do NOT subscribe to req.signal — Next.js dev fires it
      // spuriously and ends the stream before the agent ever produces output.
      let canceled = false;
      const send = (evt: Evt) => {
        if (canceled) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)); }
        catch { canceled = true; }
      };

      try {
        send({ type: "status", text: "Spinning up agent…" });

        const prompt = `Run the investment-analysis skill on ticker ${ticker}.

Use any tools the skill needs (web search, SEC EDGAR, calculators).

OUTPUT FORMAT — strict markdown following this exact structure. Start immediately with the H1, no preamble, no "Sure, here's…", no closing meta-commentary.

# {Full Company Name}
**{Exchange}: {Ticker}** · Investment Analysis · {N}-Month Horizon

> **Verdict: {BUY|HOLD|TRIM|SELL} ({short qualifier, e.g. "with discipline"})**
> Buy zone <\${price} | Full position <\${price} | Trim >\${price}
> As-of: {YYYY-MM-DD}  ·  Price: ~\${price}  ·  Market Cap: ~\${market cap}

## 1. TL;DR — {N}-Month Verdict

One-sentence verdict line restating buy/sell zones in concrete dollar terms.

### Core rationale (Macro → Moat → Valuation → Risks)

Three short paragraphs. Macro context, the actual moat (named, specific), valuation read with implied vs. realized growth, dominant risks.

### If-Then Verdict Matrix

A markdown table with columns: **Category | Belief | Validation Trigger | If Confirmed | If Violated**. Cover at minimum: Macro/Policy, Industry Structure, Demand/Pricing, Supply/Inputs, Execution & Contracts, Competition, Technology/Pipeline, Capital Markets.

**Hard triggers (sell immediately):** one paragraph or compact bullet list — what would force an immediate exit irrespective of price.

## 2. Macroeconomic Overview

Markdown table: **Factor | Direction (Tailwind/Headwind/Neutral) | Reason**.

One sentence on the single most important macro fact for this name right now.

## 3. Business & Industry Overview

One paragraph: what this company actually does and how it makes money in plain English.

### Revenue mix (FY {latest year})

Total revenue and growth, then bullet breakdown by segment/product with $ and % of total.

### How it makes money

One paragraph: pricing model, gross margin, recurring vs. transactional, customer type.

### Industry size & growth

One paragraph: TAM, growth rate, this company's share of that TAM.

### Capex intensity

One paragraph: capex as % of revenue, trajectory, what it's funding.

## 4. Product / Competitive Advantage / Moat

### The moat — what it actually is

Bullet list. Each bullet is a specific, named moat element with durability assessment.

### Erosion vectors

Bullet list. Each bullet is a specific named threat that's eating at the moat right now.

### Peer Comparison Table

Markdown table with at least 3 named peers. Columns: **Metric | {Ticker} | {Peer1} | {Peer2} | {Peer3}**. Rows: Revenue (latest FY $B), Rev Growth YoY, Gross Margin, Net Margin, P/E (fwd), EV/EBITDA, FCF Yield, ROIC, Moat Type.

One sentence "moat readthrough" — why this name trades where it does relative to peers.

## 5. Management & Capital Allocation

CEO + tenure + the one thing they did that mattered.

### Capital allocation pattern (FY {latest year})

Bullets: operating cash flow, capex, dividends, buybacks, net debt, M&A.

### Yellow flags

Bullets. Things that aren't red flags but are worth watching.

One sentence on governance / accounting watchpoints.

## 6. Financial Analysis

Anchor on **owner earnings** (NI + D&A − capex), not EBITDA.

### 5-Year Historical Table

Markdown table. Columns: **Year | Revenue ($B) | Rev Growth | Gross Margin | Net Income ($B) | FCF ($B) | FCF Yield | ROE | Owner EPS**. Rows: last 5 fiscal years.

One paragraph "critical observation" — what jumps out from the trend.

### Major cost drivers

One paragraph naming the top 3.

### Geometric Owner-Earnings Growth Estimate

Show the formula \`g_geo ≈ μ_a − ½ · σ_g²\` and three scenarios (low, base, high) with explicit μ_a and σ_g assumptions. State your base estimate.

## 7. Catalysts, Risks & Timing

### Catalysts (12–36 month horizon)

Markdown table: **Catalyst | Type | Expected Date | Upside if Confirmed**.

### Risks

Markdown table: **Risk | Type | Severity | Probability | Mitigant**.

One sentence on governance/accounting watchpoints if any.

## 8. Valuation

### (A) MOS — Implied-g (geometric, volatility-aware)

Show the math:
- Step 1: derive E_1 (next-year owner earnings per share). Show your assumptions.
- Step 2: implied g* = r − E_1/V at r = 10%, 15%, 20%.
- Step 3: margin of safety in growth-space and value-space.
- Sensitivity: which variable dominates.

### (B) Terminal Sanity Check — Conservative DCF

State assumptions (WACC range, terminal growth range, FCF year-1, growth bands). Then a 3×3 markdown table: **WACC × g_T → fair value (MOS%)**. State base / bear / bull case fair values.

### Adversarial pressure test

One paragraph: stress the worst plausible scenario and what it implies for fair value.

## 9. Conclusion

Verdict paragraph — restate buy/sell discipline and the position-sizing thesis.

### The 2–3 variables that actually decide the outcome

Numbered list, 1 sentence each.

### What would change my mind

- Bullish flip ({rec} → AGGRESSIVE BUY): condition.
- Bearish flip ({rec} → HOLD): condition.
- Sell flip: condition.

### Position sizing guidance

Bullets. Concrete entry tiers, trim levels, what fraction at each.

---

QUALITY BAR
- All tables MUST be proper markdown tables (pipes + dashes), never bullet lists pretending to be tables.
- Numbers must be specific and current. Use WebSearch and SEC EDGAR. No "approximately" where you can compute.
- Cite the as-of date clearly in the header block.
- Use blockquote (\`>\`) only for the verdict block at the top.
- No emoji. No section dividers other than the one before Section 9. No "I think" or "in my opinion" — state your view directly.
- If the ticker is ambiguous, non-US, or the skill genuinely can't complete, output a short H1 + one paragraph explaining and stop.`;

        let sawAnyAssistantText = false;

        for await (const message of query({
          prompt,
          options: {
            // Backend automation: the skill needs WebSearch / Bash etc. without prompts.
            permissionMode: "bypassPermissions",
            // Pinned to Opus for the highest-quality analysis.
            // Override with ANALYZE_MODEL=sonnet in .env.local for cost-conscious runs.
            model: process.env.ANALYZE_MODEL || "opus",
            // On Railway we ship the native CLI as a separate tarball at a
            // known path (see nixpacks.toml) because npm's optional-dep
            // resolution refuses to install Linux binaries on Railway's
            // build container. Falls back to the SDK's normal resolution
            // when the env var isn't set (local dev).
            ...(process.env.CLAUDE_CODE_EXECUTABLE
              ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE }
              : {}),
          },
        })) {
          if (canceled) break;
          if (message.type === "system") {
            send({ type: "status", text: "Agent ready. Researching…" });
            continue;
          }

          if (message.type === "assistant") {
            const blocks = message.message?.content ?? [];
            for (const block of blocks) {
              if (block.type === "text" && typeof block.text === "string") {
                sawAnyAssistantText = true;
                send({ type: "delta", text: block.text });
              } else if (block.type === "tool_use") {
                const name = (block as { name?: string }).name ?? "tool";
                send({ type: "status", text: `Using ${name}…` });
              }
            }
            continue;
          }

          if (message.type === "result") {
            const r = message as { is_error?: boolean; result?: string };
            if (r.is_error) {
              send({
                type: "error",
                text: r.result || "Agent reported an error.",
              });
            } else if (!sawAnyAssistantText && r.result) {
              // Edge case: agent returned only via the result envelope.
              send({ type: "delta", text: r.result });
            }
            send({ type: "done" });
            controller.close();
            return;
          }
        }

        send({ type: "done" });
        controller.close();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ type: "error", text: msg });
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

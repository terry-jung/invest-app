---
name: portfolio-review
description: Review a US-equity portfolio. For each ticker compute owner earnings (NI + D&A − capex from SEC filings), market cap, last-4-quarter owner-earnings YoY growth, and reverse-DCF implied growth at 10% and 15% discount rates (single-stage Gordon + two-stage with 10-year explicit + 2.5% terminal). Add a current macro/geopolitical context note (one shared, plus a per-ticker note), and recommend hold / reduce / expand / sell per ticker on its own merits. Output a markdown summary inline and a dashboard HTML file. Use when the user wants a portfolio review, valuation check, hold/sell/expand recommendation, or implied-growth analysis on US-listed equities.
---

# Portfolio Review

Run a fundamental + macro review of a US-listed equity portfolio and produce a per-ticker recommendation grounded in valuation and current context.

## Inputs

User provides a list of tickers, each with a portfolio share % (weights). Format examples:
- `AAPL 25%, MSFT 20%, NVDA 15%, GOOGL 10%, BRK.B 10%, XOM 8%, JNJ 7%, CASH 5%`
- A table or bullet list with the same info.
- A screenshot of a brokerage holdings page — parse it.

Validate that weights sum to ~100%. Cash and ETFs pass through (skip the SEC analysis, just show in the table). Non-US listings (ADRs without 10-K filers, foreign primaries that file 40-F) — flag and skip the SEC step; you can still pull price and offer a qualitative-only card.

## Process

### 1. Pull fundamentals + price (one Bash call)

Run the helper script in this skill's `scripts/` directory:

```bash
python3 "<skill-dir>/scripts/fundamentals.py" TICKER1 TICKER2 ...
```

It returns one JSON record per ticker with:

- `fundamentals_ttm`: `net_income`, `d_and_a`, `capex`, **`owner_earnings` = NI + D&A − capex** (TTM, summed from the 4 most recent 10-Q/10-K quarterly observations).
- `ni_quarterly_yoy`: last 4 quarters of net income with `{fp, fy, end, val, prior_val, yoy}`.
- **`oe_quarterly_yoy`**: **last 4 quarters of *owner earnings* with YoY**. Per-quarter NI / D&A / capex are reconstructed by decomposing SEC's cumulative-YTD cash-flow values (3-mo / 6-mo / 9-mo / FY) into 3-month increments, since most filers report cash-flow concepts only as YTD cumulative. Use this as the primary growth lens — it's what the user asked for and it differs materially from NI YoY for capex-heavy names (Alphabet, hyperscalers) and capex-light cyclicals (EnerSys cutting capex to prop OE).
- `price`, `shares_outstanding`, `market_cap`, `market_cap_source`. Price comes from Yahoo's chart API. Shares come from a 3-tier SEC EDGAR fallback chain: (1) `dei:EntityCommonStockSharesOutstanding`, (2) `us-gaap:CommonStockSharesOutstanding` summed across share-class axis (handles GOOGL A/B/C, BRK A/B), (3) `us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding` from the latest 10-K (handles DASH and other recent IPOs that don't tag dei). A Yahoo `quoteSummary` fallback exists for cases SEC can't fill, but Yahoo aggressively rate-limits that endpoint — don't rely on it.
- `implied_growth`:
  - `gordon_at_10`, `gordon_at_15` — single-stage `g = r − (OE/MC)`.
  - `two_stage_at_10`, `two_stage_at_15` — explicit 10 yrs at solved-for `g1`, then 2.5% terminal, solved by binary search. **Use two-stage as the primary headline number.**
- `concepts_used` — surfaces which XBRL tags were resolved for NI / D&A / capex (different filers tag D&A and capex differently; transparency for audit).

If the script reports errors for a ticker (no CIK, missing concepts, foreign filer with thin XBRL), surface them in the output rather than hiding.

**Known gaps to handle gracefully:**
- **Foreign private issuers** filing 40-F (e.g. HIVE) have no SEC XBRL fundamentals — fall back to qualitative-only.
- **Pre-revenue biotech** (e.g. NTLA): owner earnings are negative; reverse DCF doesn't apply. Replace the implied-growth box with a "valuation lens: probability-weighted pipeline NPV" note. Quarterly OE YoY can still be informative — shrinking losses (positive YoY on a negative base) signal extending runway.
- **Recent spinoffs** (e.g. SNDK from WDC Feb 2025): trailing TTM and quarterly comparables are distorted. Show absolute $ values + most recent quarter run-rate; flag that trailing reverse-DCF is unreliable.
- **Capex not reported quarterly** (e.g. NVDA): per-quarter OE not derivable. Fall back to NI YoY in the qbar grid with a note. For names where capex is trivially small (NVDA: ~$0.5B vs $96B NI), OE YoY ≈ NI YoY anyway.

### 2. Macro / geopolitical context (web search)

Two layers, both grounded in current web search — never rely on model knowledge alone:

**Shared macro paragraph** (top of report). Fed posture / rates, USD, oil, China posture, AI capex cycle, and any cycle-specific signals. 4–6 sentences. **Do not editorialize about portfolio construction here** — this is market context only.

**Per-ticker note** (in each card). 2–3 sentences on what's specifically moving the name now — named drivers, dates, deals. These anchor the recommendation. Run searches in parallel.

### 3. Recommendation per ticker — single-name only

Reason over three inputs: **implied vs realized growth gap (on owner earnings)**, **fundamental trajectory**, and **macro/geopolitical setup**.

Categories:
- **Expand** — realized OE growth meaningfully exceeds implied (especially at 15% required return) and outlook is supportive.
- **Hold** — implied roughly matches realized, no clear edge either way.
- **Reduce** — implied meaningfully above realized + outlook can support, but the story is still intact.
- **Sell** — implied far above realized, fundamental deceleration, or material macro/geo headwind that breaks the thesis.

**Recommendations are made on each name's own merits.** Do **not** flag concentration as a reason to reduce. Diversification is not a benefit; concentration is not a risk. If a single name passes the implied-vs-realized test on its own merits, it earns its weight regardless of how big it is in the book. The user is explicit on this: do not pad rationales with concentration framing, do not add a "concentration check" banner, do not pitch RSP/diversifiers as a counterweight.

Always show your work. Each card must make it possible for the user to disagree with the recommendation by inspecting the same numbers used to derive it.

When OE growth and NI growth tell different stories (capex-heavy names like GOOGL where AI infra build suppresses OE; capex-cutting names like ENS where falling capex props up OE), the rationale should explicitly call out the divergence and explain what it means.

### 4. Output

**Markdown summary inline** in the response:
- Shared macro paragraph
- Compact per-ticker table: ticker · weight · price · market cap · OE TTM · implied g (two-stage @15%) · realized 4Q OE YoY (latest) · recommendation
- 2–4 short bullets at the end on the most actionable cases — **based purely on the per-name math**, not on weights.

**HTML dashboard** written to:
```
<project-root>/investment-app/output/portfolio-review/<YYYYMMDD>.html
```

**Aesthetic:** Swiss palette (cool light-grey background `#f5f5f7`, white cards, electric blue `#1e40af` for stat numbers, charcoal ink, emerald positive / crimson negative / burnt-orange amber) + Editorial typography (Cormorant Garamond / Georgia serif for titles and tabular numerals, SF Pro / Inter sans-serif for body). No dark mode, no gold borders. The reference style is "FT meets Linear" — restrained, sophisticated, light.

**Required structure:**
1. Title bar: `Portfolio Review · DD Month YYYY` (serif), brand mark.
2. Stat strip: account ID, # positions, current Fed funds, 10-yr UST, hyperscaler capex headline, AI VC headline. **Do not include concentration metrics.**
3. Macro paragraph (one card width, full text, serif body).
4. Card grid (`auto-fill, minmax(460px, 1fr)`). Each card:
   - Header row: ticker (large serif) + weight (small grey, sans-serif tabular) + recommendation pill.
   - Three-cell row: Price · Market cap · OE TTM.
   - Two-box row: implied growth (Gordon at 10/15) · implied growth (two-stage at 10/15).
   - **Quarterly bars** — header `Owner-earnings YoY · last 4 quarters` with a fiscal-cadence subtitle (e.g. "Mar fiscal year-end"). Bars use the **company's own fiscal labels** (Q3 FY25, Q1 FY26, etc.) sorted oldest → newest. For each bar: YoY % big, then `$valQ vs $priorQ` underneath in small grey type. If a quarter is N/A (insufficient prior data, capex-not-quarterly, etc.) show "N/A" or "no prior data" in italics.
   - OE TTM breakdown line: `OE $X = NI $Y + D&A $Z − Capex $W`.
   - Per-ticker macro note (serif paragraph).
   - Rationale callout (serif on light-grey bg with electric-blue left border).
5. Footer: source URLs from the macro searches, plus the note that fundamentals come from SEC EDGAR companyfacts and price from Yahoo Finance.

After writing, output the absolute path so the user can open it.

## Quality bar

- Surface the `concepts_used` mapping when relevant — different filers tag D&A and capex differently and the user should be able to audit.
- If owner earnings TTM is negative or quarterly OE growth solves to the bracket boundary (−50% or +150%), flag that — don't pretend the DCF or growth comparison is meaningful for a money-losing or post-spin name where the model breaks down.
- For names where SEC data is missing (no CIK, foreign primary, recent IPO with thin filings), say so honestly in a `warn` line and fall back to qualitative-only.
- Recommendations must reference specific numbers from this run.
- When OE-YoY and NI-YoY diverge significantly, name the cause (capex spike for AI build, capex cut to prop near-term OE, spinoff distortion, etc.).

## Anti-patterns

- Flagging concentration as a reason to reduce. The user is explicit: don't.
- Pitching diversification or "the obvious place to land trim proceeds is RSP" — out of scope.
- Quoting "implied growth = X%" without saying which discount rate / which method.
- Using single-stage Gordon as the headline when OE/MC > r (which yields a negative implied g) without explaining that the market is pricing decline.
- Recommending a name based purely on macro narrative without grounding in the implied-vs-realized gap.
- Padding the per-ticker note with generic sector-level boilerplate that would apply to any name.
- Forcing calendar-quarter labels (Q1 25, Q2 25) on a fiscal-year company. Use the issuer's fiscal labels.
- Showing quarter bars in fiscal-tag order (Q3, Q1, Q2, Q3) — they must be sorted by end date.

# AI Investment Co-Pilot

Mobile-first Next.js web app for researching US-listed equities with Claude.
Three flows: brainstorm tickers from a free-text prompt, run a deep
nine-section analysis on any single ticker, save and revisit prior runs.

Live: configured for Railway deploy from this repo (root: `web/`).

---

## What it does

- **Brainstorm** — free-text prompt → Claude Opus returns 10 ranked tickers
  with rationale, exchange, and a one-tap _Run Analysis_ on any of them.
- **Analyze** — type a ticker, get a structured nine-section markdown report
  via the investment-analysis skill (Macro → Business → Moat → Management →
  Financials → Catalysts/Risks → Valuation → Conclusion). Renders as a
  verdict banner with BUY/HOLD/TRIM/SELL pill, a price gauge showing
  FULL/BUY/TRIM thresholds against the live quote, plus the full report.
- **Saved** — analyses persist as JSON on disk, grouped by ticker, with
  per-row delta vs the current price. Bookmarked-only tickers also show up
  here. Each saved analysis opens as a full-screen detail panel inside the
  Saved tab (with × close), so the Analyze tab's working state is preserved.

### Notable UI patterns

- **Run queue** — multiple analyses queue and process FIFO. Each completed
  run becomes a numbered "page" with pagination at the top of the Analyze
  tab; previous reports are never auto-replaced and each page has its own
  Q&A history.
- **Follow-up Q&A** — every report has an Ask panel that streams answers
  scoped strictly to that report's content (the system prompt enforces
  topical boundaries).
- **Live quote chip** below the ticker input. Yahoo Finance → Stooq fallback
  on rate-limit, with optional Finnhub.
- **Free-tier + BYOK** — three free analysis trials per browser, then the
  user provides their own Anthropic API key (sent via `x-anthropic-key`
  header). Owner-mode bypass via `?owner=1` URL param or auto-detected on
  localhost.
- **Notifications** — tab-title flash + opt-in browser notifications when
  analyses complete.
- **Section transforms** — the report markdown is post-processed before
  render: the Risks and Catalysts tables become card stacks, the Macro
  Overview groups into Tailwind/Neutral/Headwind cards, the Peer Comparison
  table gets a sticky-Moat-row layout with horizontal scroll, and the
  If-Then Verdict Matrix is moved to a generated Appendix block.
- **Visual style** — Swiss palette (cool grey, electric blue, white cards)
  + editorial typography (Cormorant Garamond serif headings, Inter sans body).

---

## Stack

- **Next.js 15** App Router, **React 19**, **TypeScript**
- **Tailwind v4** + custom CSS tokens
- **@anthropic-ai/claude-agent-sdk** — Claude Opus by default for the
  brainstorm + analyze routes; Sonnet for follow-up Q&A
- **react-markdown** + **remark-gfm** for report rendering
- File-system JSON for saved analyses (env-var configurable path)
- Server-Sent Events for streaming Claude output

---

## Repo layout

```
investment-app/
├── web/                    ← Next.js app (deployable; Railway root)
│   ├── app/
│   │   ├── page.tsx        ← main client component (single-file UI)
│   │   ├── globals.css     ← Swiss + editorial design tokens
│   │   └── api/
│   │       ├── analyze/    ← SSE-streamed deep-dive analysis
│   │       ├── ask/        ← follow-up Q&A scoped to a report
│   │       ├── hunt/       ← brainstorm-prompt → 10 tickers
│   │       ├── quote/      ← live price lookup
│   │       ├── save/, saved/, star/  ← persistence routes
│   ├── lib/
│   │   ├── parse.ts        ← report markdown → verdict snapshot
│   │   ├── sections.ts     ← table classifiers + render-block builder
│   │   ├── saved.ts        ← file-system storage layer
│   │   └── quote.ts        ← Yahoo → Stooq → Finnhub fallback
│   ├── package.json
│   └── railway.toml        ← Railway service config
├── skills/                 ← Claude Code skills used by the routes
│   ├── investment-analysis/
│   ├── value-chain/
│   └── portfolio-review/
├── web-prototypes/         ← static HTML previews used during design iteration
└── README.md
```

---

## Local development

```bash
cd web
npm install
cp .env.example .env.local      # then add your Anthropic key
npm run dev                     # http://localhost:3000
```

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Server-side fallback when the request has no `x-anthropic-key` header. | _required_ for non-BYOK use |
| `SAVED_ANALYSES_DIR` | Absolute path for saved-analysis JSON files. On Railway: `/data/saved-analyses` (mounted volume). | `<repo>/output/saved-analyses` |
| `ANALYZE_MODEL` | Override for the analyze route. | `opus` |
| `ASK_MODEL` | Override for follow-up Q&A. | `sonnet` |
| `FINNHUB_API_KEY` | Optional third-tier quote fallback. | _unset_ |

`ANTHROPIC_API_KEY` is **not** required at the server if every user is
expected to BYOK — the BYOK header overrides it per-request. But for owner
mode and free-trial users, the server needs its own key.

---

## Deploy on Railway

This repo is configured for Railway deployment from `web/`.

1. **New project → Deploy from GitHub** → pick this repo.
2. **Service settings → Root Directory: `web`**. Nixpacks auto-detects Next.js.
3. **Variables**:
   - `ANTHROPIC_API_KEY` — your Anthropic key
   - `SAVED_ANALYSES_DIR` — `/data/saved-analyses`
4. **Volumes → New volume**:
   - Mount path: `/data`
   - Size: 1 GB is plenty for thousands of saves
5. Push to `main` → auto-deploys.

`railway.toml` pins the start command (`npm start`) and a healthcheck on
`/`. The default `npm start` runs `next start` which listens on `$PORT`.

### Why Railway over Vercel

- Saved-analysis storage uses the local filesystem; Railway's persistent
  volumes preserve writes across deploys without a refactor to KV/blob.
- Long Claude streams (1–5 min) run on a long-lived Node process — no
  serverless function timeout (Vercel Hobby caps at 60s, Pro at 300s).

---

## Architecture notes

### Section post-processing

The Claude analysis returns a 9-section markdown report. Before render,
`lib/sections.ts` walks every GFM table in the body and classifies it by
column signature:

- **Risk + Severity columns** → render as risk-card stack in place
- **Catalyst + Upside/Date columns** → render as catalyst-card stack
- **Factor + Direction + Reason** → render as three directional cards
  (Tailwinds / Neutral / Headwinds), each grouping rows with bullets
- **Metric + ≥2 ticker columns** → render as a custom peer table with the
  Moat row pulled to the top and a sticky first column
- **Belief + If Confirmed/Violated** → captured and re-inserted as a
  generated Appendix block at the end of the report

Other tables (Financial / DCF / Historical) pass through to the standard
GFM renderer wrapped in a horizontal-scroll container.

The Catalysts, Risks, and If-Then card stacks are collapsible with an
"Expand · N items" toggle so the reader isn't forced to scroll through
25+ cards to reach the next section.

### Run queue + pagination

- `pagesRef` (mutable) + `pages` state mirror — completed runs append.
- `viewIdx`: `-1` = live stream, `0..N` = a completed page.
- Each page carries its own QA history. When the user navigates between
  pages the Q&A panel switches with them.
- Pages persist to `localStorage` capped at 20 most recent so refresh
  doesn't lose context.

### Saved analyses

Files at `${SAVED_ANALYSES_DIR}/<TICKER>/<id>.json`. Listing is a
recursive scan — fine for the realistic 10–500 saves a single user
accumulates. The bookmarked-only tickers (no analyses saved yet) live in
`${SAVED_ANALYSES_DIR}/_starred.json`.

### Verdict + gauge

The H1 + verdict blockquote at the top of the report is parsed in
`lib/parse.ts` into a structured snapshot — verdict pill, qualifier,
ranges line, as-of, price, market cap. A second regex pass extracts the
FULL / BUY / TRIM thresholds from the ranges line; the gauge maps them
onto a horizontal bar with the live price as the indicator arrow.

---

## License

Personal project. Not currently licensed for redistribution.

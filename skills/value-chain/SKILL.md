---
name: value-chain
description: Map the full value chain of a company or product — upstream (raw inputs, infrastructure, suppliers), the company itself, and downstream (distribution, customers, end users) — plus competitors, complementors, and regulators. Grounded in current web research. Outputs both a Mermaid diagram and a standalone HTML infographic. Use when the user asks to analyze, map, visualize, or understand the value chain, supply chain, ecosystem, or industry structure around a specific company or product.
---

# Value Chain Analysis

Produce a current, well-grounded value chain map for a target company or product. The output is two artifacts: a Mermaid diagram (rendered inline) and a standalone HTML infographic file (saved to disk).

## Inputs

- **Target** (required): a company or product, e.g. "OpenAI", "Tesla Model Y", "TSMC".
- **Context** (optional): a focus or framing the user provides, e.g. "focus on the inference side", "compare to Anthropic", "from a Korean market perspective". Honor it when present; otherwise produce a general map.

If the target is ambiguous (e.g. "Apple" — the fruit industry vs. the company), ask one clarifying question before researching.

## Process

### 1. Research (web-grounded, not memory)

Use WebSearch and WebFetch to ground the analysis in **current** information. Do not rely on model knowledge alone — the user explicitly chose web research because industries shift fast (chip deals, regulatory moves, M&A).

Run searches in parallel where possible. At minimum, gather:

- **Upstream**: what the target consumes — energy, raw materials, components, infrastructure (cloud, chips, data), key suppliers, labor inputs. Go all the way up to primary inputs (energy, minerals, etc.), not just the immediate tier.
- **The target itself**: core product/service, business model, primary value-add.
- **Downstream**: distribution channels, direct customers, end users, derived products built on top.
- **Competitors**: direct (same product/market) and indirect (substitute or adjacent).
- **Complementors**: products/services that increase demand for the target (e.g. for OpenAI: AI-native apps, dev tools, agent frameworks).
- **Regulators & policy**: bodies that meaningfully shape the target's operating environment (e.g. for OpenAI: EU AI Act, US export controls on chips, FTC, state-level laws).

Aim for current named entities (specific company names, specific regulations) rather than generic categories. "NVIDIA H100s and AMD MI300s" beats "GPU suppliers."

### 2. Structure the chain

Organize findings into tiers from most upstream to most downstream. Typical structure (adapt as needed):

```
Tier 0 (primary inputs)    → energy, minerals, capital, labor, data
Tier 1 (infrastructure)    → power grid, cloud, fabs, networks
Tier 2 (components/inputs) → chips, models, datasets, components
Tier 3 (the target)        → the company/product itself
Tier 4 (direct customers)  → businesses, devs, platforms that buy from target
Tier 5 (end users)         → consumers, citizens, downstream apps' users
```

Plus three side clusters:
- **Competitors** (parallel to the target)
- **Complementors** (adjacent, demand-amplifying)
- **Regulators** (governing layer touching multiple tiers)

Don't force the structure — if the target needs more or fewer tiers, adjust. Show the *real* shape of the chain.

### 3. Output: Mermaid diagram

Render a Mermaid `flowchart TD` (top-down) inline in the response. **Order matters: most upstream at the top, most downstream at the bottom.** Tier 0 (primary inputs) → silicon → infrastructure → the target → direct customers → end users. Arrows flow downward. Use subgraphs for tiers and side clusters. Keep node labels short (1–3 words) — detail goes in the HTML.

### 4. Output: HTML infographic — poster style

Write a standalone, self-contained HTML file to:

```
<project-root>/investment-app/output/value-chain/<target-slug>-<YYYYMMDD>.html
```

(Create the directory if missing. Slugify the target — lowercase, hyphens.)

The output is a **poster**, not a text report. Reference aesthetic: SPEAR / Felicis / IoT Analytics value-chain charts — dark theme, gold/accent borders, horizontal tier bands stacked vertically with rotated tier labels on the left, logo-tile grids inside each band.

**Required structure (top to bottom):**
1. Title bar with target name and a brand mark.
2. Stat strip — 5–7 headline numbers (revenue, scale, share, key dates) as compact metrics.
3. Two-column main layout:
   - **Left (main stack)**: tier bands stacked vertically. **Order: most upstream at the top, most downstream at the bottom.** Always: Tier 0 (primary inputs) → Tier 2 (silicon/components) → Tier 1 (infrastructure) → Tier 3 (the target, visually distinct) → Tier 4 (direct customers) → Tier 5 (end users). Flow arrows (▼) between bands reinforce the downward direction.
   - **Right (side clusters)**: three colored panels — Competitors, Complementors, Regulators & policy.
4. Each tier band: rotated vertical label on the left edge, then sub-grouped logo-tile grids inside (e.g. Tier 2 splits into "Foundry & packaging", "AI accelerators", "Networking & memory").
5. The target's band gets distinct treatment — accent border, glow background, big wordmark, inline mini-stats.
6. Footer with all source URLs as a single line of links.

**Visual conventions:**
- Dark navy background (`#0a1020`-ish), gold accent borders (`#c9a96a`), white logo-tiles with brand-color dots, muted gray secondary text.
- Logo tiles: white rounded rectangles with the entity name in bold, optional small subline (e.g. "NVIDIA · ~10 GW · 2H'26"), and a brand-color dot prefix where helpful.
- No real logos required — styled text tiles are the deliberate fallback. If logos are wanted later, use Clearbit's logo API or bundled SVGs.
- Inline CSS only. No external scripts unless rendering Mermaid as a secondary view.
- Date/regulation badges (e.g. "Aug 2026" on EU AI Act) where timing is load-bearing.

After writing the file, output the absolute path so the user can open it.

## Quality bar

- Specificity over generality. Named companies/regulations/products beat categories.
- Currency. If you cite a deal, partnership, or regulation, it should be from the last ~12 months when relevant.
- Honesty about uncertainty. If something isn't clear from search results, say so in the summary rather than fabricating.
- Don't pad. If a tier has only one meaningful entity, don't invent more.

## Anti-patterns

- Generic value chain templates ("suppliers → manufacturer → distributor → retailer → customer") applied without specificity.
- Treating the model's training-data knowledge as current — always verify with search.
- Burying competitors/regulators in the diagram if they're central to the target's reality (e.g. for a defense contractor, regulators *are* the value chain).
- Writing a 5-page essay. The infographic is the deliverable; prose supports it.

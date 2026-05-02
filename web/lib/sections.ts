/**
 * Post-process the structured analysis report markdown into a sequence of
 * renderable sections.
 *
 * Strategy: scan the entire body for GFM tables and classify each by its
 * column signature (NOT by the heading above it — section headings vary
 * and the If-Then matrix in particular lives under an H3, not H2).
 *
 *   - Tables with Risk + Severity columns  → render as risk-card stack
 *     IN PLACE (replacing the cramped table).
 *   - Tables with Belief + (If Confirmed | If Violated | Validation Trigger)
 *     → captured and moved to a new Appendix block placed immediately
 *     after the Sources section.
 *
 * Other tables (Catalysts, Peer Comparison, Historical, DCF grid, etc.)
 * pass through unchanged as plain markdown.
 */

export type RiskRow = {
  risk: string;
  type: string;
  severity: string;
  probability: string;
  mitigant: string;
};

export type CatalystRow = {
  catalyst: string;
  type: string;
  date: string;
  upside: string;
};

export type IfThenRow = {
  category: string;
  belief: string;
  trigger: string;
  ifConfirmed: string;
  ifViolated: string;
};

/**
 * Peer comparison: column 1 is "Metric", remaining columns are ticker
 * symbols. We capture the column order + a row-keyed map of metric →
 * cell-per-ticker so the renderer can pull Moat to the top.
 */
export type PeerTable = {
  tickers: string[];                                  // column order, e.g. ["NVS","LLY",...]
  metrics: { metric: string; values: string[] }[];    // values aligned to tickers
};

/** Macro factor row — direction is the grouping key in the rendered cards. */
export type MacroRow = {
  factor: string;
  direction: string;
  reason: string;
};

export type RenderBlock =
  | { kind: "md"; md: string }
  | { kind: "risks"; risks: RiskRow[] }
  | { kind: "catalysts"; catalysts: CatalystRow[] }
  | { kind: "peer"; table: PeerTable }
  | { kind: "macro"; rows: MacroRow[] }
  | { kind: "ifthen"; rows: IfThenRow[]; heading: string };

/* ------------------------------------------------------------ table parsing */

function parseGfmTable(block: string): { headers: string[]; rows: string[][] } | null {
  const lines = block.trim().split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (lines.length < 2) return null;
  const headerCells = splitRow(lines[0]);
  const sep = lines[1];
  // GFM separator row: pipes + dashes + optional colons + spaces, e.g. `| --- | :-: |`
  if (!/^\|[\s:|-]+\|?\s*$/.test(sep)) return null;
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    if (cells.length === 0) continue;
    rows.push(cells);
  }
  return { headers: headerCells, rows };
}

function splitRow(line: string): string[] {
  const inner = line.replace(/^\|/, "").replace(/\|\s*$/, "");
  return inner.split("|").map((c) => c.trim());
}

/** Loose header match — case-insensitive, ignores all non-letters. */
function normHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

function findCol(headers: string[], names: string[]): number {
  const norms = headers.map(normHeader);
  for (const name of names) {
    const want = normHeader(name);
    const idx = norms.findIndex((h) => h === want || h.includes(want));
    if (idx >= 0) return idx;
  }
  return -1;
}

/* ---------------------------------------------------------- table classifier */

type TableClass = "risks" | "catalysts" | "peer" | "macro" | "ifthen" | null;

/** Quick check that a header string looks like a stock-ticker symbol (1–5 caps). */
function looksLikeTicker(h: string): boolean {
  return /^[A-Z]{1,5}$/.test(h.trim());
}

function classifyHeaders(headers: string[]): TableClass {
  const norms = headers.map(normHeader);
  const hasAny = (...needles: string[]) => norms.some((h) => needles.some((n) => h === n || h.includes(n)));

  // Risks table: must have Risk + Severity.
  if (hasAny("risk") && hasAny("severity")) return "risks";

  // Catalysts table: must have a Catalyst column + an upside/expected date
  // signal. Rules out Peer/Historical tables that also have a "Type" header.
  if (hasAny("catalyst") && (hasAny("upside", "impact", "expecteddate", "date"))) {
    return "catalysts";
  }

  // Macro/factor table: Factor + Direction + Reason columns.
  if (hasAny("factor") && hasAny("direction") && hasAny("reason")) {
    return "macro";
  }

  // Peer comparison: first column is Metric, and ≥2 remaining columns
  // look like uppercase ticker symbols. The H1 is also "Metric" sometimes.
  if (norms[0] === "metric" || norms[0] === "" /* leading-blank metric col */) {
    const tickerCols = headers.slice(1).filter(looksLikeTicker).length;
    if (tickerCols >= 2) return "peer";
  }

  // If-Then matrix.
  if (
    (hasAny("belief", "thesis") || (hasAny("category") && hasAny("validationtrigger", "trigger"))) &&
    hasAny("ifconfirmed", "ifviolated", "validationtrigger", "confirmed", "violated")
  ) {
    return "ifthen";
  }

  return null;
}

function tryPeer(table: { headers: string[]; rows: string[][] }): PeerTable | null {
  // Headers[0] is the metric column label, [1..] are tickers
  const tickers = table.headers.slice(1).map((h) => h.trim());
  if (tickers.length < 2) return null;
  const metrics = table.rows.map((cells) => ({
    metric: (cells[0] || "").trim(),
    values: cells.slice(1, 1 + tickers.length).map((c) => (c || "").trim()),
  })).filter((m) => m.metric.length > 0);
  if (metrics.length === 0) return null;
  return { tickers, metrics };
}

function tryMacro(table: { headers: string[]; rows: string[][] }): MacroRow[] | null {
  const ci = {
    factor: findCol(table.headers, ["factor"]),
    direction: findCol(table.headers, ["direction"]),
    reason: findCol(table.headers, ["reason", "why", "rationale"]),
  };
  if (ci.factor < 0 || ci.direction < 0) return null;
  return table.rows.map((cells) => ({
    factor: cells[ci.factor] || "",
    direction: cells[ci.direction] || "",
    reason: ci.reason >= 0 ? cells[ci.reason] || "" : "",
  }));
}

function tryCatalysts(table: { headers: string[]; rows: string[][] }): CatalystRow[] | null {
  const ci = {
    catalyst: findCol(table.headers, ["catalyst"]),
    type: findCol(table.headers, ["type", "category"]),
    date: findCol(table.headers, ["expecteddate", "date", "timing", "when"]),
    upside: findCol(table.headers, ["upsideifconfirmed", "upside", "impact", "ifconfirmed"]),
  };
  if (ci.catalyst < 0) return null;
  return table.rows.map((cells) => ({
    catalyst: cells[ci.catalyst] || "",
    type: ci.type >= 0 ? cells[ci.type] || "" : "",
    date: ci.date >= 0 ? cells[ci.date] || "" : "",
    upside: ci.upside >= 0 ? cells[ci.upside] || "" : "",
  }));
}

function tryRisks(table: { headers: string[]; rows: string[][] }): RiskRow[] | null {
  const ci = {
    risk: findCol(table.headers, ["risk"]),
    type: findCol(table.headers, ["type", "category"]),
    severity: findCol(table.headers, ["severity", "impact"]),
    probability: findCol(table.headers, ["probability", "likelihood"]),
    mitigant: findCol(table.headers, ["mitigant", "mitigation", "mitigants"]),
  };
  if (ci.risk < 0 || ci.severity < 0) return null;
  return table.rows.map((cells) => ({
    risk: cells[ci.risk] || "",
    type: ci.type >= 0 ? cells[ci.type] || "" : "",
    severity: cells[ci.severity] || "",
    probability: ci.probability >= 0 ? cells[ci.probability] || "" : "",
    mitigant: ci.mitigant >= 0 ? cells[ci.mitigant] || "" : "",
  }));
}

function tryIfThen(table: { headers: string[]; rows: string[][] }): IfThenRow[] | null {
  const ci = {
    category: findCol(table.headers, ["category", "domain", "area"]),
    belief: findCol(table.headers, ["belief", "thesis", "assumption"]),
    trigger: findCol(table.headers, ["validationtrigger", "trigger", "validation"]),
    ifConfirmed: findCol(table.headers, ["ifconfirmed", "confirmed", "ifholds", "holds"]),
    ifViolated: findCol(table.headers, ["ifviolated", "violated", "ifbroken", "broken", "ifwrong"]),
  };
  if (ci.belief < 0) return null;
  return table.rows.map((cells) => ({
    category: ci.category >= 0 ? cells[ci.category] || "" : "",
    belief: cells[ci.belief] || "",
    trigger: ci.trigger >= 0 ? cells[ci.trigger] || "" : "",
    ifConfirmed: ci.ifConfirmed >= 0 ? cells[ci.ifConfirmed] || "" : "",
    ifViolated: ci.ifViolated >= 0 ? cells[ci.ifViolated] || "" : "",
  }));
}

/* --------------------------------------------------------------- table scan */

type TableHit =
  | { kind: "risks"; startLine: number; endLine: number; rows: RiskRow[] }
  | { kind: "catalysts"; startLine: number; endLine: number; rows: CatalystRow[] }
  | { kind: "peer"; startLine: number; endLine: number; table: PeerTable }
  | { kind: "macro"; startLine: number; endLine: number; rows: MacroRow[] }
  | { kind: "ifthen"; startLine: number; endLine: number; rows: IfThenRow[] };

/**
 * For an If-Then table that's getting moved to the Appendix, also absorb
 * the H3 heading that introduces it (e.g. `### If-Then Verdict Matrix`)
 * so it doesn't render as an orphan label in the original section.
 *
 * Walks backward from `start` over blank lines and a single H3 whose text
 * mentions "if-then" / "verdict matrix". Returns the new start line.
 */
function widenIfThenStart(lines: string[], start: number): number {
  let i = start - 1;
  // skip blank lines
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return start;
  const m = lines[i].match(/^###+\s+(.+?)\s*$/);
  if (!m) return start;
  const norm = m[1].toLowerCase().replace(/[^a-z]/g, "");
  if (norm.includes("ifthen") || norm.includes("verdictmatrix")) {
    // Absorb the heading + any preceding blanks too.
    let newStart = i;
    while (newStart > 0 && lines[newStart - 1].trim() === "") newStart--;
    return newStart;
  }
  return start;
}

function scanAllTables(lines: string[]): TableHit[] {
  const hits: TableHit[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*\|/.test(lines[i])) { i++; continue; }
    const start = i;
    while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
    const raw = lines.slice(start, i).join("\n");
    const parsed = parseGfmTable(raw);
    if (!parsed) continue;

    const cls = classifyHeaders(parsed.headers);
    if (cls === "risks") {
      const rows = tryRisks(parsed);
      if (rows && rows.length) hits.push({ kind: "risks", startLine: start, endLine: i, rows });
    } else if (cls === "catalysts") {
      const rows = tryCatalysts(parsed);
      if (rows && rows.length) hits.push({ kind: "catalysts", startLine: start, endLine: i, rows });
    } else if (cls === "peer") {
      const tbl = tryPeer(parsed);
      if (tbl) hits.push({ kind: "peer", startLine: start, endLine: i, table: tbl });
    } else if (cls === "macro") {
      const rows = tryMacro(parsed);
      if (rows && rows.length) hits.push({ kind: "macro", startLine: start, endLine: i, rows });
    } else if (cls === "ifthen") {
      const rows = tryIfThen(parsed);
      if (rows && rows.length) {
        // Absorb the leading H3 heading so it doesn't render as an orphan.
        const widenedStart = widenIfThenStart(lines, start);
        hits.push({ kind: "ifthen", startLine: widenedStart, endLine: i, rows });
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------- block builder */

export function buildRenderBlocks(body: string): RenderBlock[] {
  const lines = body.split("\n");
  const tables = scanAllTables(lines);

  if (tables.length === 0) {
    return [{ kind: "md", md: body }];
  }

  const blocks: RenderBlock[] = [];
  let cursor = 0;
  let capturedIfThen: { rows: IfThenRow[] } | null = null;

  for (const t of tables) {
    // Emit any markdown between cursor and this table.
    const beforeMd = lines.slice(cursor, t.startLine).join("\n");
    pushMd(blocks, beforeMd);

    if (t.kind === "risks") {
      blocks.push({ kind: "risks", risks: t.rows });
    } else if (t.kind === "catalysts") {
      blocks.push({ kind: "catalysts", catalysts: t.rows });
    } else if (t.kind === "peer") {
      blocks.push({ kind: "peer", table: t.table });
    } else if (t.kind === "macro") {
      blocks.push({ kind: "macro", rows: t.rows });
    } else {
      // If-Then: capture and skip — it'll be re-inserted as Appendix.
      capturedIfThen = { rows: t.rows };
    }
    cursor = t.endLine;
  }

  // Trailing markdown after the last table.
  pushMd(blocks, lines.slice(cursor).join("\n"));

  // Splice the If-Then appendix in, immediately after the Sources section.
  // We find the md block whose content contains the `## Sources` heading
  // and split it there so the appendix lands right after Sources.
  if (capturedIfThen) {
    spliceAppendix(blocks, capturedIfThen.rows);
  }

  return blocks;
}

/**
 * Find the md block that contains `## Sources` and split it so the
 * If-Then Appendix block lands immediately after it. If Sources isn't
 * present, append at the very end.
 */
function spliceAppendix(blocks: RenderBlock[], rows: IfThenRow[]) {
  const appendix: RenderBlock = { kind: "ifthen", rows, heading: "If-Then Verdict Matrix" };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "md") continue;
    // Match `## Sources` (with optional trailing words like "and citations").
    const m = b.md.match(/(^|\n)##\s+Sources?\b[^\n]*\n/);
    if (!m) continue;
    // Split the md at the start of the Sources heading. Everything from the
    // heading to the next `## ` heading (or EOF) is the Sources section —
    // appendix slots in right after it.
    const startOfHeading = (m.index ?? 0) + (m[1] ? 1 : 0);
    // Find next `## ` heading after Sources.
    const after = b.md.slice(startOfHeading);
    const nextH2 = after.slice(2).search(/\n##\s+/); // skip the leading `##`
    let endOfSources: number;
    if (nextH2 < 0) {
      endOfSources = b.md.length;
    } else {
      endOfSources = startOfHeading + 2 + nextH2 + 1; // +1 to land on the newline
    }
    const before = b.md.slice(0, endOfSources);
    const trail = b.md.slice(endOfSources);
    const replacement: RenderBlock[] = [{ kind: "md", md: before }, appendix];
    if (trail.trim().length) replacement.push({ kind: "md", md: trail });
    blocks.splice(i, 1, ...replacement);
    return;
  }
  // No Sources section — append at end.
  blocks.push(appendix);
}

function pushMd(blocks: RenderBlock[], md: string) {
  if (!md.trim()) return;
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "md") {
    last.md += (last.md.endsWith("\n") ? "" : "\n") + md;
  } else {
    blocks.push({ kind: "md", md });
  }
}

/* -------------------------------------------------------------- presentation */

/**
 * Bucket a free-text macro "direction" cell into one of three groups so
 * the renderer can split rows into Tailwind / Neutral / Headwind cards.
 * "Mixed" / "Mild" / "Latent" all collapse to their dominant valence;
 * if no signal is found we default to neutral.
 */
export function macroBucket(direction: string): "tailwind" | "neutral" | "headwind" {
  const n = direction.toLowerCase();
  const hasTail = n.includes("tail");
  const hasHead = n.includes("head");
  if (hasTail && !hasHead) return "tailwind";
  if (hasHead && !hasTail) return "headwind";
  if (hasTail && hasHead) return "neutral";    // "mixed" → neutral bucket
  if (n.includes("positive") || n.includes("bull")) return "tailwind";
  if (n.includes("negative") || n.includes("bear")) return "headwind";
  return "neutral";
}

export function sevClass(s: string): string {
  const n = s.toLowerCase();
  if (n.includes("very high") || n.includes("catastrophic") || n.includes("severe")) return "sev-very-high";
  if (n.includes("med") && n.includes("high")) return "sev-med-high";
  if (n === "high" || n.startsWith("high")) return "sev-high";
  if (n.includes("med")) return "sev-medium";
  if (n.includes("low")) return "sev-low";
  return "";
}

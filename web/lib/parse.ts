/**
 * Parse the structured investment-analysis markdown into a verdict-banner
 * snapshot + body. Tolerant of partial streams (early returns null when the
 * H1 isn't there yet).
 */

export type ParsedReport = {
  company: string | null;
  metaLine: string | null;
  verdictBlock: string | null;
  verdict: string | null;
  verdictQualifier: string | null;
  rangesLine: string | null;
  asOfLine: string | null;
  asOf: string | null;        // extracted YYYY-MM-DD
  price: string | null;       // raw e.g. "~$870"
  marketCap: string | null;   // raw e.g. "~$780B"
  body: string;
};

export function parseReport(md: string): ParsedReport {
  const out: ParsedReport = {
    company: null, metaLine: null, verdictBlock: null,
    verdict: null, verdictQualifier: null,
    rangesLine: null, asOfLine: null,
    asOf: null, price: null, marketCap: null,
    body: md,
  };

  const h1 = md.match(/^#\s+(.+?)\s*$/m);
  if (!h1) return out;
  out.company = h1[1].trim();

  const afterH1 = md.slice(h1.index! + h1[0].length);
  const meta = afterH1.match(/^\s*\n([^\n]+)\n/);
  if (meta && /[·|•]/.test(meta[1]) && /\*\*/.test(meta[1])) {
    out.metaLine = meta[1].trim();
  }

  const bq = md.match(/(^>\s.+(?:\n>.*)*)/m);
  if (bq) {
    out.verdictBlock = bq[1];
    const lines = bq[1].split("\n").map(l => l.replace(/^>\s?/, "")).filter(l => l.trim().length);
    if (lines[0]) {
      const v = lines[0].match(/\*\*Verdict:\s*([A-Z]+)(?:\s*\(([^)]*)\))?\*\*/i);
      if (v) {
        out.verdict = v[1].toUpperCase();
        out.verdictQualifier = v[2]?.trim() || null;
      }
    }
    if (lines[1]) out.rangesLine = lines[1].replace(/\*\*/g, "").trim();
    if (lines[2]) {
      out.asOfLine = lines[2].replace(/\*\*/g, "").trim();
      // Extract individual stats from "As-of: 2026-04-30 · Price: ~$870 · Market Cap: ~$780B"
      const stats = out.asOfLine.split(/\s*[·•]\s*/);
      for (const s of stats) {
        const m = s.match(/^([^:]+):\s*(.+)$/);
        if (!m) continue;
        const k = m[1].trim().toLowerCase();
        const v = m[2].trim();
        if (k.startsWith("as-of") || k === "as of") out.asOf = v;
        else if (k === "price") out.price = v;
        else if (k.includes("market cap")) out.marketCap = v;
      }
    }
  }

  const h2 = md.match(/^##\s/m);
  if (h2) out.body = md.slice(h2.index!);
  else if (bq) out.body = md.slice((bq.index ?? 0) + bq[1].length);
  else out.body = afterH1;

  return out;
}

export function pillClass(verdict: string | null): "buy" | "hold" | "trim" | "sell" | "expand" | "neutral" {
  if (!verdict) return "neutral";
  const v = verdict.toLowerCase();
  if (v === "expand" || v === "accumulate") return "expand";
  if (v.includes("buy")) return "buy";
  if (v === "hold") return "hold";
  if (v === "trim" || v === "reduce") return "trim";
  if (v === "sell" || v === "avoid") return "sell";
  return "neutral";
}

/**
 * Pull `Full / Buy / Trim` thresholds out of the verdict ranges line.
 * Returns null if any are missing — caller should fall back to text rendering.
 *
 * Tolerates phrasings like:
 *   "Buy zone <$870 · Full position <$800 · Trim >$1,200"
 *   "Buy zone <$870 | Full position <$800 | Trim >$1,200"
 *   "Full position <$800 | Buy <$870 | Trim aggressively >$1,200"
 */
export function parseThresholds(line: string | null): { full: number; buy: number; trim: number } | null {
  if (!line) return null;
  const num = (s: string) => parseFloat(s.replace(/,/g, ""));
  const full = line.match(/Full(?:\s+position)?\s*[<≤]?\s*\$\s*([\d,]+(?:\.\d+)?)/i);
  const buy  = line.match(/Buy(?:\s+zone)?\s*[<≤]?\s*\$\s*([\d,]+(?:\.\d+)?)/i);
  const trim = line.match(/Trim(?:\s+\w+)?\s*[>≥]?\s*\$\s*([\d,]+(?:\.\d+)?)/i);
  if (!full || !buy || !trim) return null;
  const f = num(full[1]), b = num(buy[1]), t = num(trim[1]);
  if (![f, b, t].every(Number.isFinite)) return null;
  return { full: f, buy: b, trim: t };
}

/** Best-effort numeric extraction for "~$870" / "$1,015.42" / "USD 32.10". */
export function parsePriceValue(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

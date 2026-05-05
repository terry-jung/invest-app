/**
 * Zone bar utilities for the Saved tab.
 *
 * Each saved analysis stores a `rangesLine` like:
 *   "Buy zone <$880 | Full position <$540 | Trim >$1,200"
 *
 * That single string is the source of truth for the buy/trim thresholds
 * on the saved-card zone bar. We parse it once per render; if it can't
 * be parsed (older saves, free-form text), the caller falls back to a
 * "no zones — re-run" UI rather than rendering a misleading bar.
 *
 * Intentionally small and side-effect-free so the same code can be used
 * server-side later (e.g. precomputing status for filter counts).
 */

export type Zones = {
  buyMax: number;   // top of buy zone (exclusive); price < buyMax = buy
  trimMin: number;  // bottom of trim zone (exclusive); price > trimMin = trim
};

export type ZoneStatus = "buy" | "hold" | "trim";

/** Parse a `rangesLine` into thresholds, or null if unparseable. */
export function parseRanges(line: string | null | undefined): Zones | null {
  if (!line) return null;
  // Tolerate "<", "≤", "$", commas, and spaces. We extract any "<$NUM"
  // and ">$NUM" — buyMax is the first "<", trimMin is the first ">".
  const numFrom = (m: RegExpMatchArray | null) => {
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const buyMax = numFrom(line.match(/[<≤]\s*\$?([\d,]+(?:\.\d+)?)/));
  const trimMin = numFrom(line.match(/>\s*\$?([\d,]+(?:\.\d+)?)/));
  if (buyMax == null || trimMin == null) return null;
  if (!(buyMax < trimMin)) return null; // sanity: buy ceiling must be below trim floor
  return { buyMax, trimMin };
}

/** Where the current price falls relative to the zones. */
export function statusFor(price: number, z: Zones): ZoneStatus {
  if (price < z.buyMax) return "buy";
  if (price > z.trimMin) return "trim";
  return "hold";
}

/**
 * Compute the marker's left-position % on the zone bar. Each zone gets
 * a band of equal visual width (33.33%) but the marker only ever
 * occupies the middle 80% of its zone — that gives breathing room
 * around the boundaries so the floating price tag never looks like
 * it's bleeding into the next zone.
 *
 * Buy:  4–30 %
 * Hold: 37–63 %
 * Trim: 70–96 %
 */
export function markerPos(price: number, z: Zones): number {
  if (price < z.buyMax) {
    // Deep in buy = far left; just barely in buy = right edge of buy band.
    const t = Math.max(0, Math.min(1, price / z.buyMax));
    return 4 + t * 26;
  }
  if (price > z.trimMin) {
    // Cap at 1.5× trimMin so a runaway price doesn't peg the marker
    // forever to the right edge with no resolution.
    const upper = z.trimMin * 1.5;
    const t = Math.max(0, Math.min(1, (price - z.trimMin) / (upper - z.trimMin)));
    return 70 + t * 26;
  }
  const t = (price - z.buyMax) / (z.trimMin - z.buyMax);
  return 37 + t * 26;
}

/** Older than `days` from now — used to swap the bar for a re-run CTA. */
export function isStale(savedAtIso: string | null | undefined, days = 90): boolean {
  if (!savedAtIso) return true;
  const t = Date.parse(savedAtIso);
  if (!Number.isFinite(t)) return true;
  const ageMs = Date.now() - t;
  return ageMs > days * 24 * 60 * 60 * 1000;
}

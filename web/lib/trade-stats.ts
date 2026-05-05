/**
 * Pure computation: FIFO cost-basis lot accounting + per-trade
 * discipline grading. No I/O, no DB — takes a list of Trades and
 * (optionally) the analysis's recommended zones, returns enriched
 * per-trade and per-ticker stats.
 *
 * FIFO is the default to match what users see on their broker
 * statements (Fidelity / Schwab / Vanguard / Robinhood all default
 * to FIFO for stocks, which is also what shows up on the 1099-B).
 *
 * If a user logs a Trim/Sell without a prior Buy, the excess shares
 * are silently dropped (we don't know the cost basis) and the row
 * gets a "Untracked entry" grade so they know to log the missing buy.
 */

import type { Trade } from "./trades";
import type { Zones } from "./zones";

export type TradeGrade = {
  kind: "ok" | "warn" | "broke" | "untracked";
  /** One-sentence verdict shown next to the icon. */
  verdict: string;
  /** "Recommendation: Buy <$880" subline. */
  plan: string;
};

export type TradeWithStats = Trade & {
  /** For trim/sell trades: realized $ from the matched lots. */
  realized: number | null;
  /**
   * For buy trades: how many shares from this buy are still held
   * after FIFO consumption from later trims/sells. Zero means
   * fully sold off; the buy is "closed".
   */
  sharesStillHeld: number | null;
  /**
   * For buy trades with sharesStillHeld > 0: unrealized $ at
   * currentPrice. Null if no quote available, or if the buy is
   * fully closed.
   */
  unrealized: number | null;
  /** "Inside buy zone" / "Above trim zone" / etc. */
  grade: TradeGrade;
};

export type TickerStats = {
  ticker: string;
  shares: number;       // total shares currently held
  costBasis: number;    // total cost of currently-held shares (sum of lot.shares × lot.price)
  avgCost: number;      // costBasis / shares (0 if no shares)
  realized: number;     // cumulative realized $ across all closing trades
  unrealized: number | null; // (currentPrice - avgCost) × shares; null if no quote
};

type Lot = { sourceTradeId: string; shares: number; price: number };

/**
 * Walk a single ticker's trades in chronological order, maintaining
 * a FIFO queue of buy lots. For each buy we attach the lot; for
 * each trim/sell we consume from the queue and tally realized.
 *
 * Trades passed in must be for a single ticker. The caller is
 * responsible for grouping by ticker first.
 */
export function computeTickerTrades(
  trades: Trade[],
  zones: Zones | null,
  currentPrice: number | null,
): { trades: TradeWithStats[]; stats: TickerStats } {
  if (trades.length === 0) {
    return {
      trades: [],
      stats: {
        ticker: "",
        shares: 0, costBasis: 0, avgCost: 0,
        realized: 0, unrealized: null,
      },
    };
  }

  // Sort chronologically (FIFO needs earliest first).
  const sorted = [...trades].sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date.localeCompare(b.trade_date);
    return a.created_at.localeCompare(b.created_at);
  });

  const lots: Lot[] = [];
  // Track each buy's lot so we can later read sharesStillHeld off it.
  const lotByTradeId = new Map<string, Lot>();
  // Realized $ per closing-trade-id (so we can attach to the right row).
  const realizedByTradeId = new Map<string, number>();
  // Untracked-shares flag per closing-trade (sold more than was on hand).
  const untrackedByTradeId = new Set<string>();

  let totalRealized = 0;

  for (const t of sorted) {
    if (t.action === "buy") {
      const lot: Lot = { sourceTradeId: t.id, shares: t.shares, price: t.price };
      lots.push(lot);
      lotByTradeId.set(t.id, lot);
    } else {
      // trim or sell — consume from FIFO queue
      let toSell = t.shares;
      let realizedThis = 0;
      while (toSell > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(toSell, lot.shares);
        realizedThis += (t.price - lot.price) * take;
        lot.shares -= take;
        toSell -= take;
        // Float-safe pop: anything below 1e-7 is effectively zero
        if (lot.shares <= 1e-7) lots.shift();
      }
      if (toSell > 1e-7) untrackedByTradeId.add(t.id);
      realizedByTradeId.set(t.id, realizedThis);
      totalRealized += realizedThis;
    }
  }

  // Build the enriched per-trade view (back in original sort order — newest
  // first is what the UI wants, but the caller can reverse if needed).
  const enriched: TradeWithStats[] = sorted.map((t) => {
    if (t.action === "buy") {
      const lot = lotByTradeId.get(t.id);
      const stillHeld = lot ? Math.max(0, lot.shares) : 0;
      const unrealized = (currentPrice != null && stillHeld > 0)
        ? (currentPrice - t.price) * stillHeld
        : null;
      return {
        ...t,
        realized: null,
        sharesStillHeld: stillHeld,
        unrealized,
        grade: gradeTrade(t, zones, untrackedByTradeId.has(t.id)),
      };
    }
    return {
      ...t,
      realized: realizedByTradeId.get(t.id) ?? 0,
      sharesStillHeld: null,
      unrealized: null,
      grade: gradeTrade(t, zones, untrackedByTradeId.has(t.id)),
    };
  });

  // Aggregate ticker stats from current lot state.
  const shares = lots.reduce((s, l) => s + l.shares, 0);
  const costBasis = lots.reduce((s, l) => s + l.shares * l.price, 0);
  const avgCost = shares > 1e-7 ? costBasis / shares : 0;
  const unrealized = (currentPrice != null && shares > 1e-7)
    ? (currentPrice - avgCost) * shares
    : null;

  return {
    trades: enriched,
    stats: {
      ticker: trades[0].ticker,
      shares, costBasis, avgCost,
      realized: totalRealized,
      unrealized,
    },
  };
}

/**
 * Grade a single trade against the analysis's recommended zones.
 *
 * Buy:
 *   ≤ buyMax        → ok    (inside buy zone)
 *   ≤ trimMin       → warn  (above buy, below trim — paying up but not crazy)
 *   > trimMin       → broke (initiating in trim zone)
 * Trim:
 *   ≥ trimMin       → ok    (inside trim zone)
 *   ≥ buyMax        → warn  (early exit between zones)
 *   < buyMax        → broke (trimmed in buy zone — far from plan)
 * Sell:
 *   ≥ trimMin       → ok    (selling above trim, fine)
 *   ≥ buyMax        → warn  (selling between zones)
 *   < buyMax        → broke (selling at a likely loss vs. plan)
 *
 * If zones are unavailable (no parseable rangesLine on the analysis),
 * we can't grade — return a neutral "Untracked".
 */
export function gradeTrade(
  t: Trade,
  zones: Zones | null,
  untracked = false,
): TradeGrade {
  if (untracked) {
    return {
      kind: "untracked",
      verdict: "Untracked entry",
      plan: "No matching buy logged — log it to compute realized P&L.",
    };
  }
  if (!zones) {
    return {
      kind: "untracked",
      verdict: "No recommendation",
      plan: "Analysis didn't include parseable price zones.",
    };
  }
  const fmt = (n: number) => n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
  if (t.action === "buy") {
    if (t.price <= zones.buyMax) {
      return {
        kind: "ok",
        verdict: "Followed recommendation — entered inside buy zone.",
        plan: `Recommendation: Buy <$${fmt(zones.buyMax)}`,
      };
    }
    if (t.price > zones.trimMin) {
      return {
        kind: "broke",
        verdict: `Broke recommendation — bought in trim zone, +$${(t.price - zones.trimMin).toFixed(2)}/sh over plan.`,
        plan: `Recommendation: Buy <$${fmt(zones.buyMax)}`,
      };
    }
    return {
      kind: "warn",
      verdict: `Off recommendation — bought above buy zone, +$${(t.price - zones.buyMax).toFixed(2)}/sh over plan.`,
      plan: `Recommendation: Buy <$${fmt(zones.buyMax)}`,
    };
  }
  if (t.action === "trim") {
    if (t.price >= zones.trimMin) {
      return {
        kind: "ok",
        verdict: "Followed recommendation — trimmed inside trim zone.",
        plan: `Recommendation: Trim >$${fmt(zones.trimMin)}`,
      };
    }
    if (t.price < zones.buyMax) {
      return {
        kind: "broke",
        verdict: "Broke recommendation — trimmed below buy zone, far from plan.",
        plan: `Recommendation: Trim >$${fmt(zones.trimMin)}`,
      };
    }
    return {
      kind: "warn",
      verdict: `Off recommendation — trimmed before trim zone, exited $${(zones.trimMin - t.price).toFixed(2)}/sh early.`,
      plan: `Recommendation: Trim >$${fmt(zones.trimMin)}`,
    };
  }
  // sell
  if (t.price >= zones.trimMin) {
    return {
      kind: "ok",
      verdict: "Followed recommendation — sold above trim zone.",
      plan: `Recommendation: Trim >$${fmt(zones.trimMin)}`,
    };
  }
  if (t.price < zones.buyMax) {
    return {
      kind: "broke",
      verdict: "Broke recommendation — sold below buy zone, likely at a loss.",
      plan: `Recommendation: Trim >$${fmt(zones.trimMin)}`,
    };
  }
  return {
    kind: "warn",
    verdict: "Off recommendation — sold between zones, no clear trigger.",
    plan: `Recommendation: Trim >$${fmt(zones.trimMin)}`,
  };
}

/**
 * Aggregate discipline rate across all trades.
 * "ok" trades count as followed; warn / broke / untracked don't.
 * Returns null if there are zero gradeable trades.
 */
export function disciplineRate(trades: TradeWithStats[]): {
  followed: number;
  total: number;
  pct: number;
  followedPnl: number;
  brokenPnl: number;
} | null {
  const gradeable = trades.filter((t) => t.grade.kind !== "untracked");
  if (gradeable.length === 0) return null;
  const followed = gradeable.filter((t) => t.grade.kind === "ok");
  const broken = gradeable.filter((t) => t.grade.kind === "broke" || t.grade.kind === "warn");

  const sumPnl = (rows: TradeWithStats[]) =>
    rows.reduce((s, t) => s + (t.realized ?? 0) + (t.unrealized ?? 0), 0);

  return {
    followed: followed.length,
    total: gradeable.length,
    pct: Math.round((followed.length / gradeable.length) * 100),
    followedPnl: sumPnl(followed),
    brokenPnl: sumPnl(broken),
  };
}

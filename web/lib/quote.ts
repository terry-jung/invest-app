/**
 * Free quote fetcher with fallback chain:
 *
 *   1) Yahoo Finance v8/chart  — most data, frequently rate-limits
 *   2) Stooq CSV               — OHLCV only, very tolerant rate limits, no key
 *   3) Finnhub /quote          — used only if FINNHUB_API_KEY is set
 *
 * Plus a small in-memory cache (60s) to avoid re-hitting upstreams for
 * multi-quote loads on the same render pass.
 */

export type Quote = {
  ticker: string;
  name: string | null;
  price: number;
  prevClose: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  w52Low: number | null;
  w52High: number | null;
  volume: number | null;
  marketCap: string | null;
  exchange: string | null;
  currency: string | null;
  asOf: string;
  source: "yahoo" | "stooq" | "finnhub";
};

const UA_BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type CacheEntry = { value: Quote | null; expires: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export async function fetchQuote(ticker: string): Promise<Quote | null> {
  const t = ticker.trim().toUpperCase();
  if (!/^[A-Z]{1,6}(\.[A-Z]{1,2})?$/.test(t)) return null;

  const cached = cache.get(t);
  if (cached && cached.expires > Date.now()) return cached.value;

  const sources: Array<() => Promise<Quote | null>> = [
    () => fromYahoo(t),
    () => fromFinnhub(t),
    () => fromStooq(t),
  ];
  for (const fn of sources) {
    try {
      const q = await fn();
      if (q) {
        cache.set(t, { value: q, expires: Date.now() + TTL_MS });
        return q;
      }
    } catch {
      /* try next */
    }
  }
  cache.set(t, { value: null, expires: Date.now() + 15_000 }); // shorter neg-cache
  return null;
}

/* ---------------- Yahoo (primary) ---------------- */
async function fromYahoo(t: string): Promise<Quote | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA_BROWSER, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const meta = r.meta || {};
  const price = meta.regularMarketPrice;
  if (typeof price !== "number") return null;
  return {
    ticker: t,
    name: meta.shortName || meta.longName || null,
    price,
    prevClose: meta.previousClose ?? meta.chartPreviousClose ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    dayHigh: meta.regularMarketDayHigh ?? null,
    w52Low: meta.fiftyTwoWeekLow ?? null,
    w52High: meta.fiftyTwoWeekHigh ?? null,
    volume: meta.regularMarketVolume ?? null,
    marketCap: null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    currency: meta.currency || null,
    asOf: new Date().toISOString(),
    source: "yahoo",
  };
}

/* ---------------- Stooq (fallback, no key) ---------------- */
async function fromStooq(t: string): Promise<Quote | null> {
  // Stooq uses lowercase + .us suffix for US tickers.
  const sym = t.toLowerCase() + ".us";
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA_BROWSER, Accept: "text/csv" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const txt = await res.text();
  // CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const cols = lines[1].split(",");
  if (cols.length < 8) return null;
  const close = parseFloat(cols[6]);
  const open = parseFloat(cols[3]);
  const high = parseFloat(cols[4]);
  const low = parseFloat(cols[5]);
  const vol = parseInt(cols[7], 10);
  if (!Number.isFinite(close) || close <= 0) return null;
  return {
    ticker: t,
    name: null,
    price: close,
    prevClose: Number.isFinite(open) ? open : null,
    dayLow: Number.isFinite(low) ? low : null,
    dayHigh: Number.isFinite(high) ? high : null,
    w52Low: null,
    w52High: null,
    volume: Number.isFinite(vol) ? vol : null,
    marketCap: null,
    exchange: null,
    currency: "USD",
    asOf: new Date().toISOString(),
    source: "stooq",
  };
}

/* ---------------- Finnhub (fallback, optional key) ---------------- */
async function fromFinnhub(t: string): Promise<Quote | null> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const [quoteRes, profileRes] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${key}`),
    fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(t)}&token=${key}`),
  ]);
  if (!quoteRes.ok) return null;
  const q = await quoteRes.json();
  const profile = profileRes.ok ? await profileRes.json() : {};
  if (typeof q.c !== "number" || q.c === 0) return null;
  return {
    ticker: t,
    name: profile.name || null,
    price: q.c,
    prevClose: q.pc ?? null,
    dayLow: q.l ?? null,
    dayHigh: q.h ?? null,
    w52Low: null,
    w52High: null,
    volume: null,
    marketCap: profile.marketCapitalization ? `$${(profile.marketCapitalization / 1000).toFixed(2)}B` : null,
    exchange: profile.exchange || null,
    currency: profile.currency || "USD",
    asOf: new Date().toISOString(),
    source: "finnhub",
  };
}

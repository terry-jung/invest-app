#!/usr/bin/env python3
"""
Pull SEC EDGAR fundamentals and Yahoo price data for a list of US tickers,
compute owner earnings (NI + D&A − capex), market cap, last-4-quarter
net-income YoY growth, and reverse-DCF implied growth at 10% and 15%
discount rates (single-stage Gordon + two-stage 10-yr explicit + 2.5% terminal).

Usage:
  python fundamentals.py AAPL MSFT NVDA
  python fundamentals.py --json AAPL,MSFT,NVDA

Output: JSON to stdout. One object per ticker with all the numbers + any
errors. No third-party deps — urllib only.
"""

from __future__ import annotations
import sys, json, urllib.request, urllib.error, urllib.parse, time
from typing import Any

UA = "investment-app/0.1 (thjung91@gmail.com)"

# ---------- HTTP helpers ----------

def _get(url: str, retries: int = 2, delay: float = 0.4) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    last = None
    for i in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 503): time.sleep(delay * (i + 1)); continue
            raise
        except urllib.error.URLError as e:
            last = e; time.sleep(delay * (i + 1))
    raise last  # type: ignore

def _get_json(url: str) -> Any:
    return json.loads(_get(url))

# ---------- SEC EDGAR ----------

_CIK_CACHE: dict[str, str] = {}

def cik_for(ticker: str) -> str | None:
    if not _CIK_CACHE:
        data = _get_json("https://www.sec.gov/files/company_tickers.json")
        for row in data.values():
            _CIK_CACHE[row["ticker"].upper()] = str(row["cik_str"]).zfill(10)
    return _CIK_CACHE.get(ticker.upper())

def companyfacts(cik: str) -> dict:
    return _get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json")

def _concept_units(facts: dict, concept: str) -> list[dict]:
    """Return USD or shares units list for a us-gaap concept; [] if missing."""
    node = facts.get("facts", {}).get("us-gaap", {}).get(concept)
    if not node: return []
    units = node.get("units", {})
    return units.get("USD") or units.get("shares") or units.get("USD/shares") or []

def _first_concept(facts: dict, concepts: list[str]) -> tuple[str, list[dict]]:
    for c in concepts:
        u = _concept_units(facts, c)
        if u: return c, u
    return "", []

def _ttm_value(units: list[dict], end_date: str | None = None) -> tuple[float | None, list[dict]]:
    """
    Compute TTM by summing the four most recent non-overlapping quarterly observations
    from 10-Q/10-K filings. If only annual data is present, return latest annual.
    Returns (value, the 4 quarters used).
    """
    # Filter to filed reports with start+end (i.e. flow concepts) only.
    # Quarterly: end - start ≈ 90 days. Annual: ≈ 365.
    rows = [r for r in units if r.get("end") and r.get("start") and r.get("form", "").startswith(("10-K","10-Q"))]
    for r in rows:
        s, e = r["start"], r["end"]
        try:
            from datetime import date
            sd = date.fromisoformat(s); ed = date.fromisoformat(e)
            r["_days"] = (ed - sd).days
        except Exception:
            r["_days"] = 0
    quarters = [r for r in rows if 80 <= r["_days"] <= 100]
    annuals  = [r for r in rows if 350 <= r["_days"] <= 380]
    quarters.sort(key=lambda r: r["end"])
    annuals.sort(key=lambda r: r["end"])

    if len(quarters) >= 4:
        last4 = quarters[-4:]
        return sum(r["val"] for r in last4), last4
    # Fall back: latest annual + later quarters minus prior-year quarters
    if annuals and quarters:
        latest_annual = annuals[-1]
        ann_end = latest_annual["end"]
        # any quarters after annual end
        post = [q for q in quarters if q["end"] > ann_end]
        if post:
            # subtract the same-numbered prior-year quarters (approx by start month)
            from datetime import date
            prior = []
            for p in post:
                p_end = date.fromisoformat(p["end"])
                target_year = p_end.year - 1
                match = [q for q in quarters if date.fromisoformat(q["end"]).year == target_year and date.fromisoformat(q["end"]).month == p_end.month]
                if match: prior.append(match[-1])
            ttm = latest_annual["val"] + sum(p["val"] for p in post) - sum(p["val"] for p in prior)
            return ttm, post
        return latest_annual["val"], [latest_annual]
    if annuals:
        return annuals[-1]["val"], [annuals[-1]]
    if quarters:
        # not enough quarters for TTM but report something
        return None, quarters[-4:]
    return None, []

def _last_4_quarters_yoy(units: list[dict]) -> list[dict]:
    """Return [{end, val, yoy}] for the most recent 4 quarters with YoY growth vs prior-year same quarter."""
    from datetime import date
    rows = [r for r in units if r.get("end") and r.get("start") and r.get("form", "").startswith(("10-K","10-Q"))]
    for r in rows:
        try:
            sd = date.fromisoformat(r["start"]); ed = date.fromisoformat(r["end"])
            r["_days"] = (ed - sd).days
        except Exception:
            r["_days"] = 0
    quarters = sorted([r for r in rows if 80 <= r["_days"] <= 100], key=lambda r: r["end"])
    if not quarters: return []
    last4 = quarters[-4:]
    out = []
    for q in last4:
        q_end = date.fromisoformat(q["end"])
        prior = [p for p in quarters if date.fromisoformat(p["end"]).year == q_end.year - 1 and date.fromisoformat(p["end"]).month == q_end.month]
        prior_val = prior[-1]["val"] if prior else None
        yoy = ((q["val"] - prior_val) / abs(prior_val)) if (prior_val not in (None, 0)) else None
        out.append({
            "fp": q.get("fp"), "fy": q.get("fy"), "end": q["end"],
            "val": q["val"], "prior_val": prior_val, "yoy": yoy,
        })
    return out

def _quarterly_series(units: list[dict]) -> dict[str, dict]:
    """Return {end_date_iso: {val, fp, fy, source}} for 3-month (quarterly) values.
    Two passes:
      1) Direct 3-month observations (80–100 days).
      2) For end-dates still missing, derive from cumulative YTD by subtracting
         the immediately-prior cumulative value sharing the same fiscal-year start.
    Cash-flow concepts (D&A, capex) are usually reported only as YTD cumulative —
    pass 2 is what gets us per-quarter D&A and capex.
    """
    from datetime import date
    rows = []
    for r in units:
        if not (r.get("end") and r.get("start") and r.get("form","").startswith(("10-K","10-Q"))):
            continue
        try:
            sd = date.fromisoformat(r["start"]); ed = date.fromisoformat(r["end"])
        except Exception:
            continue
        rows.append({**r, "_sd": sd, "_ed": ed, "_days": (ed - sd).days})
    if not rows: return {}

    out: dict[str, dict] = {}
    # Pass 1: direct 3-month
    for r in rows:
        if 80 <= r["_days"] <= 100:
            existing = out.get(r["end"])
            this_filed = r.get("filed", "")
            if existing is None or this_filed > (existing.get("filed") or ""):
                out[r["end"]] = {"val": r["val"], "filed": this_filed,
                                 "fp": r.get("fp"), "fy": r.get("fy"), "source": "direct"}

    # Pass 2: derive from cumulative YTD
    by_start: dict[str, list] = {}
    for r in rows:
        by_start.setdefault(r["start"], []).append(r)
    for s, items in by_start.items():
        # latest filing wins per (start, days) bucket
        dedup: dict[int, dict] = {}
        for r in items:
            key = r["_days"]
            existing = dedup.get(key)
            if existing is None or r.get("filed","") > existing.get("filed",""):
                dedup[key] = r
        ordered = sorted(dedup.values(), key=lambda r: r["_days"])
        prev_val = 0.0
        prev_end_iso = s
        for r in ordered:
            inc = r["val"] - prev_val
            try:
                period_days = (r["_ed"] - date.fromisoformat(prev_end_iso)).days
            except Exception:
                period_days = 0
            if 80 <= period_days <= 100 and r["end"] not in out:
                out[r["end"]] = {"val": inc, "filed": r.get("filed",""),
                                 "fp": r.get("fp"), "fy": r.get("fy"), "source": "derived"}
            prev_val = r["val"]
            prev_end_iso = r["end"]
    return out

def _quarterly_oe_yoy(ni_units, da_units, cx_units) -> list[dict]:
    """Compute quarterly owner-earnings (NI + D&A − Capex) for up to last 8 quarters,
    then return last 4 with YoY vs prior-year same fiscal quarter."""
    from datetime import date
    ni_q = _quarterly_series(ni_units)
    da_q = _quarterly_series(da_units)
    cx_q = _quarterly_series(cx_units)
    all_ends = sorted(set(ni_q) | set(da_q) | set(cx_q))
    rows = []
    for e in all_ends:
        ni = ni_q.get(e, {}).get("val")
        da = da_q.get(e, {}).get("val")
        cx = cx_q.get(e, {}).get("val")
        oe = (ni + da - cx) if None not in (ni, da, cx) else None
        meta = ni_q.get(e) or da_q.get(e) or cx_q.get(e) or {}
        rows.append({"end": e, "ni": ni, "da": da, "capex": cx, "oe": oe,
                     "fp": meta.get("fp"), "fy": meta.get("fy")})
    pool = rows[-8:]
    out = []
    for q in pool[-4:]:
        q_end = date.fromisoformat(q["end"])
        prior = None
        for p in pool:
            if p["end"] == q["end"]: continue
            try:
                p_end = date.fromisoformat(p["end"])
            except Exception: continue
            if p_end.year == q_end.year - 1 and abs(p_end.month - q_end.month) <= 1:
                prior = p; break
        prior_oe = prior["oe"] if prior else None
        oe_yoy = ((q["oe"] - prior_oe) / abs(prior_oe)) if (q["oe"] is not None and prior_oe not in (None, 0)) else None
        out.append({**q, "prior_oe": prior_oe, "oe_yoy": oe_yoy,
                    "prior_end": prior["end"] if prior else None})
    return out

def _shares_outstanding(facts: dict) -> float | None:
    """Latest reported shares outstanding. Tries dei single-class first; falls back to
    us-gaap:CommonStockSharesOutstanding summed across share classes (e.g. GOOGL A/B/C).
    """
    dei = facts.get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding")
    if dei:
        units = dei.get("units", {}).get("shares", [])
        if units:
            units = sorted(units, key=lambda r: r.get("end") or r.get("filed") or "")
            return float(units[-1]["val"])
    # Multi-class fallback: us-gaap:CommonStockSharesOutstanding (and Issued)
    for concept in ("CommonStockSharesOutstanding", "CommonStockSharesIssued"):
        node = facts.get("facts", {}).get("us-gaap", {}).get(concept)
        if not node: continue
        units = node.get("units", {}).get("shares", [])
        if not units: continue
        by_end: dict[str, float] = {}
        latest_filed: dict[str, str] = {}
        for r in units:
            end = r.get("end")
            if not end: continue
            filed = r.get("filed", "")
            if filed > latest_filed.get(end, ""):
                latest_filed[end] = filed
        for r in units:
            end = r.get("end")
            if not end: continue
            if r.get("filed", "") != latest_filed.get(end, ""): continue
            by_end.setdefault(end, 0.0)
            by_end[end] += float(r["val"])
        if by_end:
            latest_end = max(by_end.keys())
            return by_end[latest_end]
    # Last-resort fallback: weighted-average shares from the latest annual income statement.
    # Less precise than end-of-period shares but close enough for market cap when the issuer
    # doesn't tag dei:EntityCommonStockSharesOutstanding (e.g. DoorDash).
    for concept in ("WeightedAverageNumberOfDilutedSharesOutstanding",
                    "WeightedAverageNumberOfSharesOutstandingBasic"):
        node = facts.get("facts", {}).get("us-gaap", {}).get(concept)
        if not node: continue
        units = node.get("units", {}).get("shares", [])
        if not units: continue
        from datetime import date
        annuals = []
        for r in units:
            try:
                sd = date.fromisoformat(r.get("start","")); ed = date.fromisoformat(r.get("end",""))
                days = (ed - sd).days
            except Exception:
                continue
            if 350 <= days <= 380 and r.get("form","").startswith("10-K"):
                annuals.append(r)
        if annuals:
            annuals.sort(key=lambda r: r["end"])
            return float(annuals[-1]["val"])
    return None

def yahoo_quote_summary(ticker: str) -> dict:
    """Yahoo v10 quoteSummary fallback for marketCap / sharesOutstanding when SEC is incomplete."""
    url = (f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/"
           f"{urllib.parse.quote(ticker)}?modules=price,defaultKeyStatistics")
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
    except Exception:
        return {}
    result = (data.get("quoteSummary") or {}).get("result") or []
    if not result: return {}
    q = result[0]
    price_m = q.get("price") or {}
    stats = q.get("defaultKeyStatistics") or {}
    def _raw(d, k): return ((d.get(k) or {}).get("raw")) if isinstance(d.get(k), dict) else d.get(k)
    return {
        "market_cap": _raw(price_m, "marketCap"),
        "shares_outstanding": _raw(stats, "sharesOutstanding"),
    }

# ---------- Price ----------

def yahoo_price(ticker: str) -> dict:
    """Returns {price, currency, market_cap (if available), shares (if returned)} via Yahoo chart API."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ticker)}?interval=1d&range=5d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())
    res = data.get("chart", {}).get("result", [None])[0]
    if not res: raise RuntimeError(f"no chart data for {ticker}")
    meta = res.get("meta", {})
    return {
        "price": meta.get("regularMarketPrice"),
        "currency": meta.get("currency"),
        "exchange": meta.get("exchangeName"),
    }

# ---------- DCF ----------

def gordon_implied_g(oe_ttm: float, market_cap: float, r: float) -> float | None:
    if oe_ttm is None or market_cap is None or oe_ttm == 0: return None
    return r - (oe_ttm / market_cap)

def two_stage_implied_g(oe_ttm: float, market_cap: float, r: float, g_term: float = 0.025, n: int = 10) -> float | None:
    """Solve for explicit-period growth g1 such that PV equals market_cap."""
    if oe_ttm is None or market_cap is None or oe_ttm <= 0: return None
    if r <= g_term: return None

    def pv(g1: float) -> float:
        total = 0.0
        oe = oe_ttm
        for t in range(1, n + 1):
            oe = oe * (1 + g1)
            total += oe / ((1 + r) ** t)
        terminal = oe * (1 + g_term) / (r - g_term)
        total += terminal / ((1 + r) ** n)
        return total

    lo, hi = -0.50, 1.50
    if pv(lo) > market_cap: return lo
    if pv(hi) < market_cap: return hi
    for _ in range(80):
        mid = (lo + hi) / 2
        if pv(mid) < market_cap: lo = mid
        else: hi = mid
    return (lo + hi) / 2

# ---------- Per-ticker pipeline ----------

def analyze(ticker: str) -> dict:
    out: dict = {"ticker": ticker.upper(), "errors": []}
    try:
        cik = cik_for(ticker)
        if not cik:
            out["errors"].append(f"no SEC CIK for {ticker} (non-US listing?)"); return out
        out["cik"] = cik
        facts = companyfacts(cik)
        out["name"] = facts.get("entityName")

        ni_concept, ni_units = _first_concept(facts, ["NetIncomeLoss"])
        da_concept, da_units = _first_concept(facts, [
            "DepreciationDepletionAndAmortization",
            "DepreciationAndAmortization",
            "Depreciation",
        ])
        cx_concept, cx_units = _first_concept(facts, [
            "PaymentsToAcquirePropertyPlantAndEquipment",
            "PaymentsToAcquireProductiveAssets",
        ])

        ni_ttm, ni_q4 = _ttm_value(ni_units)
        da_ttm, _ = _ttm_value(da_units)
        cx_ttm, _ = _ttm_value(cx_units)
        owner_earnings_ttm = None
        if None not in (ni_ttm, da_ttm, cx_ttm):
            owner_earnings_ttm = ni_ttm + da_ttm - cx_ttm  # capex is reported as negative cash; SEC presents as positive — subtract

        # Last 4Q NI with YoY
        ni_quarters = _last_4_quarters_yoy(ni_units)
        # Last 4Q OE with YoY (NI + D&A − Capex per quarter, paired against prior-year same quarter)
        oe_quarters = _quarterly_oe_yoy(ni_units, da_units, cx_units)

        # Price + market cap
        px = yahoo_price(ticker)
        shares = _shares_outstanding(facts)
        market_cap = (px["price"] * shares) if (px.get("price") and shares) else None
        mc_source = "sec_x_yahoo_price" if market_cap else None
        # Yahoo fallback for missing shares / market cap
        if not market_cap:
            yq = yahoo_quote_summary(ticker)
            if not shares and yq.get("shares_outstanding"):
                shares = float(yq["shares_outstanding"])
                if px.get("price"):
                    market_cap = px["price"] * shares
                    mc_source = "yahoo_shares_x_price"
            if not market_cap and yq.get("market_cap"):
                market_cap = float(yq["market_cap"])
                mc_source = "yahoo_market_cap"

        out.update({
            "concepts_used": {"NI": ni_concept, "DA": da_concept, "CAPEX": cx_concept},
            "fundamentals_ttm": {
                "net_income": ni_ttm,
                "d_and_a": da_ttm,
                "capex": cx_ttm,
                "owner_earnings": owner_earnings_ttm,
            },
            "ni_quarterly_yoy": ni_quarters,
            "oe_quarterly_yoy": oe_quarters,
            "price": px.get("price"),
            "currency": px.get("currency"),
            "exchange": px.get("exchange"),
            "shares_outstanding": shares,
            "market_cap": market_cap,
            "market_cap_source": mc_source,
        })

        if owner_earnings_ttm and market_cap:
            out["implied_growth"] = {
                "gordon_at_10": gordon_implied_g(owner_earnings_ttm, market_cap, 0.10),
                "gordon_at_15": gordon_implied_g(owner_earnings_ttm, market_cap, 0.15),
                "two_stage_at_10": two_stage_implied_g(owner_earnings_ttm, market_cap, 0.10),
                "two_stage_at_15": two_stage_implied_g(owner_earnings_ttm, market_cap, 0.15),
                "assumptions": {"explicit_years": 10, "terminal_growth": 0.025},
            }
        else:
            out["errors"].append("could not compute implied growth (missing OE or market cap)")
    except Exception as e:
        out["errors"].append(f"{type(e).__name__}: {e}")
    return out

# ---------- CLI ----------

def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    if not args:
        print("usage: fundamentals.py TICKER [TICKER ...]", file=sys.stderr); return 2
    tickers: list[str] = []
    for a in args:
        tickers.extend([t.strip().upper() for t in a.split(",") if t.strip()])
    results = []
    for t in tickers:
        results.append(analyze(t))
        time.sleep(0.15)  # polite to SEC
    print(json.dumps({"results": results}, indent=2, default=str))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))

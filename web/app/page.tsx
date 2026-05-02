"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseReport, pillClass, parseThresholds, parsePriceValue, type ParsedReport } from "@/lib/parse";
import { buildRenderBlocks, sevClass, macroBucket, type RenderBlock } from "@/lib/sections";
import type { SavedAnalysis } from "@/lib/saved";
import type { Quote } from "@/lib/quote";

type RunState = "idle" | "running" | "done" | "error";
type View = "hunter" | "run" | "saved";
type SaveState = "idle" | "saving" | "saved" | "error";
type HuntState = "idle" | "prompting" | "thinking" | "done" | "error";

type HunterTicker = {
  symbol: string;
  name: string;
  exchange: string;
  rationale: string;
};

type StarredEntry = { name: string; starredAt: string };
type StarredMap = Record<string, StarredEntry>;

type QAMessage = { role: "user" | "assistant"; content: string };
type ReportPage = {
  id: string;
  ticker: string;
  body: string;
  completedAt: string; // ISO
  savedAt?: string;    // ISO — set when the user saves this page in this session
  qa?: QAMessage[];    // per-page follow-up Q&A history
};

// Dry desk humor while the agent does the real work. Cycles every ~3.5s.
const QUIPS = [
  "Reading the footnotes nobody reads…",
  "Asking SEC EDGAR if it's been hydrated today…",
  "Triangulating sell-side targets, then ignoring them…",
  "Discounting future cash flows back to this exact second…",
  "Computing what Munger would mutter…",
  "Decoding management euphemisms…",
  "Subtracting maintenance capex from optimism…",
  "Squinting at the segment reporting table…",
  "Reconciling GAAP with what the CFO said on TV…",
  "Listening to the earnings call so you don't have to…",
  "Probing the moat for soft spots…",
  "Cross-checking guidance against the whisper number…",
  "Translating 'headwinds' into actual basis points…",
  "Wondering if buybacks count as growth…",
  "Counting the receivables twice. Then again…",
  "Stress-testing the bull case for sanity…",
  "Reading 10-Q footnote 14, the boring one…",
  "Trying to pronounce 'goodwill impairment' cleanly…",
  "Compounding skepticism at 10% annually…",
  "Interrogating the cash conversion cycle…",
  "Recalculating, just to feel something…",
  "Pretending to understand stock-based comp…",
  "Eyeing the inventory days like a hawk…",
  "Diluting EPS for fun and for honesty…",
];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TRASH_SVG = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" /><path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);
const CHEV_SVG = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

const fmt2 = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtVol = (n: number) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
const fmtRel = (iso: string) => {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function deltaParts(prev: number, curr: number) {
  const d = curr - prev;
  const p = (d / prev) * 100;
  const isPos = d >= 0;
  return {
    isPos,
    abs: "$" + fmt2(Math.abs(d)),
    pct: (isPos ? "+" : "−") + Math.abs(p).toFixed(2) + "%",
    arrow: isPos ? "↑" : "↓",
  };
}

export default function Page() {
  // ---------- view ----------
  const [view, setView] = useState<View>("hunter");

  // ---------- starred tickers ----------
  const [starred, setStarred] = useState<StarredMap>({});
  const [savingStar, setSavingStar] = useState<Set<string>>(new Set());

  // ---------- run state ----------
  const [ticker, setTicker] = useState("");
  const [report, setReport] = useState("");
  const [status, setStatus] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const abortRef = useRef<AbortController | null>(null);
  const startedAt = useRef<number>(0);
  const [elapsed, setElapsed] = useState(0);
  const [quipIdx, setQuipIdx] = useState(0);
  const [quipFade, setQuipFade] = useState(true);
  const [spinFrame, setSpinFrame] = useState(0);

  // ---------- ticker chip ----------
  type ChipState = "empty" | "loading" | "valid" | "invalid";
  const [chipState, setChipState] = useState<ChipState>("empty");
  const [chipQuote, setChipQuote] = useState<Quote | null>(null);
  const chipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------- lookup card ----------
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupQuote, setLookupQuote] = useState<Quote | null>(null);

  // ---------- saved view ----------
  const [saved, setSaved] = useState<SavedAnalysis[]>([]);
  const [liveQuotes, setLiveQuotes] = useState<Record<string, Quote | null>>({});
  const [openTickers, setOpenTickers] = useState<Set<string>>(new Set());
  const [confirmRowId, setConfirmRowId] = useState<string | null>(null);
  const [confirmTicker, setConfirmTicker] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removingTicker, setRemovingTicker] = useState<string | null>(null);

  // ---------- saved-view-mode (loaded saved analysis) ----------
  const [savedMode, setSavedMode] = useState<SavedAnalysis | null>(null);
  // Q&A buffer for the saved-detail panel. Ephemeral — cleared when the
  // user closes the detail or opens a different saved analysis.
  const [savedQA, setSavedQA] = useState<QAMessage[]>([]);

  // ---------- save button ----------
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAtTime, setSavedAtTime] = useState<string>("");

  // ---------- notifications ----------
  // Two-layer: (a) tab title flash always on, no permission required;
  // (b) native browser notification — opt-in via the bell button.
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission>("default");
  const notifyEnabledRef = useRef(false);
  useEffect(() => { notifyEnabledRef.current = notifyEnabled; }, [notifyEnabled]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const perm = Notification.permission;
    setNotifyPermission(perm);
    let wantEnabled = false;
    try { wantEnabled = localStorage.getItem("notifyEnabled") === "1"; } catch { /* ignore */ }
    setNotifyEnabled(wantEnabled && perm === "granted");
  }, []);

  async function toggleNotify() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (notifyEnabled) {
      setNotifyEnabled(false);
      try { localStorage.removeItem("notifyEnabled"); } catch { /* ignore */ }
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") {
      try { perm = await Notification.requestPermission(); } catch { /* ignore */ }
      setNotifyPermission(perm);
    }
    if (perm === "granted") {
      setNotifyEnabled(true);
      try { localStorage.setItem("notifyEnabled", "1"); } catch { /* ignore */ }
    } else if (perm === "denied") {
      // Can't unblock programmatically — surface a hint.
      window.alert("Notifications are blocked in your browser. Enable them in the site settings (look for the lock icon in the address bar) and try again.");
    }
  }

  function notifyComplete(ticker: string) {
    if (typeof window === "undefined") return;
    // (a) tab title flash — works always
    if (document.hidden) {
      const origTitle = document.title;
      document.title = `✓ ${ticker} ready · invest.app`;
      const restore = () => {
        document.title = origTitle;
        window.removeEventListener("focus", restore);
        document.removeEventListener("visibilitychange", onVis);
      };
      const onVis = () => { if (!document.hidden) restore(); };
      window.addEventListener("focus", restore);
      document.addEventListener("visibilitychange", onVis);
    }
    // (b) native notification — opt-in
    if (
      notifyEnabledRef.current
      && "Notification" in window
      && Notification.permission === "granted"
      && document.hidden
    ) {
      try {
        const n = new Notification("Analysis ready", {
          body: `${ticker} — click to read`,
          tag: `analysis-${ticker}`,
        });
        n.onclick = () => {
          try { window.focus(); n.close(); } catch { /* ignore */ }
        };
        setTimeout(() => { try { n.close(); } catch { /* ignore */ } }, 12000);
      } catch { /* ignore */ }
    }
  }

  // ---------- BYOK + free trials + owner bypass ----------
  const TRIAL_LIMIT = 3;
  const [userApiKey, setUserApiKey] = useState<string | null>(null);
  const [trialsUsed, setTrialsUsed] = useState<number>(0);
  const [byokOpen, setByokOpen] = useState(false);
  const [byokForced, setByokForced] = useState(false);
  // Owner mode bypasses the trial counter entirely. Auto-true on localhost
  // (so dev never trips the gate). On production, set via /?owner=1 once.
  const [ownerMode, setOwnerMode] = useState(false);
  const ownerModeRef = useRef(false);
  useEffect(() => { ownerModeRef.current = ownerMode; }, [ownerMode]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setUserApiKey(localStorage.getItem("anthropicApiKey"));
    const t = parseInt(localStorage.getItem("trialsUsed") || "0", 10);
    setTrialsUsed(Number.isFinite(t) ? t : 0);

    // Owner-mode resolution.
    try {
      const params = new URLSearchParams(window.location.search);
      const flag = params.get("owner");
      if (flag === "1") {
        localStorage.setItem("ownerMode", "1");
        window.history.replaceState({}, "", window.location.pathname);
      } else if (flag === "0") {
        localStorage.removeItem("ownerMode");
        window.history.replaceState({}, "", window.location.pathname);
      }
    } catch { /* ignore */ }
    const isLocalhost = window.location.hostname === "localhost"
      || window.location.hostname === "127.0.0.1";
    let savedFlag = false;
    try { savedFlag = localStorage.getItem("ownerMode") === "1"; } catch { /* ignore */ }
    setOwnerMode(isLocalhost || savedFlag);
  }, []);

  const trialsLeft = Math.max(0, TRIAL_LIMIT - trialsUsed);

  function saveApiKey(key: string) {
    localStorage.setItem("anthropicApiKey", key);
    setUserApiKey(key);
    setByokOpen(false);
    setByokForced(false);
  }
  function clearApiKey() {
    localStorage.removeItem("anthropicApiKey");
    setUserApiKey(null);
  }
  const userApiKeyRef = useRef<string | null>(null);
  useEffect(() => { userApiKeyRef.current = userApiKey; }, [userApiKey]);
  function bumpTrialsUsed() {
    if (ownerModeRef.current) return; // owner has unlimited
    if (userApiKeyRef.current) return; // BYOK has unlimited too
    setTrialsUsed((prev) => {
      const next = prev + 1;
      try { localStorage.setItem("trialsUsed", String(next)); } catch { /* ignore */ }
      return next;
    });
  }

  // ---------- run queue ----------
  // Ref is the source of truth for synchronous reads; state mirrors it for renders.
  const queueRef = useRef<string[]>([]);
  const [runQueue, setRunQueue] = useState<string[]>([]);
  const enqueue = useCallback((t: string) => {
    const v = t.trim().toUpperCase();
    if (!v || queueRef.current.includes(v)) return;
    queueRef.current = [...queueRef.current, v];
    setRunQueue([...queueRef.current]);
  }, []);
  const removeFromQueue = useCallback((t: string) => {
    queueRef.current = queueRef.current.filter((x) => x !== t);
    setRunQueue([...queueRef.current]);
  }, []);
  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setRunQueue([]);
  }, []);

  // ---------- ticker hunter ----------
  const [huntState, setHuntState] = useState<HuntState>("idle");
  const [huntPrompt, setHuntPrompt] = useState("");
  const [huntResults, setHuntResults] = useState<HunterTicker[]>([]);
  const [huntError, setHuntError] = useState("");
  const [huntElapsed, setHuntElapsed] = useState(0);
  const huntStartedAt = useRef<number>(0);
  const huntAbortRef = useRef<AbortController | null>(null);

  // Rehydrate the latest hunter prompt + results from localStorage so they
  // persist across tab switches AND browser refreshes. We never restore the
  // "thinking" state — only completed results.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem("hunterLastResult");
      if (!raw) return;
      const data = JSON.parse(raw) as { prompt?: string; results?: HunterTicker[] };
      if (typeof data.prompt === "string") setHuntPrompt(data.prompt);
      if (Array.isArray(data.results) && data.results.length > 0) {
        setHuntResults(data.results);
        setHuntState("done");
      }
    } catch { /* corrupt entry, ignore */ }
  }, []);

  useEffect(() => {
    if (huntState !== "thinking") return;
    const id = setInterval(() => {
      setHuntElapsed(Math.round((Date.now() - huntStartedAt.current) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [huntState]);

  // Reuse spinner frame for hunter spinner too
  useEffect(() => {
    if (huntState !== "thinking") return;
    const id = setInterval(() => setSpinFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [huntState]);
  // And quip rotator
  useEffect(() => {
    if (huntState !== "thinking") return;
    setQuipIdx(Math.floor(Math.random() * QUIPS.length));
    setQuipFade(true);
    const tick = setInterval(() => {
      setQuipFade(false);
      setTimeout(() => {
        setQuipIdx((i) => (i + 1 + Math.floor(Math.random() * (QUIPS.length - 1))) % QUIPS.length);
        setQuipFade(true);
      }, 250);
    }, 3500);
    return () => clearInterval(tick);
  }, [huntState]);

  function openHunter() {
    setHuntState("prompting");
    setLookupOpen(false);
  }
  function clearHunter() {
    if (huntState === "thinking") huntAbortRef.current?.abort();
    setHuntResults([]);
    setHuntPrompt("");
    setHuntError("");
    setHuntState("idle");
    try { localStorage.removeItem("hunterLastResult"); } catch { /* ignore */ }
  }
  function closeHunter() {
    if (huntState === "thinking") huntAbortRef.current?.abort();
    setHuntState("idle");
    setHuntError("");
  }
  async function askHunter(e?: React.FormEvent) {
    e?.preventDefault();
    const p = huntPrompt.trim();
    if (!p || huntState === "thinking") return;
    setHuntState("thinking");
    setHuntError("");
    setHuntResults([]);
    huntStartedAt.current = Date.now();
    setHuntElapsed(0);
    const ctrl = new AbortController();
    huntAbortRef.current = ctrl;
    try {
      const res = await fetch("/api/hunt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: p }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        setHuntError(`Error ${res.status}: ${txt || res.statusText}`);
        setHuntState("error");
        return;
      }
      const data = (await res.json()) as { tickers?: HunterTicker[] };
      const list = data.tickers || [];
      if (list.length === 0) {
        setHuntError("Got no tickers back. Try a more specific request.");
        setHuntState("error");
        return;
      }
      setHuntResults(list);
      setHuntState("done");
      // Persist for cross-session retention.
      try {
        localStorage.setItem("hunterLastResult", JSON.stringify({
          prompt: p,
          results: list,
          savedAt: new Date().toISOString(),
        }));
      } catch { /* storage full or disabled — ignore */ }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("aborted")) { setHuntState("idle"); }
      else { setHuntError(msg); setHuntState("error"); }
    }
  }
  function pickHunterTicker(symbol: string) {
    // Strip exchange prefix if present (e.g. "TYO:7203" → "7203" — keep the symbol portion)
    const sym = symbol.includes(":") ? symbol.split(":").pop()! : symbol;
    const t = sym.toUpperCase();
    setView("run");
    setLookupOpen(false);
    // BYOK gate
    if (!ownerMode && !userApiKey && trialsLeft <= 0) {
      setByokForced(true);
      setByokOpen(true);
      return;
    }
    if (runState === "running") {
      // Already running something — queue this for after.
      enqueue(t);
    } else {
      // Nothing running — start immediately. Saves the user a click on the Run button.
      void runOne(t);
    }
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // ---------- elapsed timer ----------
  useEffect(() => {
    if (runState !== "running") return;
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt.current) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [runState]);

  // ---------- quip rotator ----------
  useEffect(() => {
    if (runState !== "running") return;
    setQuipIdx(Math.floor(Math.random() * QUIPS.length));
    setQuipFade(true);
    const tick = setInterval(() => {
      setQuipFade(false);
      setTimeout(() => {
        setQuipIdx((i) => (i + 1 + Math.floor(Math.random() * (QUIPS.length - 1))) % QUIPS.length);
        setQuipFade(true);
      }, 250);
    }, 3500);
    return () => clearInterval(tick);
  }, [runState]);

  useEffect(() => {
    if (runState !== "running") return;
    const id = setInterval(() => setSpinFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [runState]);

  // ---------- ticker chip: debounced quote fetch ----------
  useEffect(() => {
    if (chipTimer.current) clearTimeout(chipTimer.current);
    const v = ticker.trim().toUpperCase();
    if (!v) { setChipState("empty"); setChipQuote(null); return; }
    setChipState("loading");
    chipTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/quote?ticker=${encodeURIComponent(v)}`);
        if (!res.ok) { setChipState("invalid"); setChipQuote(null); return; }
        const q: Quote = await res.json();
        setChipState("valid"); setChipQuote(q);
      } catch {
        setChipState("invalid"); setChipQuote(null);
      }
    }, 350);
    return () => { if (chipTimer.current) clearTimeout(chipTimer.current); };
  }, [ticker]);

  // ---------- saved list: load + live-quote refresh ----------
  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch("/api/saved");
      if (!res.ok) return;
      const data = (await res.json()) as { items: SavedAnalysis[]; starred: StarredMap };
      setSaved(data.items || []);
      setStarred(data.starred || {});
    } catch { /* ignore */ }
  }, []);

  // Toggle a ticker's star state — optimistic update + API call
  const toggleStar = useCallback(async (ticker: string, name?: string) => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    const wasStarred = !!starred[t];
    // optimistic
    setStarred((prev) => {
      const next = { ...prev };
      if (wasStarred) delete next[t];
      else next[t] = { name: (name || prev[t]?.name || t).trim(), starredAt: new Date().toISOString() };
      return next;
    });
    setSavingStar((prev) => { const s = new Set(prev); s.add(t); return s; });
    try {
      if (wasStarred) {
        await fetch(`/api/star/${encodeURIComponent(t)}`, { method: "DELETE" });
      } else {
        await fetch(`/api/star/${encodeURIComponent(t)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name || t }),
        });
      }
    } catch {
      // rollback on error
      setStarred((prev) => {
        const next = { ...prev };
        if (wasStarred) next[t] = { name: name || t, starredAt: new Date().toISOString() };
        else delete next[t];
        return next;
      });
    } finally {
      setSavingStar((prev) => { const s = new Set(prev); s.delete(t); return s; });
    }
  }, [starred]);

  useEffect(() => { loadSaved(); }, [loadSaved]);

  useEffect(() => {
    if (view !== "saved") return;
    loadSaved();
    // Fetch live quotes for all tickers
    const tickers = Array.from(new Set(saved.map((s) => s.ticker)));
    Promise.all(tickers.map(async (t) => {
      try {
        const res = await fetch(`/api/quote?ticker=${encodeURIComponent(t)}`);
        if (!res.ok) return [t, null] as [string, Quote | null];
        return [t, (await res.json()) as Quote] as [string, Quote | null];
      } catch { return [t, null] as [string, Quote | null]; }
    })).then((rows) => setLiveQuotes(Object.fromEntries(rows)));
  }, [view, loadSaved, saved.length]);

  // ---------- run analysis ----------
  // Track the ticker that's currently running (distinct from `ticker` which is the input value).
  const [currentTicker, setCurrentTicker] = useState<string | null>(null);

  // ---------- report pages (pagination) ----------
  // Every completed run becomes a page. Streaming output is held in `report`
  // (the live buffer); when the run completes, that buffer is pushed onto `pages`.
  // The user navigates between pages with the pagination control — previous
  // pages stay intact and are never auto-replaced.
  const pagesRef = useRef<ReportPage[]>([]);
  const [pages, setPages] = useState<ReportPage[]>([]);
  // viewIdx semantics: -1 = viewing the live stream; 0..pages.length-1 = viewing that page.
  const [viewIdx, setViewIdx] = useState<number>(-1);
  function addPage(page: ReportPage): number {
    pagesRef.current = [...pagesRef.current, page];
    setPages([...pagesRef.current]);
    return pagesRef.current.length - 1;
  }

  /**
   * Remove a completed analysis from the pagination strip. This drops the
   * in-session page only — it does NOT touch any saved-to-disk record in
   * the Saved tab (those are independent: pages live in localStorage,
   * saved analyses live on the server filesystem).
   */
  function removePage(idx: number) {
    if (idx < 0 || idx >= pagesRef.current.length) return;
    const next = pagesRef.current.slice();
    next.splice(idx, 1);
    pagesRef.current = next;
    setPages(next);

    // Adjust viewIdx so the user lands somewhere sensible.
    setViewIdx((cur) => {
      if (next.length === 0) {
        // Nothing left to show: bounce to live tab if a run is in flight,
        // otherwise the pagination component will hide entirely.
        return -1;
      }
      if (cur === -1) return -1;            // watching live, no change
      if (cur === idx) {                    // we removed the one being viewed
        return Math.min(idx, next.length - 1);
      }
      if (cur > idx) return cur - 1;        // shift down to track the same page
      return cur;
    });
  }

  // Restore last session's pages on mount. We don't restore in-flight runs —
  // anything that was streaming when the user refreshed is lost (server may
  // still be running but the client can't reattach). Completed pages survive.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const rawPages = localStorage.getItem("analysisPages");
      const rawIdx = localStorage.getItem("analysisViewIdx");
      if (rawPages) {
        const data = JSON.parse(rawPages) as ReportPage[];
        if (Array.isArray(data) && data.length > 0) {
          pagesRef.current = data;
          setPages(data);
          const savedIdx = parseInt(rawIdx ?? "", 10);
          // Live-tab (-1) at refresh time points nowhere now; land on the last page.
          setViewIdx(
            Number.isFinite(savedIdx) && savedIdx >= 0 && savedIdx < data.length
              ? savedIdx
              : data.length - 1
          );
        }
      }
    } catch { /* corrupt entry, ignore */ }
  }, []);

  // Persist pages + viewIdx whenever they change. Cap at 20 most recent to
  // keep localStorage well under the 5MB-per-origin limit even for chatty Q&A.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (pages.length === 0) {
        localStorage.removeItem("analysisPages");
        localStorage.removeItem("analysisViewIdx");
        return;
      }
      const capped = pages.slice(-20);
      localStorage.setItem("analysisPages", JSON.stringify(capped));
      // Translate viewIdx if pages were truncated by the cap.
      const offset = pages.length - capped.length;
      const adjustedIdx = viewIdx >= 0 ? Math.max(0, viewIdx - offset) : -1;
      localStorage.setItem("analysisViewIdx", String(adjustedIdx));
    } catch { /* quota or disabled — skip silently */ }
  }, [pages, viewIdx]);

  // The actual run executor — fetches, streams, and recursively picks up the next queued ticker.
  async function runOne(t: string) {
    setLookupOpen(false);
    setSavedMode(null);
    setSaveState("idle");
    // Clear the live buffer immediately. The previous run's content is
    // preserved as a page in `pages`, so the user can navigate to it any time;
    // the live tab should show only the *current* run's stream.
    setReport("");
    setStatus("Connecting…");
    setRunState("running");
    setCurrentTicker(t);
    startedAt.current = Date.now();
    setElapsed(0);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // Track this run's content separately so we can archive the full body to
    // `pages` on completion regardless of stale closure values for `report`.
    let accumulator = "";

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (userApiKeyRef.current) headers["x-anthropic-key"] = userApiKeyRef.current;
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers,
        body: JSON.stringify({ ticker: t }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        setStatus(`Error ${res.status}: ${txt || res.statusText}`);
        setRunState("error");
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          if (ctrl.signal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (!payload) continue;
            try {
              const evt = JSON.parse(payload) as
                | { type: "status"; text: string }
                | { type: "delta"; text: string }
                | { type: "done" }
                | { type: "error"; text: string };
              if (evt.type === "status") setStatus(evt.text);
              else if (evt.type === "delta") {
                accumulator += evt.text;
                setReport((p) => p + evt.text);
              }
              else if (evt.type === "done") {
                setStatus("Done.");
                setRunState("done");
                bumpTrialsUsed();
                notifyComplete(t);
                // Archive this run as a new page. If the user was viewing the
                // live stream (-1), auto-switch to the new page. Otherwise
                // leave them on whatever page they were reading — they'll
                // navigate to the new one with the pagination control.
                if (accumulator) {
                  const newPage: ReportPage = {
                    id: `${t}-${Date.now()}`,
                    ticker: t,
                    body: accumulator,
                    completedAt: new Date().toISOString(),
                  };
                  const newIdx = addPage(newPage);
                  setViewIdx((prev) => (prev === -1 ? newIdx : prev));
                }
              }
              else if (evt.type === "error") { setStatus(`Error: ${evt.text}`); setRunState("error"); }
            } catch { /* ignore */ }
          }
        }
        setRunState((s) => (s === "running" ? "done" : s));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("aborted")) {
        setStatus("Cancelled.");
        setRunState("idle");
      } else {
        setStatus(`Error: ${msg}`);
        setRunState("error");
      }
    } finally {
      setCurrentTicker(null);
    }

    // Always process the next queued ticker — Cancel skips the current run only,
    // it does not abort the rest of the queue. To clear the queue the user
    // either × each item, or hits "Clear queue" in the queue panel.
    if (queueRef.current.length > 0) {
      const next = queueRef.current[0];
      queueRef.current = queueRef.current.slice(1);
      setRunQueue([...queueRef.current]);
      setTimeout(() => { void runOne(next); }, 250);
    }
  }

  // Public entry point — called from the form Submit button. If something's already
  // running, queue the ticker rather than overriding it.
  function run(e?: React.FormEvent) {
    e?.preventDefault();
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    // BYOK gate — block when not owner, no key, and free trials are exhausted.
    if (!ownerMode && !userApiKey && trialsLeft <= 0) {
      setByokForced(true);
      setByokOpen(true);
      return;
    }
    if (runState === "running") {
      enqueue(t);
      setTicker("");
      return;
    }
    setTicker("");
    void runOne(t);
  }

  function cancel() {
    // Cancel skips the *current* run only — the queue keeps going. To clear the
    // queue the user removes items individually (×) or uses Clear queue.
    abortRef.current?.abort();
    setStatus("Cancelled.");
    setRunState("idle");
    setCurrentTicker(null);
  }

  // ---------- look up price ----------
  async function lookUp() {
    const v = ticker.trim().toUpperCase();
    if (!v) return;
    setLookupOpen(true);
    setLookupQuote(null);
    try {
      const res = await fetch(`/api/quote?ticker=${encodeURIComponent(v)}`);
      if (!res.ok) { setLookupQuote(null); return; }
      setLookupQuote((await res.json()) as Quote);
    } catch { setLookupQuote(null); }
  }

  // ---------- follow-up Q&A ----------
  const [askInput, setAskInput] = useState("");
  const [askLoading, setAskLoading] = useState(false);
  const askAbortRef = useRef<AbortController | null>(null);

  // Add a Q&A message to a specific page (by id) without disturbing other pages.
  function appendQA(pageId: string, msg: QAMessage) {
    pagesRef.current = pagesRef.current.map((p) =>
      p.id === pageId ? { ...p, qa: [...(p.qa ?? []), msg] } : p
    );
    setPages([...pagesRef.current]);
  }
  // Mutate the last assistant message of a page (used while streaming the answer).
  function appendToLastAssistant(pageId: string, chunk: string) {
    pagesRef.current = pagesRef.current.map((p) => {
      if (p.id !== pageId) return p;
      const qa = p.qa ?? [];
      if (qa.length === 0 || qa[qa.length - 1].role !== "assistant") {
        return { ...p, qa: [...qa, { role: "assistant", content: chunk }] };
      }
      const next = [...qa];
      next[next.length - 1] = { ...next[next.length - 1], content: next[next.length - 1].content + chunk };
      return { ...p, qa: next };
    });
    setPages([...pagesRef.current]);
  }

  async function askFollowUp() {
    if (askLoading) return;
    const q = askInput.trim();
    if (!q) return;
    // Block if no key + trials exhausted (same gate as analyses).
    if (!ownerMode && !userApiKey && trialsLeft <= 0) {
      setByokForced(true);
      setByokOpen(true);
      return;
    }
    // Determine which surface owns this question. Three surfaces can be
    // active and they're mutually exclusive in the UI:
    //   - saved-detail panel (Saved tab)         → savedMode + savedQA
    //   - paginated page in Analyze tab          → targetPage + page.qa
    //   - live stream (no completed page yet)    → bail (asking before done)
    const inSavedDetail = view === "saved" && !!savedMode;
    const targetPage = (!inSavedDetail && viewIdx >= 0) ? pages[viewIdx] : null;
    const reportMd = inSavedDetail
      ? savedMode!.body
      : (targetPage ? targetPage.body : displayedReport);
    if (!reportMd) return;

    setAskLoading(true);
    setAskInput("");
    if (targetPage) {
      appendQA(targetPage.id, { role: "user", content: q });
      appendQA(targetPage.id, { role: "assistant", content: "" });
    } else if (inSavedDetail) {
      setSavedQA((prev) => [
        ...prev,
        { role: "user", content: q },
        { role: "assistant", content: "" },
      ]);
    }

    const ctrl = new AbortController();
    askAbortRef.current = ctrl;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (userApiKeyRef.current) headers["x-anthropic-key"] = userApiKeyRef.current;

    try {
      // Send any prior conversation history (excluding the just-added
      // empty assistant slot we'll be streaming into) so the model has
      // continuity within the panel session.
      const historyForRequest = targetPage
        ? (targetPage.qa?.slice(0, -2) ?? [])
        : (inSavedDetail ? savedQA.slice(0, -2) : []);

      const res = await fetch("/api/ask", {
        method: "POST",
        headers,
        body: JSON.stringify({
          report: reportMd,
          question: q,
          history: historyForRequest,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        const msg = `Error: ${res.status} ${txt || res.statusText}`;
        if (targetPage) appendToLastAssistant(targetPage.id, msg);
        else if (inSavedDetail) appendToSavedAssistant(msg);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        if (ctrl.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload) as
              | { type: "delta"; text: string }
              | { type: "done" }
              | { type: "error"; text: string };
            if (evt.type === "delta") {
              if (targetPage) appendToLastAssistant(targetPage.id, evt.text);
              else if (inSavedDetail) appendToSavedAssistant(evt.text);
            } else if (evt.type === "error") {
              const m = `\n\n**Error:** ${evt.text}`;
              if (targetPage) appendToLastAssistant(targetPage.id, m);
              else if (inSavedDetail) appendToSavedAssistant(m);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("aborted")) {
        const m = `\n\n**Error:** ${msg}`;
        if (targetPage) appendToLastAssistant(targetPage.id, m);
        else if (inSavedDetail) appendToSavedAssistant(m);
      }
    } finally {
      setAskLoading(false);
    }
  }
  /** Append a chunk to the last assistant message in the saved-detail Q&A. */
  function appendToSavedAssistant(text: string) {
    setSavedQA((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last.role !== "assistant") return prev;
      next[next.length - 1] = { ...last, content: last.content + text };
      return next;
    });
  }
  function cancelAsk() {
    askAbortRef.current?.abort();
    setAskLoading(false);
  }

  // ---------- save current analysis ----------
  async function saveCurrent() {
    if (saveState === "saving") return;
    // Save whichever report is currently being displayed — could be the live
    // stream, a completed page, or a loaded saved analysis being re-saved.
    const md = displayedReport;
    if (!md) return;
    // Prefer the ticker associated with the displayed page; fall back to
    // savedMode's ticker, then the input.
    const currentPage = (viewIdx >= 0 && pages[viewIdx]) ? pages[viewIdx] : null;
    const explicitTicker = currentPage
      ? currentPage.ticker
      : savedMode?.ticker || (ticker || "").trim().toUpperCase();
    const t = explicitTicker.toUpperCase();
    if (!t) return;
    setSaveState("saving");
    try {
      const res = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: t, markdown: md }),
      });
      if (!res.ok) { setSaveState("error"); return; }
      const item = (await res.json()) as SavedAnalysis;
      setSaveState("saved");
      setSavedAtTime(fmtTime(item.savedAt));
      // Stamp the page (in-session) so the button reflects "saved" only when
      // the user navigates back to *that* page — not for sibling pages.
      if (currentPage) {
        const stampedId = currentPage.id;
        const stamp = item.savedAt;
        pagesRef.current = pagesRef.current.map((p) =>
          p.id === stampedId ? { ...p, savedAt: stamp } : p
        );
        setPages([...pagesRef.current]);
      }
      void loadSaved();
    } catch { setSaveState("error"); }
  }

  // ---------- saved list operations ----------
  function toggleTicker(t: string) {
    setOpenTickers((prev) => {
      const s = new Set(prev);
      if (s.has(t)) s.delete(t); else s.add(t);
      return s;
    });
  }
  function expandAll(allT: string[], collapse: boolean) {
    setOpenTickers(collapse ? new Set() : new Set(allT));
  }
  async function doDeleteAnalysis(id: string) {
    setRemovingId(id);
    setTimeout(async () => {
      try { await fetch(`/api/saved/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
      setConfirmRowId(null);
      setRemovingId(null);
      await loadSaved();
    }, 220);
  }
  async function doDeleteTicker(t: string) {
    setRemovingTicker(t);
    setTimeout(async () => {
      try { await fetch(`/api/saved/ticker/${encodeURIComponent(t)}`, { method: "DELETE" }); } catch { /* ignore */ }
      setConfirmTicker(null);
      setRemovingTicker(null);
      await loadSaved();
    }, 250);
  }

  /**
   * Open a saved analysis as a full-screen detail panel WITHIN the Saved
   * tab. Crucially we don't touch the Analyze tab's state (`report`,
   * `ticker`, `runState`, `pages`, `viewIdx`) — that surface stays exactly
   * as the user left it. Closing the panel just clears `savedMode`.
   */
  function openSaved(item: SavedAnalysis) {
    setSavedMode(item);
    setSavedQA([]);                            // fresh Q&A scope per saved-open
    setLookupOpen(false);
    setAskInput("");
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }
  function closeSavedDetail() {
    setSavedMode(null);
    setSavedQA([]);
    setAskInput("");
  }

  // Reset transient save state when navigating to a different page. Per-page
  // "saved" status is tracked on the page object itself (see `savedAt` on
  // ReportPage); this just clears any in-flight 'saving' or 'error' carry-over.
  useEffect(() => { setSaveState("idle"); setSavedAtTime(""); }, [viewIdx]);

  // ---------- derived: what's rendered in the Analyze tab's report area ----------
  // Saved analyses now have their own detail surface inside the Saved tab,
  // so we no longer let savedMode hijack this. This view picks either the
  // paginated page the user is on, or the live streaming buffer.
  const displayedReport = useMemo(() => {
    if (viewIdx >= 0 && pages[viewIdx]) return pages[viewIdx].body;
    return report;
  }, [viewIdx, pages, report]);
  const parsed = useMemo(() => (displayedReport ? parseReport(displayedReport) : null), [displayedReport]);

  // Parsed snapshot of the saved analysis being viewed (Saved tab detail
  // panel only — independent from the Analyze view's `parsed`).
  const savedParsed = useMemo(
    () => (savedMode?.body ? parseReport(savedMode.body) : null),
    [savedMode]
  );

  // ---------- derived: grouped saved (analyses + starred-only) ----------
  type Group = { ticker: string; name: string; analyses: SavedAnalysis[]; starred: boolean; starredAt: string | null };
  const grouped = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    // Seed with tickers that have analyses
    for (const a of saved) {
      const ent = map.get(a.ticker) ?? { ticker: a.ticker, name: a.name, analyses: [], starred: false, starredAt: null };
      ent.analyses.push(a);
      map.set(a.ticker, ent);
    }
    // Layer in starred state
    for (const [t, s] of Object.entries(starred)) {
      const ent = map.get(t) ?? { ticker: t, name: s.name || t, analyses: [], starred: false, starredAt: null };
      ent.starred = true;
      ent.starredAt = s.starredAt;
      if (!ent.analyses.length) ent.name = s.name || t;
      map.set(t, ent);
    }
    return Array.from(map.values()).sort((a, b) => {
      // Sort by most recent activity (latest analysis savedAt OR starredAt)
      const aT = a.analyses[0]?.savedAt || a.starredAt || "";
      const bT = b.analyses[0]?.savedAt || b.starredAt || "";
      return aT < bT ? 1 : -1;
    });
  }, [saved, starred]);
  const totalTickers = grouped.length; // count of unique tickers (this is what shows in tab)
  const expandableCount = grouped.filter((g) => g.analyses.length > 0).length;
  const allOpen = expandableCount > 0 && openTickers.size === expandableCount;

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-28 pt-6">
      {/* HEADER */}
      <header className="mb-5 border-b border-[var(--color-line-2)] pb-4">
        <h1 className="font-serif text-2xl font-medium tracking-tight" style={{ fontFamily: "var(--font-serif)" }}>
          AI Investment Co-Pilot
        </h1>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="notify-btn"
            data-state={
              notifyEnabled ? "on"
              : notifyPermission === "denied" ? "blocked"
              : "off"
            }
            onClick={toggleNotify}
            title={
              notifyEnabled ? "Notifications on — click to turn off"
              : notifyPermission === "denied" ? "Notifications blocked in your browser settings"
              : "Get a desktop notification when each analysis is ready"
            }
            aria-label="Toggle notifications"
          >
            {notifyEnabled ? (
              // Filled bell
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0">
                <path d="M12 2a1 1 0 0 1 1 1v.618A7.001 7.001 0 0 1 19 10v4.142l1.707 1.708A1 1 0 0 1 20 17.5H4a1 1 0 0 1-.707-1.65L5 14.142V10a7.001 7.001 0 0 1 6-6.382V3a1 1 0 0 1 1-1zm-1.5 17.5h3a1.5 1.5 0 0 1-3 0z"/>
              </svg>
            ) : notifyPermission === "denied" ? (
              // Bell with slash
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            ) : (
              // Outline bell
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
            )}
          </button>
          <button
            className="trial-badge"
            data-state={
              ownerMode ? "owner"
              : userApiKey ? "connected"
              : trialsLeft === 0 ? "exhausted"
              : trialsLeft === 1 ? "warn"
              : ""
            }
            onClick={() => { setByokForced(false); setByokOpen(true); }}
            title={ownerMode ? "Owner mode — trial limit bypassed" : undefined}
          >
            <span className="dot" />
            {ownerMode
              ? "Unlimited"
              : userApiKey
                ? "API key connected"
                : trialsLeft > 0
                  ? `${trialsLeft} of ${TRIAL_LIMIT} free analyses`
                  : "Add API key to continue"}
          </button>
          <span className="ml-auto text-[9.5px] font-bold uppercase tracking-[0.24em] text-[var(--color-muted)]">
            invest.app
          </span>
        </div>
      </header>

      {view === "hunter" && (
        <HunterView
          huntState={huntState} huntPrompt={huntPrompt} setHuntPrompt={setHuntPrompt}
          huntResults={huntResults} huntError={huntError} huntElapsed={huntElapsed}
          quip={QUIPS[quipIdx]} quipFade={quipFade} spinFrame={spinFrame}
          askHunter={askHunter} closeHunter={closeHunter} clearHunter={clearHunter}
          editHunterPrompt={() => setHuntState("prompting")}
          pickHunterTicker={pickHunterTicker}
          starred={starred} onToggleStar={toggleStar}
        />
      )}

      {view === "run" && (
        <RunView
          ticker={ticker} setTicker={(v) => setTicker(v.toUpperCase())}
          run={run} cancel={cancel} runState={runState}
          status={status} elapsed={elapsed}
          currentTicker={currentTicker}
          runQueue={runQueue} onRemoveFromQueue={removeFromQueue} onClearQueue={clearQueue}
          quip={QUIPS[quipIdx]} quipFade={quipFade} spinFrame={spinFrame}
          chipState={chipState} chipQuote={chipQuote}
          report={displayedReport} parsed={parsed}
          pages={pages} viewIdx={viewIdx} setViewIdx={setViewIdx} onRemovePage={removePage}
          askInput={askInput} setAskInput={setAskInput}
          askLoading={askLoading} onAsk={askFollowUp} onCancelAsk={cancelAsk}
          savedMode={null}
          onBackToSaved={() => { setView("saved"); }}
          onRerun={() => { setSavedMode(null); setSaveState("idle"); run(); }}
          saveState={saveState} savedAtTime={savedAtTime} onSave={saveCurrent}
          starred={starred} onToggleStar={toggleStar}
        />
      )}

      {view === "saved" && !savedMode && (
        <SavedView
          grouped={grouped}
          totalTickers={totalTickers}
          expandableCount={expandableCount}
          liveQuotes={liveQuotes}
          openTickers={openTickers} toggleTicker={toggleTicker}
          allOpen={allOpen}
          expandAll={(c) => expandAll(grouped.filter((g) => g.analyses.length > 0).map((g) => g.ticker), c)}
          confirmRowId={confirmRowId} setConfirmRowId={setConfirmRowId}
          confirmTicker={confirmTicker} setConfirmTicker={setConfirmTicker}
          removingId={removingId} removingTicker={removingTicker}
          onDeleteAnalysis={doDeleteAnalysis}
          onDeleteTicker={doDeleteTicker}
          onOpen={openSaved}
          onPickTicker={(t) => { setTicker(t); setView("run"); }}
          onToggleStar={toggleStar}
        />
      )}

      {view === "saved" && savedMode && savedParsed && (
        <SavedDetailView
          item={savedMode}
          parsed={savedParsed}
          onClose={closeSavedDetail}
          onRerun={() => {
            // "Re-run" hands off to the Analyze tab: prefill the ticker,
            // close the detail panel, switch tabs, and trigger a fresh run.
            const t = savedMode.ticker;
            setSavedMode(null);
            setSavedQA([]);
            setTicker(t);
            setView("run");
            requestAnimationFrame(() => run());
          }}
          askInput={askInput}
          setAskInput={setAskInput}
          askLoading={askLoading}
          onAsk={askFollowUp}
          onCancelAsk={cancelAsk}
          savedQA={savedQA}
        />
      )}

      {byokOpen && (
        <BYOKModal
          userApiKey={userApiKey}
          forced={byokForced}
          trialsLeft={trialsLeft}
          trialLimit={TRIAL_LIMIT}
          onClose={() => { setByokOpen(false); setByokForced(false); }}
          onSave={saveApiKey}
          onClear={clearApiKey}
        />
      )}

      {/* BOTTOM NAV (mobile-style GNB) */}
      <nav className="bottom-nav" role="tablist" aria-label="Main navigation">
        <button
          className="nav-tab"
          aria-current={view === "hunter" ? "true" : "false"}
          aria-label="Brainstorm"
          onClick={() => setView("hunter")}
        >
          {/* Lightbulb icon */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18h6" />
            <path d="M10 21h4" />
            <path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1.2 1.6 1.4 2.5h5.2c.2-.9.7-1.8 1.4-2.5A6 6 0 0 0 12 3z" />
          </svg>
          <span>Brainstorm</span>
        </button>
        <button
          className="nav-tab"
          aria-current={view === "run" ? "true" : "false"}
          aria-label="Analyze"
          onClick={() => setView("run")}
        >
          {/* Magnifying glass icon */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <span>Analyze</span>
        </button>
        <button
          className="nav-tab"
          aria-current={view === "saved" ? "true" : "false"}
          aria-label="Saved"
          onClick={() => setView("saved")}
        >
          {/* Bookmark icon */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          <span>Saved{totalTickers > 0 && <span className="nav-count">· {totalTickers}</span>}</span>
        </button>
      </nav>
    </main>
  );
}

/* =============== RUN VIEW =============== */
function RunView(props: {
  ticker: string; setTicker: (v: string) => void;
  run: (e?: React.FormEvent) => void; cancel: () => void; runState: RunState;
  status: string; elapsed: number;
  currentTicker: string | null;
  runQueue: string[]; onRemoveFromQueue: (t: string) => void; onClearQueue: () => void;
  quip: string; quipFade: boolean; spinFrame: number;
  chipState: "empty" | "loading" | "valid" | "invalid"; chipQuote: Quote | null;
  report: string; parsed: ParsedReport | null;
  pages: ReportPage[]; viewIdx: number; setViewIdx: (n: number) => void;
  onRemovePage: (idx: number) => void;
  askInput: string; setAskInput: (s: string) => void;
  askLoading: boolean; onAsk: () => void; onCancelAsk: () => void;
  savedMode: SavedAnalysis | null;
  onBackToSaved: () => void; onRerun: () => void;
  saveState: SaveState; savedAtTime: string; onSave: () => void;
  starred: StarredMap;
  onToggleStar: (ticker: string, name?: string) => void;
}) {
  const {
    ticker, setTicker, run, cancel, runState, status, elapsed,
    currentTicker, runQueue, onRemoveFromQueue, onClearQueue,
    quip, quipFade, spinFrame,
    chipState, chipQuote,
    report, parsed,
    pages, viewIdx, setViewIdx, onRemovePage,
    askInput, setAskInput, askLoading, onAsk, onCancelAsk,
    savedMode, onBackToSaved, onRerun,
    saveState, savedAtTime, onSave,
    starred, onToggleStar,
  } = props;
  const isLoadedSave = savedMode !== null;

  return (
    <>
      <form onSubmit={run} className="mt-5 flex items-stretch gap-2">
        <input
          autoFocus
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="Ticker — e.g. NVDA"
          maxLength={8}
          spellCheck={false}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          className="flex-1 rounded-md border border-[var(--color-line-2)] bg-white px-4 py-3 font-mono text-base tracking-wider text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent-2)] focus:ring-[3px] focus:ring-[var(--color-accent-2)]/15"
        />
        <button
          type="submit"
          disabled={!ticker.trim()}
          className="rounded-md bg-[var(--color-accent)] px-5 text-sm font-medium tracking-wide text-white transition hover:bg-[var(--color-accent-2)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          {runState === "running" ? "Queue" : "Run"}
        </button>
      </form>

      <TickerChip
        state={chipState} quote={chipQuote} ticker={ticker}
        starred={!!starred[(ticker || "").toUpperCase()]}
        onToggleStar={onToggleStar}
      />

      {(status || runState === "running") && (
        <div className="mt-3 space-y-1.5 text-xs text-[var(--color-muted)]">
          <div className="flex items-center gap-2">
            {runState === "running" ? (
              <span aria-hidden className="inline-block w-3 text-center font-mono text-base leading-none text-[var(--color-accent-2)]">
                {SPINNER_FRAMES[spinFrame]}
              </span>
            ) : (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-line-2)]" />
            )}
            {runState === "running" && currentTicker && (
              <span className="font-medium text-[var(--color-ink)]">{currentTicker}</span>
            )}
            <span>{status}</span>
            {runState === "running" && <span className="font-mono tabular-nums">· {elapsed}s</span>}
            {runState === "running" && (
              <button
                type="button"
                onClick={cancel}
                className="ml-auto rounded-md border border-[var(--color-line)] bg-white px-2.5 py-1 text-[11px] font-medium text-[var(--color-muted)] transition hover:border-[var(--color-neg)] hover:text-[var(--color-neg)]"
              >
                Cancel
              </button>
            )}
          </div>
          {runState === "running" && (
            <div
              className={`pl-5 italic transition-opacity duration-200 ${quipFade ? "opacity-70" : "opacity-0"}`}
              style={{ fontFamily: "var(--font-serif)" }}
            >
              {quip}
            </div>
          )}
        </div>
      )}

      {runQueue.length > 0 && (
        <div className="run-queue">
          <span className="queue-label">Queued · runs after current</span>
          {runQueue.map((t, i) => (
            <span key={`${t}-${i}`} className="queue-pill">
              <span className="queue-pos">{i + 1}</span>
              {t}
              <button
                className="queue-remove"
                onClick={() => onRemoveFromQueue(t)}
                aria-label={`Remove ${t} from queue`}
                title={`Remove ${t} from queue`}
              >×</button>
            </span>
          ))}
          {runQueue.length > 1 && (
            <button
              className="queue-clear"
              onClick={onClearQueue}
              title="Remove every item from the queue"
            >
              Clear queue
            </button>
          )}
        </div>
      )}

      {isLoadedSave && (
        <div className="saved-indicator">
          <span>
            <b>Viewing saved analysis</b> · {fmtWhen(savedMode!.savedAt)} · {fmtTime(savedMode!.savedAt)}
            <span style={{ marginLeft: 4, color: "var(--color-muted)", fontStyle: "italic" }}>
              ({fmtRel(savedMode!.savedAt)})
            </span>
          </span>
          <span>
            <a onClick={onBackToSaved}>← Back to saved</a>
            &nbsp;·&nbsp;
            <a onClick={onRerun}>Re-run analysis</a>
          </span>
        </div>
      )}

      {(pages.length > 0 || (runState === "running" && report)) && !isLoadedSave && (
        <div className="report-pagination">
          <button
            className="pag-arrow"
            disabled={viewIdx <= 0}
            onClick={() => setViewIdx(Math.max(0, (viewIdx === -1 ? pages.length : viewIdx) - 1))}
            aria-label="Previous page"
          >←</button>
          <div className="pag-tabs">
            {pages.map((p, i) => (
              <span
                key={p.id}
                className={`pag-tab ${i === viewIdx ? "active" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => setViewIdx(i)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setViewIdx(i); } }}
                title={`${p.ticker} · ${fmtRel(p.completedAt)}`}
              >
                <span className="pag-num">{i + 1}.</span>
                <span className="pag-ticker">{p.ticker}</span>
                <button
                  className="pag-close"
                  onClick={(e) => { e.stopPropagation(); onRemovePage(i); }}
                  title={`Remove ${p.ticker} analysis from this list`}
                  aria-label={`Remove ${p.ticker} analysis`}
                >×</button>
              </span>
            ))}
            {runState === "running" && (
              <button
                className={`pag-tab live ${viewIdx === -1 ? "active" : ""}`}
                onClick={() => setViewIdx(-1)}
                title="Watch the running analysis as it streams"
              >
                {currentTicker || "Live"}
              </button>
            )}
          </div>
          <button
            className="pag-arrow"
            disabled={viewIdx === -1 || viewIdx >= pages.length - 1}
            onClick={() => setViewIdx(Math.min(pages.length - 1, viewIdx + 1))}
            aria-label="Next page"
          >→</button>
        </div>
      )}

      {report && parsed && parsed.company && (
        <div className="mt-6 space-y-6">
          <VerdictBanner parsed={parsed} />
          {parsed.body.trim() && (
            <article className="prose rounded-lg border border-[var(--color-line)] bg-white p-8 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              <ReportBody body={parsed.body} />
            </article>
          )}
          {/* Follow-up Q&A — only on completed pages or saved-mode reports,
              not on the live stream where the report is still arriving. */}
          {((viewIdx >= 0 && pages[viewIdx]) || savedMode) && (
            <AskPanel
              page={viewIdx >= 0 ? pages[viewIdx] : null}
              ticker={(viewIdx >= 0 ? pages[viewIdx].ticker : savedMode?.ticker) || ""}
              input={askInput}
              setInput={setAskInput}
              loading={askLoading}
              onAsk={onAsk}
              onCancel={onCancelAsk}
            />
          )}
          {!isLoadedSave && (() => {
            // Per-page save status: a page is "saved" when its `savedAt` field
            // is set (we stamp it after a successful POST /api/save).
            const cp = (viewIdx >= 0) ? pages[viewIdx] : null;
            const pageIsSaved = !!cp?.savedAt;
            const showSaveZone = cp ? true : (runState === "done");
            if (!showSaveZone) return null;
            return (
              <div className="save-zone">
                <div className="text">
                  {pageIsSaved
                    ? <>This <b>{cp?.ticker}</b> analysis is in your <b>Saved</b> tab. Run it again any time to refresh.</>
                    : <>Want to come back to this later? <b>Save it.</b> You can compare against future runs side-by-side.</>}
                </div>
                <button
                  onClick={onSave}
                  disabled={saveState === "saving"}
                  className={`rounded-md border bg-white px-5 py-2 text-sm font-medium transition ${
                    pageIsSaved || saveState === "saved"
                      ? "save-cta saved"
                      : "border-[var(--color-line-2)] text-[var(--color-ink)] hover:border-[var(--color-accent-2)] hover:text-[var(--color-accent-2)]"
                  }`}
                  style={(pageIsSaved || saveState === "saved")
                    ? { borderColor: "var(--color-pos)", color: "var(--color-pos)" }
                    : undefined}
                >
                  {saveState === "saving" && "Saving…"}
                  {saveState === "error" && "Save failed — retry"}
                  {saveState !== "saving" && saveState !== "error" && (
                    pageIsSaved
                      ? `Saved · ${fmtTime(cp!.savedAt!)}`
                      : (saveState === "saved" && savedAtTime ? `Saved · ${savedAtTime}` : "Save analysis")
                  )}
                </button>
              </div>
            );
          })()}
        </div>
      )}
    </>
  );
}

/* =============== REPORT BODY =============== */
/**
 * Splits the report body into a sequence of MD chunks + structured card
 * sections. The Risks table inside "Catalysts, Risks & Timing" becomes a
 * stack of risk cards in place. The If-Then Verdict Matrix is moved to a
 * new Appendix block placed right after Sources.
 *
 * `useMemo`'d so we don't re-parse during every keystroke in the Q&A box.
 */
/**
 * Wraps native `<table>` in a horizontally scrollable container so wide
 * GFM tables (Financial / Peer / DCF grids) don't blow out the layout on
 * mobile. Plugged into ReactMarkdown via the `components` override.
 */
const MD_COMPONENTS = {
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="prose-table-wrap">
      <table {...props} />
    </div>
  ),
};

function ReportBody({ body }: { body: string }) {
  const blocks = useMemo<RenderBlock[]>(() => buildRenderBlocks(body), [body]);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "md") {
          return (
            <ReactMarkdown key={`md-${i}`} remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {b.md}
            </ReactMarkdown>
          );
        }
        if (b.kind === "macro") {
          // Three-card grouping by direction. Original `## 2. Macroeconomic
          // Overview` H2 from the markdown precedes this block.
          const tail = b.rows.filter((r) => macroBucket(r.direction) === "tailwind");
          const neut = b.rows.filter((r) => macroBucket(r.direction) === "neutral");
          const head = b.rows.filter((r) => macroBucket(r.direction) === "headwind");
          return (
            <div key={`macro-${i}`} className="macro-grid">
              <MacroCard title="Tailwinds" tone="tail" rows={tail} />
              <MacroCard title="Neutral" tone="neut" rows={neut} />
              <MacroCard title="Headwinds" tone="head" rows={head} />
            </div>
          );
        }
        if (b.kind === "peer") {
          // Custom peer table: Moat row pulled to the top so the ticker
          // header stays close to the metric rows. Wrapped in a horizontal
          // scroll container; cells are constrained to wrap at a sane width.
          const moatIdx = b.table.metrics.findIndex((m) => /^moat\b/i.test(m.metric));
          const ordered = moatIdx >= 0
            ? [b.table.metrics[moatIdx], ...b.table.metrics.filter((_, k) => k !== moatIdx)]
            : b.table.metrics;
          return (
            <div key={`peer-${i}`} className="peer-table-wrap">
              <table className="peer-table">
                <thead>
                  <tr>
                    <th></th>
                    {b.table.tickers.map((t) => <th key={t}>{t}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((m, j) => (
                    <tr key={j} className={/^moat\b/i.test(m.metric) ? "moat-row" : ""}>
                      <th scope="row">{m.metric}</th>
                      {m.values.map((v, k) => <td key={k}>{v}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.kind === "catalysts") {
          // Default-collapsed: catalysts are reference material, not the
          // headline. The original `### Catalysts (…)` H3 from markdown
          // renders above the toggle.
          return (
            <CollapsibleCards
              key={`catalysts-${i}`}
              count={b.catalysts.length}
              labelSingular="catalyst"
              labelPlural="catalysts"
            >
              <div className="risk-list">
                {b.catalysts.map((c, j) => (
                  <div key={j} className="risk-card">
                    <div className="top">
                      <div className="name">{c.catalyst}</div>
                      {c.type && <div className="type-pill">{c.type}</div>}
                    </div>
                    {c.date && (
                      <div className="meters">
                        <div className="meter" style={{ flex: "1 1 100%" }}>
                          <div className="lbl">Expected Date</div>
                          <div className="val" style={{ color: "var(--color-ink)" }}>{c.date}</div>
                        </div>
                      </div>
                    )}
                    {c.upside && (
                      <div className="mitigant">
                        <b>Upside if Confirmed</b>
                        {c.upside}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CollapsibleCards>
          );
        }
        if (b.kind === "risks") {
          return (
            <CollapsibleCards
              key={`risks-${i}`}
              count={b.risks.length}
              labelSingular="risk"
              labelPlural="risks"
            >
              <div className="risk-list">
                {b.risks.map((r, j) => (
                  <div key={j} className="risk-card">
                    <div className="top">
                      <div className="name">{r.risk}</div>
                      {r.type && <div className="type-pill">{r.type}</div>}
                    </div>
                    {(r.severity || r.probability) && (
                      <div className="meters">
                        {r.severity && (
                          <div className="meter">
                            <div className="lbl">Severity</div>
                            <div className={`val ${sevClass(r.severity)}`}>{r.severity}</div>
                          </div>
                        )}
                        {r.probability && (
                          <div className="meter">
                            <div className="lbl">Probability</div>
                            <div className={`val ${sevClass(r.probability)}`}>{r.probability}</div>
                          </div>
                        )}
                      </div>
                    )}
                    {r.mitigant && (
                      <div className="mitigant">
                        <b>Mitigant</b>
                        {r.mitigant}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CollapsibleCards>
          );
        }
        // ifthen — moved to Appendix at end of report; collapsed by default
        return (
          <div key={`ifthen-${i}`}>
            <h2 className="report-appendix-heading">Appendix</h2>
            <p className="report-appendix-lead">
              Reference framework. Each row is a belief that drives the verdict, the trigger that validates it, and the action if it holds or breaks.
            </p>
            <h3 className="report-cards-heading">{b.heading}</h3>
            <CollapsibleCards
              count={b.rows.length}
              labelSingular="row"
              labelPlural="rows"
            >
              <div className="ifthen-list">
                {b.rows.map((row, j) => (
                  <div key={j} className="ifthen-card">
                    {row.category && <div className="cat">{row.category}</div>}
                    {row.belief && <div className="belief">{row.belief}</div>}
                    {row.trigger && (
                      <div className="trigger">
                        <b>Validation trigger</b>
                        {row.trigger}
                      </div>
                    )}
                    {(row.ifConfirmed || row.ifViolated) && (
                      <div className="branches">
                        {row.ifConfirmed && (
                          <div className="branch confirmed">
                            <b>If confirmed</b>
                            {row.ifConfirmed}
                          </div>
                        )}
                        {row.ifViolated && (
                          <div className="branch violated">
                            <b>If violated</b>
                            {row.ifViolated}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CollapsibleCards>
          </div>
        );
      })}
    </>
  );
}

/* =============== MACRO DIRECTION CARD =============== */
/**
 * One of the three directional cards in the macro grid (Tailwinds /
 * Neutral / Headwinds). Empty groups are still rendered so the user
 * understands the bucket exists — just shows a faint "—" placeholder.
 */
function MacroCard({
  title, tone, rows,
}: {
  title: string;
  tone: "tail" | "neut" | "head";
  rows: { factor: string; direction: string; reason: string }[];
}) {
  return (
    <div className={`macro-card tone-${tone}`}>
      <div className="macro-head">
        <span className="macro-title">{title}</span>
        <span className="macro-count">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="macro-empty">—</div>
      ) : (
        <ul className="macro-list">
          {rows.map((r, i) => (
            <li key={i}>
              <span className="factor">{r.factor}</span>
              {r.direction && r.direction.toLowerCase() !== title.toLowerCase() && (
                <span className="qual"> · {r.direction}</span>
              )}
              {r.reason && <div className="reason">{r.reason}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* =============== COLLAPSIBLE CARDS =============== */
/**
 * Wraps a card-stack block (Risks, Catalysts, If-Then) behind a toggle.
 * Default state: collapsed — readers expand intentionally instead of
 * scrolling through 7-10 cards just to reach the next section.
 *
 * The label hints at what's behind the toggle: "Expand · 10 risks"
 * vs "Collapse · 10 risks".
 */
function CollapsibleCards({
  count, labelSingular, labelPlural, defaultOpen = false, children,
}: {
  count: number;
  labelSingular: string;
  labelPlural: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const label = count === 1 ? labelSingular : labelPlural;
  return (
    <div className="cc-wrap">
      <button
        type="button"
        className="cc-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="cc-chev" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="cc-text">
          {open ? "Collapse" : "Expand"} · <b>{count}</b> {label}
        </span>
      </button>
      {open && <div className="cc-body">{children}</div>}
    </div>
  );
}

/* =============== TICKER CHIP =============== */
function TickerChip({
  state, quote, ticker, starred, onToggleStar,
}: {
  state: "empty" | "loading" | "valid" | "invalid"; quote: Quote | null; ticker: string;
  starred: boolean; onToggleStar: (t: string, n?: string) => void;
}) {
  if (state === "empty") return <div className="ticker-chip" data-state="empty" />;
  if (state === "loading") {
    return (
      <div className="ticker-chip" data-state="loading">
        <span className="spin-circle" />
        <span>Looking up {ticker.toUpperCase()}…</span>
      </div>
    );
  }
  if (state === "invalid" || !quote) {
    return (
      <div className="ticker-chip" data-state="invalid">
        <span>No quote for <b>{ticker.toUpperCase()}</b> · check the symbol or try another exchange.</span>
      </div>
    );
  }
  const d = quote.prevClose != null ? deltaParts(quote.prevClose, quote.price) : null;
  return (
    <div className="ticker-chip" data-state="valid">
      <span className="sym">{quote.ticker}</span>
      {quote.name && <span className="name">{quote.name}</span>}
      {quote.exchange && <span className="exch">{quote.exchange}</span>}
      <span className="px">${fmt2(quote.price)}</span>
      {d && (
        <span className={`delta ${d.isPos ? "pos" : "neg"}`}>
          {d.arrow} {d.pct}
        </span>
      )}
      <button
        className="star-btn"
        data-starred={starred ? "true" : "false"}
        onClick={() => onToggleStar(quote.ticker, quote.name || undefined)}
        title={starred ? "Remove from Saved" : "Save ticker to Saved"}
        aria-label={starred ? "Remove from Saved" : "Save ticker"}
      >
        <StarIcon />
      </button>
    </div>
  );
}

/** Bookmark icon — matches the bottom-nav Saved icon. The same component
 *  is used everywhere a "save this ticker" affordance is shown so the
 *  visual vocabulary is consistent. The class .star-btn[data-starred]
 *  controls the fill/stroke. */
function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/* =============== LOOKUP CARD =============== */
function LookupCard({ quote, ticker, onClose }: { quote: Quote | null; ticker: string; onClose: () => void }) {
  if (!quote) {
    return (
      <div className="lookup-card">
        <button className="lookup-close" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" />
          </svg>
        </button>
        <div className="lookup-head">
          <span className="sym">{ticker || "—"}</span>
          <span className="name">Quote not available</span>
        </div>
        <p style={{ color: "var(--color-muted)", fontStyle: "italic", marginTop: 12, fontSize: 13.5 }}>
          Yahoo Finance returned no data for this ticker. Check the symbol, or try a US-listed equivalent.
        </p>
      </div>
    );
  }
  const d = quote.prevClose != null ? deltaParts(quote.prevClose, quote.price) : null;
  return (
    <div className="lookup-card">
      <button className="lookup-close" onClick={onClose} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" />
        </svg>
      </button>
      <div className="lookup-head">
        <span className="sym">{quote.ticker}</span>
        {quote.name && <span className="name">{quote.name}</span>}
        {quote.exchange && <span className="exch">{quote.exchange}</span>}
      </div>
      <div className="lookup-price">${fmt2(quote.price)}</div>
      {d && (
        <div className={`lookup-delta ${d.isPos ? "pos" : "neg"}`}>
          {d.arrow} {d.isPos ? "+" : "−"}{d.abs}  {d.pct}
          <span className="sub">today</span>
        </div>
      )}
      <div className="lookup-stats">
        {quote.prevClose != null && <Cell label="Prev Close" value={`$${fmt2(quote.prevClose)}`} />}
        {quote.dayLow != null && quote.dayHigh != null && (
          <Cell label="Day Range" value={`$${fmt2(quote.dayLow)} – $${fmt2(quote.dayHigh)}`} />
        )}
        {quote.w52Low != null && quote.w52High != null && (
          <Cell label="52W Range" value={`$${fmt2(quote.w52Low)} – $${fmt2(quote.w52High)}`} />
        )}
        {quote.volume != null && <Cell label="Volume" value={fmtVol(quote.volume)} />}
        {quote.currency && <Cell label="Currency" value={quote.currency} />}
      </div>
      <div className="lookup-foot">
        Updated {fmtTime(quote.asOf)} · {new Date(quote.asOf).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · Yahoo Finance
      </div>
    </div>
  );
}
function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="lbl">{label}</div>
      <div className="val">{value}</div>
    </div>
  );
}

/* =============== BYOK MODAL =============== */
function BYOKModal({
  userApiKey, forced, trialsLeft, trialLimit, onClose, onSave, onClear,
}: {
  userApiKey: string | null;
  forced: boolean;
  trialsLeft: number;
  trialLimit: number;
  onClose: () => void;
  onSave: (key: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");

  function handleSave() {
    const k = draft.trim();
    if (!k) { setErr("Paste your Anthropic API key first."); return; }
    if (!/^sk-ant-/.test(k)) { setErr("Doesn't look like an Anthropic API key. Should start with sk-ant-."); return; }
    onSave(k);
  }

  const masked = userApiKey
    ? `${userApiKey.slice(0, 12)}…${userApiKey.slice(-4)}`
    : "";

  return (
    <div className="byok-overlay" onClick={(e) => { if (e.target === e.currentTarget && !forced) onClose(); }}>
      <div className="byok-modal" onClick={(e) => e.stopPropagation()}>
        {userApiKey ? (
          <>
            <h3>API key connected</h3>
            <p className="lead">Analyses run against your Anthropic account. You can replace the key or remove it any time.</p>
            <div className="key-display">{masked}</div>
            <label htmlFor="byok-key">Replace with a new key</label>
            <input
              id="byok-key" type="password" autoFocus value={draft}
              onChange={(e) => { setDraft(e.target.value); setErr(""); }}
              placeholder="sk-ant-..."
            />
            {err && <div className="err">{err}</div>}
            <div className="actions">
              <button className="skip" onClick={onClear}>Remove key</button>
              <button onClick={onClose} className="rounded-md border border-[var(--color-line-2)] bg-white px-4 py-2 text-sm text-[var(--color-ink)]">
                Close
              </button>
              <button onClick={handleSave} className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm text-white">
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>{trialsLeft === 0 ? "Free trials used up" : "Connect your API key"}</h3>
            <p className="lead">
              {trialsLeft === 0
                ? <>You&apos;ve used your <b>{trialLimit}</b> free deep-dive analyses. Add your Anthropic API key to keep running unlimited analyses against your own account.</>
                : <>You have <b>{trialsLeft}</b> of <b>{trialLimit}</b> free analyses remaining. Add your Anthropic API key now to skip the limit, or use the rest of your free trials first.</>}
              {" "}Get one in 30 seconds at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com</a> — first $5 of credit is free. Your key stays in your browser; we never store it.
            </p>
            <label htmlFor="byok-key">Anthropic API key</label>
            <input
              id="byok-key" type="password" autoFocus value={draft}
              onChange={(e) => { setDraft(e.target.value); setErr(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              placeholder="sk-ant-..."
            />
            {err && <div className="err">{err}</div>}
            <div className="actions">
              {!forced && trialsLeft > 0 && (
                <button className="skip" onClick={onClose}>Maybe later</button>
              )}
              <button onClick={handleSave} className="rounded-md bg-[var(--color-accent)] px-5 py-2 text-sm text-white">
                Save key
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* =============== ASK PANEL (follow-up Q&A) =============== */
function AskPanel({
  page, ticker, input, setInput, loading, onAsk, onCancel, messages: messagesProp,
}: {
  page: ReportPage | null;
  ticker: string;
  input: string; setInput: (s: string) => void;
  loading: boolean; onAsk: () => void; onCancel: () => void;
  /** Override page.qa — used by the saved-detail panel which has no page. */
  messages?: QAMessage[];
}) {
  const messages = messagesProp ?? page?.qa ?? [];
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!loading) onAsk();
  }
  return (
    <div className="ask-panel">
      <div className="ask-head">
        <span className="ask-title">Ask follow-ups about {ticker || "this report"}</span>
        <span className="ask-sub">Questions are scoped to this analysis only.</span>
      </div>
      {messages.length > 0 && (
        <div className="ask-thread">
          {messages.map((m, i) => (
            <div key={i} className={`ask-msg ${m.role}`}>
              <div className="ask-role">{m.role === "user" ? "You" : "Co-Pilot"}</div>
              <div className="ask-content">
                {m.role === "assistant" && m.content === "" && loading && i === messages.length - 1 ? (
                  <span className="ask-thinking">
                    <span className="spin-circle" />
                    <span style={{ marginLeft: 8 }}>Thinking…</span>
                  </span>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={onSubmit} className="ask-form">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask about ${ticker || "this report"} — e.g. "Stress-test the bull case", "Why is the trim level $1,200?", "What if MFN drops 30%?"`}
          rows={2}
          disabled={loading}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!loading && input.trim()) onAsk();
            }
          }}
        />
        <div className="ask-actions">
          <span className="ask-hint">Enter to send · Shift+Enter for newline</span>
          {loading ? (
            <button type="button" onClick={onCancel} className="ask-btn ask-cancel">Cancel</button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="ask-btn ask-send">Ask</button>
          )}
        </div>
      </form>
    </div>
  );
}

/* =============== VERDICT BANNER =============== */
function VerdictBanner({ parsed }: { parsed: ParsedReport }) {
  if (!parsed.company) return null;
  const stats = parsed.asOfLine
    ? parsed.asOfLine.split(/\s*[·•]\s*/).map((s) => s.trim()).filter(Boolean)
    : [];
  const cls = pillClass(parsed.verdict);
  const pillText = parsed.verdict
    ? `${parsed.verdict}${parsed.verdictQualifier ? " · " + parsed.verdictQualifier : ""}`
    : null;
  const thresholds = parseThresholds(parsed.rangesLine);
  const currentPrice = parsePriceValue(parsed.price);
  return (
    <div className="verdict-banner">
      <div className="company">{parsed.company}</div>
      {pillText && (
        <div className="vb-pill-row">
          <span className={`pill ${cls}`}>{pillText}</span>
        </div>
      )}
      {parsed.metaLine && (
        <>
          <div className="meta" dangerouslySetInnerHTML={{
            __html: parsed.metaLine.replace(/\*\*([^*]+)\*\*/g, "$1"),
          }} />
          {/^.*?(\d+)[-\s]?month/i.test(parsed.metaLine) && (
            <div className="horizon-note">
              The {parsed.metaLine.match(/(\d+)[-\s]?month/i)?.[1]}-month horizon
              {" "}is calibrated to the data and catalysts visible for this name —
              the recommendation applies through that window.
            </div>
          )}
        </>
      )}
      {thresholds ? (
        <VerdictGauge thresholds={thresholds} currentPrice={currentPrice} />
      ) : parsed.rangesLine ? (
        <div className="verdict-line" dangerouslySetInnerHTML={{
          __html: parsed.rangesLine.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"),
        }} />
      ) : null}
      {stats.length > 0 && (
        <div className="stats">
          {stats.map((s, i) => {
            const m = s.match(/^([^:]+):\s*(.+)$/);
            if (!m) return <div key={i}>{s}</div>;
            return (
              <div key={i}>
                <b>{m[1]}</b><span className="num">{m[2]}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* =============== VERDICT GAUGE =============== */
function VerdictGauge({
  thresholds, currentPrice,
}: {
  thresholds: { full: number; buy: number; trim: number };
  currentPrice: number | null;
}) {
  const { full, buy, trim } = thresholds;
  const lo = Math.min(full, buy, trim);
  const hi = Math.max(full, buy, trim);
  const range = hi - lo;
  const pad = Math.max(range * 0.15, 1);
  const minBound = currentPrice != null ? Math.min(lo - pad, currentPrice - pad * 0.4) : lo - pad;
  const maxBound = currentPrice != null ? Math.max(hi + pad, currentPrice + pad * 0.4) : hi + pad;
  const span = maxBound - minBound || 1;
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - minBound) / span) * 100));
  const fullPct = pct(full);
  const buyPct = pct(buy);
  const trimPct = pct(trim);
  const pricePct = currentPrice != null ? pct(currentPrice) : null;

  // Sort tick positions so the colored zones land in the right order
  const lowPct = Math.min(fullPct, trimPct);
  const highPct = Math.max(fullPct, trimPct);

  return (
    <div className="verdict-gauge">
      <div className="gauge-labels">
        <div className="gauge-label" style={{ left: `${fullPct}%` }}>
          <div className="lbl">Full</div>
          <div className="val">&lt;{fmtThreshold(full)}</div>
        </div>
        <div className="gauge-label" style={{ left: `${buyPct}%` }}>
          <div className="lbl">Buy</div>
          <div className="val">&lt;{fmtThreshold(buy)}</div>
        </div>
        <div className="gauge-label" style={{ left: `${trimPct}%` }}>
          <div className="lbl">Trim</div>
          <div className="val">&gt;{fmtThreshold(trim)}</div>
        </div>
      </div>
      <div className="gauge-arrow-row">
        {pricePct !== null && (
          <div className="gauge-arrow" style={{ left: `${pricePct}%` }}>
            <span className="gauge-arrow-label">today</span>
            <span className="gauge-arrow-tri" aria-hidden />
          </div>
        )}
      </div>
      <div className="gauge-bar">
        <div className="gauge-zone zone-green"  style={{ left: 0, width: `${lowPct}%` }} />
        <div className="gauge-zone zone-yellow" style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }} />
        <div className="gauge-zone zone-red"    style={{ left: `${highPct}%`, width: `${100 - highPct}%` }} />
        <div className="gauge-tick" style={{ left: `${fullPct}%` }} />
        <div className="gauge-tick" style={{ left: `${trimPct}%` }} />
      </div>
      <div className="gauge-price-row">
        {pricePct !== null && currentPrice != null && (
          <div className="gauge-price" style={{ left: `${pricePct}%` }}>
            {fmtPrice(currentPrice)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Threshold prices: clean integer dollars (or K/M for large numbers). */
function fmtThreshold(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1_000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
/** Current price: cents for sub-$1,000 to show real precision; rounded above. */
function fmtPrice(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1_000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* =============== SAVED VIEW =============== */
type SavedGroup = {
  ticker: string; name: string;
  analyses: SavedAnalysis[];
  starred: boolean; starredAt: string | null;
};

function SavedView(props: {
  grouped: SavedGroup[];
  totalTickers: number;
  expandableCount: number;
  liveQuotes: Record<string, Quote | null>;
  openTickers: Set<string>; toggleTicker: (t: string) => void;
  allOpen: boolean; expandAll: (collapse: boolean) => void;
  confirmRowId: string | null; setConfirmRowId: (id: string | null) => void;
  confirmTicker: string | null; setConfirmTicker: (t: string | null) => void;
  removingId: string | null; removingTicker: string | null;
  onDeleteAnalysis: (id: string) => void;
  onDeleteTicker: (t: string) => void;
  onOpen: (item: SavedAnalysis) => void;
  onPickTicker: (ticker: string) => void;
  onToggleStar: (ticker: string, name?: string) => void;
}) {
  const {
    grouped, totalTickers, expandableCount, liveQuotes,
    openTickers, toggleTicker, allOpen, expandAll,
    confirmRowId, setConfirmRowId, confirmTicker, setConfirmTicker,
    removingId, removingTicker,
    onDeleteAnalysis, onDeleteTicker, onOpen, onPickTicker, onToggleStar,
  } = props;

  if (grouped.length === 0) {
    return (
      <div className="saved-head" style={{ marginTop: 32 }}>
        <h2>Saved</h2>
        <p className="count">Nothing saved yet — bookmark a ticker from the live-quote chip or a Brainstorm card, or save a full analysis from the bottom of any report.</p>
      </div>
    );
  }

  const totalAnalyses = grouped.reduce((n, g) => n + g.analyses.length, 0);

  return (
    <>
      <div className="saved-head">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h2>Saved</h2>
            <p className="count">
              <b>{totalTickers}</b> {totalTickers === 1 ? "ticker" : "tickers"}
              {totalAnalyses > 0 && <> · <b>{totalAnalyses}</b> {totalAnalyses === 1 ? "analysis" : "analyses"}</>}
              {" "}· newest first
            </p>
          </div>
          {expandableCount > 0 && (
            <button
              className="rounded-md border border-[var(--color-line)] bg-transparent px-3 py-1.5 text-xs text-[var(--color-muted)] transition hover:border-[var(--color-line-2)] hover:text-[var(--color-ink)]"
              onClick={() => expandAll(allOpen)}
            >
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>
      </div>

      {grouped.map((g) => {
        const isOpen = openTickers.has(g.ticker);
        const isConfirmTicker = confirmTicker === g.ticker;
        const isRemovingTicker = removingTicker === g.ticker;
        const starredOnly = g.starred && g.analyses.length === 0;
        const hasAnalyses = g.analyses.length > 0;
        return (
          <div
            key={g.ticker}
            className={`ticker-group ${isRemovingTicker ? "removing" : ""} ${starredOnly ? "starred-only" : ""}`}
            data-open={isOpen ? "true" : "false"}
          >
            <div
              className="ticker-head"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest(".icon-btn, .confirm-bar, .star-btn, a")) return;
                if (isConfirmTicker || starredOnly) return;
                toggleTicker(g.ticker);
              }}
            >
              {!isConfirmTicker ? (
                <>
                  <button
                    className="star-btn"
                    data-starred={g.starred ? "true" : "false"}
                    onClick={(e) => { e.stopPropagation(); onToggleStar(g.ticker, g.name); }}
                    title={g.starred ? "Remove from Saved" : "Save ticker"}
                    aria-label={g.starred ? "Remove from Saved" : "Save ticker"}
                  >
                    <StarIcon />
                  </button>
                  <span className="sym">{g.ticker}</span>
                  <span className="name">{g.name}</span>
                  {starredOnly ? (
                    <span className="starred-only-action">
                      no analyses saved · <a onClick={(e) => { e.stopPropagation(); onPickTicker(g.ticker); }}>run one →</a>
                    </span>
                  ) : (
                    <span className="toggle">
                      {hasAnalyses && (
                        <button
                          className="icon-btn"
                          title={`Delete all saved analyses for ${g.ticker}`}
                          onClick={(e) => { e.stopPropagation(); setConfirmTicker(g.ticker); }}
                        >
                          {TRASH_SVG}
                        </button>
                      )}
                      <span className="count">{g.analyses.length}</span>
                      <span className="chev" aria-hidden>{CHEV_SVG}</span>
                    </span>
                  )}
                </>
              ) : (
                <div className="confirm-bar" style={{ width: "100%" }}>
                  <span className="msg">
                    Delete all <b>{g.analyses.length}</b> saved {g.analyses.length === 1 ? "analysis" : "analyses"} for <b>{g.ticker}</b>?
                  </span>
                  <span className="actions">
                    <button onClick={(e) => { e.stopPropagation(); setConfirmTicker(null); }}>Cancel</button>
                    <button className="danger" onClick={(e) => { e.stopPropagation(); onDeleteTicker(g.ticker); }}>Delete</button>
                  </span>
                </div>
              )}
            </div>

            {isOpen && hasAnalyses && (
              <div className="ticker-list">
                {g.analyses.map((a) => {
                  const live = liveQuotes[a.ticker];
                  const d = (live && a.priceNumber != null) ? deltaParts(a.priceNumber, live.price) : null;
                  const isConfirmRow = confirmRowId === a.id;
                  const isRemovingRow = removingId === a.id;
                  return (
                    <div
                      key={a.id}
                      className={`saved-row ${isRemovingRow ? "removing" : ""} ${isConfirmRow ? "confirming" : ""}`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest(".icon-btn, .row-trash, .confirm-bar")) return;
                        if (isConfirmRow) return;
                        onOpen(a);
                      }}
                    >
                      {!isConfirmRow ? (
                        <>
                          <div className="when">
                            {fmtWhen(a.savedAt)}<small>{fmtTime(a.savedAt)}</small>
                          </div>
                          <div className="verdict-cell">
                            <span className={`pill ${pillClass(a.verdict)}`}>{a.verdict || "—"}</span>
                          </div>
                          {a.qualifier && <div className="qualifier">{a.qualifier}</div>}
                          <div className="px-stack">
                            {/* Saved-at price — cents, no leading "~" */}
                            <span className="saved-px">
                              saved at <b>${a.priceNumber != null ? fmt2(a.priceNumber) : (a.price ?? "—")}</b>
                            </span>
                            {/* Now price + delta */}
                            {d && live && (
                              <span className="now-line">
                                now <span className="now">${fmt2(live.price)}</span>
                                <span className={`pct ${d.isPos ? "pos" : "neg"}`}>
                                  {d.arrow} {d.pct}
                                </span>
                              </span>
                            )}
                          </div>
                          <button
                            className="row-trash"
                            title="Delete this analysis"
                            aria-label="Delete this analysis"
                            onClick={(e) => { e.stopPropagation(); setConfirmRowId(a.id); }}
                          >
                            {TRASH_SVG}
                          </button>
                        </>
                      ) : (
                        <div className="confirm-bar" style={{ gridColumn: "1 / -1" }}>
                          <span className="msg">
                            Delete the <b>{fmtWhen(a.savedAt)}</b> analysis for <b>{a.ticker}</b>?
                          </span>
                          <span className="actions">
                            <button onClick={(e) => { e.stopPropagation(); setConfirmRowId(null); }}>Cancel</button>
                            <button className="danger" onClick={(e) => { e.stopPropagation(); onDeleteAnalysis(a.id); }}>Delete</button>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/* =============== SAVED DETAIL VIEW =============== */
/**
 * Full-screen detail panel that shows a saved analysis WITHOUT touching
 * the Analyze tab's state. Lives inside the Saved tab — close (×) drops
 * back to the saved list, "Re-run analysis" hands off to the Analyze tab
 * with a fresh queued run.
 */
function SavedDetailView(props: {
  item: SavedAnalysis;
  parsed: ParsedReport;
  onClose: () => void;
  onRerun: () => void;
  askInput: string; setAskInput: (s: string) => void;
  askLoading: boolean;
  onAsk: () => void;
  onCancelAsk: () => void;
  savedQA: QAMessage[];
}) {
  const { item, parsed, onClose, onRerun, askInput, setAskInput, askLoading, onAsk, onCancelAsk, savedQA } = props;
  return (
    <div className="saved-detail">
      <div className="saved-detail-bar">
        <div className="meta">
          <span className="ticker">{item.ticker}</span>
          <span className="sep">·</span>
          <span className="when">Saved {fmtWhen(item.savedAt)} · {fmtTime(item.savedAt)}</span>
          <span className="rel">({fmtRel(item.savedAt)})</span>
        </div>
        <div className="actions">
          <button className="rerun-link" onClick={onRerun} title="Run a fresh analysis on this ticker">
            Re-run analysis →
          </button>
          <button
            className="saved-close"
            onClick={onClose}
            aria-label="Close saved analysis"
            title="Close (return to Saved list)"
          >×</button>
        </div>
      </div>

      <div className="mt-4 space-y-6">
        <VerdictBanner parsed={parsed} />
        {parsed.body.trim() && (
          <article className="prose rounded-lg border border-[var(--color-line)] bg-white p-8 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <ReportBody body={parsed.body} />
          </article>
        )}
        <AskPanel
          page={null}
          ticker={item.ticker}
          input={askInput}
          setInput={setAskInput}
          loading={askLoading}
          onAsk={onAsk}
          onCancel={onCancelAsk}
          messages={savedQA}
        />
      </div>
    </div>
  );
}

/* =============== HUNTER VIEW =============== */
function HunterView(props: {
  huntState: HuntState; huntPrompt: string; setHuntPrompt: (s: string) => void;
  huntResults: HunterTicker[]; huntError: string; huntElapsed: number;
  quip: string; quipFade: boolean; spinFrame: number;
  askHunter: (e?: React.FormEvent) => void; closeHunter: () => void; clearHunter: () => void;
  editHunterPrompt: () => void; pickHunterTicker: (sym: string) => void;
  starred: StarredMap;
  onToggleStar: (ticker: string, name?: string) => void;
}) {
  const {
    huntState, huntPrompt, setHuntPrompt, huntResults, huntError, huntElapsed,
    quip, quipFade, spinFrame,
    askHunter, closeHunter, clearHunter, editHunterPrompt, pickHunterTicker,
    starred, onToggleStar,
  } = props;
  return (
    <>
      <div className="saved-head" style={{ marginBottom: 8 }}>
        <h2>Brainstorm for Ideas</h2>
        <p className="count">Describe what you&apos;re looking for. Co-pilot returns 10 ranked picks with rationale.</p>
      </div>

      <div className="hunter-prompt">
          <form onSubmit={askHunter}>
            <textarea
              autoFocus
              value={huntPrompt}
              onChange={(e) => setHuntPrompt(e.target.value)}
              placeholder="e.g. defensive dividend payers benefiting from a falling-rate cycle, US-listed, market cap > 20B"
              disabled={huntState === "thinking"}
              maxLength={2000}
            />
            <div className="hunter-actions">
              <span className="hunter-hint">
                {huntState === "thinking" ? (
                  <>
                    <span aria-hidden className="inline-block w-3 text-center font-mono text-base leading-none text-[var(--color-accent-2)]">{SPINNER_FRAMES[spinFrame]}</span>
                    <span> Sourcing ideas… {huntElapsed}s</span>
                    <div className={`mt-1 italic transition-opacity duration-200 ${quipFade ? "opacity-70" : "opacity-0"}`} style={{ fontFamily: "var(--font-serif)" }}>
                      {quip}
                    </div>
                  </>
                ) : huntState === "error" ? (
                  <span style={{ color: "var(--color-neg)" }}>{huntError || "Something went wrong. Try again."}</span>
                ) : (
                  "Be specific. Mention sectors, market caps, themes, or constraints."
                )}
              </span>
              {(huntState === "thinking" || huntState === "error") && (
                <button
                  type="button"
                  onClick={closeHunter}
                  className="rounded-md border border-[var(--color-line-2)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-muted)] transition hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
                >
                  {huntState === "thinking" ? "Cancel" : "Close"}
                </button>
              )}
              <button
                type="submit"
                disabled={!huntPrompt.trim() || huntState === "thinking"}
                className="rounded-md bg-[var(--color-accent)] px-5 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-[var(--color-accent-2)] disabled:cursor-not-allowed disabled:opacity-30"
              >
                {huntState === "thinking" ? "Thinking…" : huntState === "done" ? "Ask again" : "Ask AI"}
              </button>
            </div>
          </form>
        </div>

      {huntState === "done" && huntResults.length > 0 && (
        <div className="hunter-results">
          <button
            className="hunter-close"
            onClick={clearHunter}
            aria-label="Clear hunter results"
            title="Clear results and prompt"
          >×</button>
          <div className="head">
            <div>
              <div className="title">Co-pilot ranked these {huntResults.length} ideas</div>
              <div className="source">Most recommended first · click <b>Run Analysis</b> to deep-dive any of them</div>
            </div>
          </div>
          {huntResults.map((t, i) => {
            const isStarred = !!starred[t.symbol.toUpperCase()];
            return (
              <div key={`${t.symbol}-${i}`} className="hunter-card">
                <div className="hc-head">
                  <div className="hc-rank">{i + 1}</div>
                  <div className="hc-id">
                    <span className="hc-sym">{t.symbol}</span>
                    {t.exchange && <span className="hc-exch">{t.exchange}</span>}
                  </div>
                </div>
                {t.name && <div className="hc-name">{t.name}</div>}
                <div className="hc-divider" />
                <div className="hc-rationale">{t.rationale}</div>
                <div className="hc-divider" />
                <div className="hc-actions">
                  <button className="hc-btn hc-btn-run" onClick={() => pickHunterTicker(t.symbol)}>
                    Run Analysis →
                  </button>
                  <button
                    className="hc-btn hc-btn-save"
                    data-starred={isStarred ? "true" : "false"}
                    onClick={() => onToggleStar(t.symbol, t.name)}
                  >
                    <StarIcon />
                    <span>{isStarred ? "Saved" : "Save Ticker"}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

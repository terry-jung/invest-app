/**
 * File-based saved-analysis storage. Files live at:
 *   <project-root>/output/saved-analyses/<TICKER>/<id>.json
 *
 * Each file is the full SavedAnalysis record so opening one is one read.
 * Listing is a recursive scan — fine for the 10–500 saves a single user
 * is ever realistically going to accumulate.
 */

import { readFile, writeFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type SavedAnalysis = {
  id: string;
  ticker: string;
  name: string;
  savedAt: string; // ISO
  verdict: string | null;
  qualifier: string | null;
  metaLine: string | null;
  rangesLine: string | null;
  asOf: string | null;
  price: string | null;       // raw e.g. "~$870"
  priceNumber: number | null; // parsed numeric for delta math
  marketCap: string | null;
  body: string;               // full markdown
};

/**
 * Storage root — resolution priority:
 *   1. SAVED_ANALYSES_DIR env var (set on Railway → mounted volume at /data)
 *   2. Default to <project-root>/../output/saved-analyses for local dev
 *
 * On Railway we mount a persistent volume at /data and set
 * SAVED_ANALYSES_DIR=/data/saved-analyses so writes survive deploys.
 * Local dev keeps writing into the repo's output/ folder as before.
 */
const ROOT = process.env.SAVED_ANALYSES_DIR
  ? process.env.SAVED_ANALYSES_DIR
  : path.join(process.cwd(), "..", "output", "saved-analyses");

function dirFor(ticker: string) {
  return path.join(ROOT, ticker.toUpperCase());
}
function fileFor(ticker: string, id: string) {
  return path.join(dirFor(ticker), `${id}.json`);
}

export async function saveAnalysis(item: SavedAnalysis): Promise<SavedAnalysis> {
  const dir = dirFor(item.ticker);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(fileFor(item.ticker, item.id), JSON.stringify(item, null, 2), "utf8");
  return item;
}

export async function listSaved(): Promise<SavedAnalysis[]> {
  if (!existsSync(ROOT)) return [];
  const tickers = await readdir(ROOT);
  const all: SavedAnalysis[] = [];
  for (const t of tickers) {
    const d = path.join(ROOT, t);
    let s; try { s = await stat(d); } catch { continue; }
    if (!s.isDirectory()) continue;
    const files = await readdir(d);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const txt = await readFile(path.join(d, f), "utf8");
        all.push(JSON.parse(txt) as SavedAnalysis);
      } catch { /* skip corrupted */ }
    }
  }
  all.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  return all;
}

export async function getSaved(id: string): Promise<SavedAnalysis | null> {
  const list = await listSaved();
  return list.find(x => x.id === id) ?? null;
}

export async function deleteSaved(id: string): Promise<boolean> {
  const item = await getSaved(id);
  if (!item) return false;
  await rm(fileFor(item.ticker, item.id));
  // If the ticker dir is now empty, remove it too.
  try {
    const remaining = await readdir(dirFor(item.ticker));
    if (remaining.length === 0) await rm(dirFor(item.ticker), { recursive: true });
  } catch { /* ignore */ }
  return true;
}

export async function deleteTicker(ticker: string): Promise<number> {
  const dir = dirFor(ticker);
  if (!existsSync(dir)) return 0;
  const files = await readdir(dir);
  let n = 0;
  for (const f of files) {
    await rm(path.join(dir, f));
    n++;
  }
  try { await rm(dir, { recursive: true }); } catch { /* ignore */ }
  return n;
}

/* ---------- helpers ---------- */

export function newId(savedAt: string): string {
  // Filesystem-safe ISO timestamp.
  return savedAt.replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

export function parsePriceNumber(rawPrice: string | null): number | null {
  if (!rawPrice) return null;
  const m = rawPrice.replace(/[, ]/g, "").match(/-?\$?(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/* ---------- starred tickers (no analysis required) ---------- */

export type StarredEntry = { name: string; starredAt: string };
export type StarredMap = Record<string, StarredEntry>;

const STARRED_FILE = path.join(ROOT, "_starred.json");

export async function loadStarred(): Promise<StarredMap> {
  try {
    if (!existsSync(STARRED_FILE)) return {};
    const txt = await readFile(STARRED_FILE, "utf8");
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === "object" ? (parsed as StarredMap) : {};
  } catch {
    return {};
  }
}

async function saveStarredMap(map: StarredMap): Promise<void> {
  if (!existsSync(ROOT)) await mkdir(ROOT, { recursive: true });
  await writeFile(STARRED_FILE, JSON.stringify(map, null, 2), "utf8");
}

export async function addStar(ticker: string, name?: string): Promise<StarredEntry> {
  const t = ticker.toUpperCase();
  const map = await loadStarred();
  const entry: StarredEntry = {
    name: (name && name.trim()) || map[t]?.name || t,
    starredAt: map[t]?.starredAt || new Date().toISOString(),
  };
  map[t] = entry;
  await saveStarredMap(map);
  return entry;
}

export async function removeStar(ticker: string): Promise<boolean> {
  const t = ticker.toUpperCase();
  const map = await loadStarred();
  if (!(t in map)) return false;
  delete map[t];
  await saveStarredMap(map);
  return true;
}

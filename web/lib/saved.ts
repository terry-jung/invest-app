/**
 * File-based saved-analysis storage, partitioned per user. Files live at:
 *   <ROOT>/<userId>/<TICKER>/<id>.json
 *
 * Each file is the full SavedAnalysis record so opening one is one read.
 * Every function takes a `userId` argument — there's no global namespace.
 *
 * Listing is a recursive scan of one user's tree — fine for the 10–500
 * saves a single user is realistically going to accumulate.
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

function userRoot(userId: string) {
  return path.join(ROOT, userId);
}
function dirFor(userId: string, ticker: string) {
  return path.join(userRoot(userId), ticker.toUpperCase());
}
function fileFor(userId: string, ticker: string, id: string) {
  return path.join(dirFor(userId, ticker), `${id}.json`);
}

export async function saveAnalysis(userId: string, item: SavedAnalysis): Promise<SavedAnalysis> {
  const dir = dirFor(userId, item.ticker);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(fileFor(userId, item.ticker, item.id), JSON.stringify(item, null, 2), "utf8");
  return item;
}

export async function listSaved(userId: string): Promise<SavedAnalysis[]> {
  const root = userRoot(userId);
  if (!existsSync(root)) return [];
  const tickers = await readdir(root);
  const all: SavedAnalysis[] = [];
  for (const t of tickers) {
    const d = path.join(root, t);
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

export async function getSaved(userId: string, id: string): Promise<SavedAnalysis | null> {
  const list = await listSaved(userId);
  return list.find(x => x.id === id) ?? null;
}

export async function deleteSaved(userId: string, id: string): Promise<boolean> {
  const item = await getSaved(userId, id);
  if (!item) return false;
  await rm(fileFor(userId, item.ticker, item.id));
  // If the ticker dir is now empty, remove it too.
  try {
    const remaining = await readdir(dirFor(userId, item.ticker));
    if (remaining.length === 0) await rm(dirFor(userId, item.ticker), { recursive: true });
  } catch { /* ignore */ }
  return true;
}

export async function deleteTicker(userId: string, ticker: string): Promise<number> {
  const dir = dirFor(userId, ticker);
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

function starredFile(userId: string) {
  return path.join(userRoot(userId), "_starred.json");
}

export async function loadStarred(userId: string): Promise<StarredMap> {
  try {
    const f = starredFile(userId);
    if (!existsSync(f)) return {};
    const txt = await readFile(f, "utf8");
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === "object" ? (parsed as StarredMap) : {};
  } catch {
    return {};
  }
}

async function saveStarredMap(userId: string, map: StarredMap): Promise<void> {
  const root = userRoot(userId);
  if (!existsSync(root)) await mkdir(root, { recursive: true });
  await writeFile(starredFile(userId), JSON.stringify(map, null, 2), "utf8");
}

export async function addStar(userId: string, ticker: string, name?: string): Promise<StarredEntry> {
  const t = ticker.toUpperCase();
  const map = await loadStarred(userId);
  const entry: StarredEntry = {
    name: (name && name.trim()) || map[t]?.name || t,
    starredAt: map[t]?.starredAt || new Date().toISOString(),
  };
  map[t] = entry;
  await saveStarredMap(userId, map);
  return entry;
}

export async function removeStar(userId: string, ticker: string): Promise<boolean> {
  const t = ticker.toUpperCase();
  const map = await loadStarred(userId);
  if (!(t in map)) return false;
  delete map[t];
  await saveStarredMap(userId, map);
  return true;
}

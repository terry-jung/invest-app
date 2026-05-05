/**
 * SQLite database for users + invite codes.
 *
 * File location:
 *   - Production (Railway): DB_PATH=/data/app.db (mounted volume)
 *   - Local dev: ../output/app.db (matches saved-analyses pattern)
 *
 * Schema is migrated idempotently on first connection — no separate
 * migration step. Saved-analysis JSON files stay on disk under their
 * own per-user partition (see lib/saved.ts).
 */

import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

let _db: Database.Database | null = null;

function resolveDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  // Default for local dev: <repo-root>/output/app.db
  return path.resolve(process.cwd(), "..", "output", "app.db");
}

export function db(): Database.Database {
  if (_db) return _db;
  const p = resolveDbPath();
  mkdirSync(path.dirname(p), { recursive: true });
  const conn = new Database(p);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA);
  // Idempotent column adds for existing databases. SQLite errors if a
  // column already exists; we swallow that case so this is safe to run
  // every boot. Anything else re-throws.
  for (const stmt of MIGRATIONS) {
    try { conn.exec(stmt); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column name/i.test(msg)) throw e;
    }
  }
  bootstrapOwnerUser(conn);
  _db = conn;
  return conn;
}

/**
 * If OWNER_EMAIL is set and no user exists for it yet, create a shell
 * user record. The owner can then sign in via magic link without ever
 * dealing with an invite code or password — the password_hash is a
 * non-bcrypt sentinel that bcrypt.compare() always rejects. If the
 * owner wants to set a real password later, the forgot-password flow
 * (with an invite code) will overwrite it.
 */
function bootstrapOwnerUser(conn: Database.Database) {
  const raw = process.env.OWNER_EMAIL?.trim().toLowerCase();
  if (!raw) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return;
  const existing = conn.prepare("SELECT id FROM users WHERE email = ?").get(raw);
  if (existing) return;

  const id = randomUUID();
  // Sentinel that bcrypt.compare() always rejects — magic-link-only.
  const passwordHash = "MAGIC_LINK_ONLY_NO_PASSWORD_SET";
  const createdAt = new Date().toISOString();
  conn.prepare(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, raw, passwordHash, createdAt);
  console.log(`[bootstrap] created shell owner user for ${raw}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  note TEXT,
  created_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_redeemed ON invite_codes(redeemed_at);

CREATE TABLE IF NOT EXISTS invite_redemptions (
  code TEXT NOT NULL REFERENCES invite_codes(code) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,           -- 'signup' | 'reset'
  redeemed_at TEXT NOT NULL,
  PRIMARY KEY (code, user_id, redeemed_at)
);
CREATE INDEX IF NOT EXISTS idx_invite_redemptions_user ON invite_redemptions(user_id);
`;

// Adds for tables that existed before max_uses/uses were introduced.
// Runs every boot; "duplicate column" is swallowed.
const MIGRATIONS = [
  `ALTER TABLE invite_codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE invite_codes ADD COLUMN uses INTEGER NOT NULL DEFAULT 0`,
  // Backfill: any pre-existing redeemed code counts as 1 use.
  `UPDATE invite_codes SET uses = 1 WHERE redeemed_at IS NOT NULL AND uses = 0`,
];

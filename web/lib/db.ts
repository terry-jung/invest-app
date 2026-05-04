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
  _db = conn;
  return conn;
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
  redeemed_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_redeemed ON invite_codes(redeemed_at);
`;

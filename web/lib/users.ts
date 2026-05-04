/**
 * User CRUD over SQLite. Passwords stored as bcrypt hashes (cost 12).
 *
 * Email is normalized to lowercase + trimmed before storage and lookup
 * — UNIQUE constraint at the SQL level catches races, but we always
 * pre-check so we can return a useful error message.
 */

import { hash, compare } from "bcryptjs";
import { randomUUID } from "node:crypto";
import { db } from "./db";

export type User = {
  id: string;
  email: string;
  created_at: string;
  last_login_at: string | null;
};

const BCRYPT_COST = 12;

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}

export function isValidPassword(raw: string): boolean {
  return raw.length >= 8 && raw.length <= 256;
}

export async function createUser(email: string, password: string): Promise<User> {
  const normalized = normalizeEmail(email);
  const existing = db().prepare("SELECT id FROM users WHERE email = ?").get(normalized);
  if (existing) throw new Error("EMAIL_TAKEN");

  const id = randomUUID();
  const passwordHash = await hash(password, BCRYPT_COST);
  const createdAt = new Date().toISOString();
  db().prepare(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, normalized, passwordHash, createdAt);

  return { id, email: normalized, created_at: createdAt, last_login_at: null };
}

export async function verifyUserPassword(email: string, password: string): Promise<User | null> {
  const normalized = normalizeEmail(email);
  const row = db().prepare(
    "SELECT id, email, password_hash, created_at, last_login_at FROM users WHERE email = ?"
  ).get(normalized) as
    | { id: string; email: string; password_hash: string; created_at: string; last_login_at: string | null }
    | undefined;
  if (!row) return null;

  const ok = await compare(password, row.password_hash);
  if (!ok) return null;

  const now = new Date().toISOString();
  db().prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, row.id);

  return {
    id: row.id,
    email: row.email,
    created_at: row.created_at,
    last_login_at: now,
  };
}

export function getUserById(id: string): User | null {
  const row = db().prepare(
    "SELECT id, email, created_at, last_login_at FROM users WHERE id = ?"
  ).get(id) as User | undefined;
  return row ?? null;
}

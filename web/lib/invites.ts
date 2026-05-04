/**
 * Invite-code CRUD with multi-use cap. Codes are 12-char base32
 * (e.g. "K7H3-9XQ2-MZRT") — random 60 bits of entropy.
 *
 * Each code carries a `max_uses` cap and a `uses` counter. Redemption
 * is atomic: a single UPDATE that only succeeds when `uses < max_uses`.
 * Each successful redemption also writes an `invite_redemptions` row
 * for audit (which user, when, signup-vs-reset).
 */

import { randomBytes } from "node:crypto";
import { db } from "./db";

export type InviteCode = {
  code: string;
  note: string | null;
  created_at: string;
  max_uses: number;
  uses: number;
  redemptions: Array<{ user_id: string; email: string | null; kind: string; redeemed_at: string }>;
};

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // base32 minus 0/1/I/O ambiguity

function generateCode(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
    if (i === 3 || i === 7) out += "-";
  }
  return out;
}

export function createInvite(note: string | null, maxUses: number): InviteCode {
  const cap = Math.max(1, Math.min(1000, Math.floor(maxUses) || 1));
  const code = generateCode();
  const createdAt = new Date().toISOString();
  db().prepare(
    "INSERT INTO invite_codes (code, note, created_at, max_uses, uses) VALUES (?, ?, ?, ?, 0)"
  ).run(code, note, createdAt, cap);
  return { code, note, created_at: createdAt, max_uses: cap, uses: 0, redemptions: [] };
}

/**
 * Atomically redeem `code` for `userId`. Returns true if the code had
 * remaining uses and just got incremented; false if it was used up or
 * doesn't exist. The accompanying audit row in `invite_redemptions`
 * is only written on success.
 */
export function redeemInvite(code: string, userId: string, kind: "signup" | "reset"): boolean {
  const result = db().prepare(
    "UPDATE invite_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses"
  ).run(code);
  if (result.changes === 0) return false;

  const now = new Date().toISOString();
  db().prepare(
    "INSERT INTO invite_redemptions (code, user_id, kind, redeemed_at) VALUES (?, ?, ?, ?)"
  ).run(code, userId, kind, now);
  return true;
}

export function isInviteRedeemable(code: string): boolean {
  const row = db().prepare(
    "SELECT max_uses, uses FROM invite_codes WHERE code = ?"
  ).get(code) as { max_uses: number; uses: number } | undefined;
  if (!row) return false;
  return row.uses < row.max_uses;
}

export function listInvites(): InviteCode[] {
  const rows = db().prepare(
    `SELECT code, note, created_at, max_uses, uses
     FROM invite_codes
     ORDER BY created_at DESC`
  ).all() as Array<Omit<InviteCode, "redemptions">>;

  if (rows.length === 0) return [];

  const codes = rows.map((r) => r.code);
  const placeholders = codes.map(() => "?").join(",");
  const reds = db().prepare(
    `SELECT r.code, r.user_id, r.kind, r.redeemed_at, u.email
     FROM invite_redemptions r
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.code IN (${placeholders})
     ORDER BY r.redeemed_at ASC`
  ).all(...codes) as Array<{ code: string; user_id: string; kind: string; redeemed_at: string; email: string | null }>;

  const byCode = new Map<string, InviteCode["redemptions"]>();
  for (const r of reds) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code)!.push({ user_id: r.user_id, email: r.email, kind: r.kind, redeemed_at: r.redeemed_at });
  }

  return rows.map((r) => ({ ...r, redemptions: byCode.get(r.code) ?? [] }));
}

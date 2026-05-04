/**
 * Invite-code CRUD. Codes are 12-char base32 (e.g. "K7H3-9XQ2-MZRT")
 * — random 60 bits of entropy, plenty for an invite-only app.
 *
 * Redemption is atomic: a single UPDATE that only succeeds if the code
 * is still unredeemed. Caller checks `changes` to know if it landed.
 */

import { randomBytes } from "node:crypto";
import { db } from "./db";

export type InviteCode = {
  code: string;
  note: string | null;
  created_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
  redeemed_email: string | null;
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

export function createInvite(note: string | null): InviteCode {
  const code = generateCode();
  const createdAt = new Date().toISOString();
  db().prepare(
    "INSERT INTO invite_codes (code, note, created_at) VALUES (?, ?, ?)"
  ).run(code, note, createdAt);
  return {
    code,
    note,
    created_at: createdAt,
    redeemed_at: null,
    redeemed_by: null,
    redeemed_email: null,
  };
}

/**
 * Atomically redeem `code` for `userId`. Returns true if the code was
 * unredeemed and just got marked redeemed; false if it was already
 * redeemed or doesn't exist. Caller is responsible for creating the
 * user first and for rolling back the user creation if this returns
 * false (or — easier — verifying the code's redeemability before
 * creating the user, then redeeming after; race window is tiny but
 * the unique-email constraint catches duplicates).
 */
export function redeemInvite(code: string, userId: string): boolean {
  const now = new Date().toISOString();
  const result = db().prepare(
    "UPDATE invite_codes SET redeemed_at = ?, redeemed_by = ? WHERE code = ? AND redeemed_at IS NULL"
  ).run(now, userId, code);
  return result.changes > 0;
}

export function isInviteRedeemable(code: string): boolean {
  const row = db().prepare(
    "SELECT redeemed_at FROM invite_codes WHERE code = ?"
  ).get(code) as { redeemed_at: string | null } | undefined;
  if (!row) return false;
  return row.redeemed_at === null;
}

export function listInvites(): InviteCode[] {
  const rows = db().prepare(
    `SELECT i.code, i.note, i.created_at, i.redeemed_at, i.redeemed_by,
            u.email AS redeemed_email
     FROM invite_codes i
     LEFT JOIN users u ON u.id = i.redeemed_by
     ORDER BY i.created_at DESC`
  ).all() as InviteCode[];
  return rows;
}

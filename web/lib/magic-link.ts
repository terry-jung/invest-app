/**
 * Magic-link sign-in tokens. Same HMAC pattern as the session cookie
 * but with a much shorter TTL (15 min) and a `kind` discriminator so
 * a session token can't be reused as a magic link or vice versa.
 *
 * Token format: `magic.<userId>.<exp>.<sig>`
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_SEC = 15 * 60;

function secret(): string {
  const s = process.env.OWNER_SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("OWNER_SESSION_SECRET is missing or too short (need 16+ chars).");
  }
  return s;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function makeMagicToken(userId: string): string {
  const exp = String(Math.floor(Date.now() / 1000) + TTL_SEC);
  const payload = `magic.${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyMagicToken(token: string | null | undefined): { userId: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [tag, userId, exp, sig] = parts;
  if (tag !== "magic" || !userId || !exp || !sig) return null;
  const payload = `magic.${userId}.${exp}`;
  if (!safeStringEqual(sign(payload), sig)) return null;
  const expN = parseInt(exp, 10);
  if (!Number.isFinite(expN) || expN <= Math.floor(Date.now() / 1000)) return null;
  return { userId };
}

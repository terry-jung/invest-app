/**
 * Multi-user auth: HMAC-signed session cookie that encodes a user id.
 *
 * Token format: `<userId>.<expEpochSeconds>.<base64urlHmacSig>`
 * The signature is computed over `<userId>.<expEpochSeconds>` so any
 * tampering with either field invalidates it.
 *
 * Admin actions (generating invite codes) are NOT user sessions — they're
 * gated by the OWNER_PASSPHRASE env var sent as a header. That keeps the
 * admin surface separate from the regular user auth surface.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "owner_session";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

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

export function makeSessionToken(userId: string): string {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC);
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function parseSessionToken(token: string | null | undefined): { userId: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  if (!userId || !exp || !sig) return null;
  const payload = `${userId}.${exp}`;
  if (!safeStringEqual(sign(payload), sig)) return null;
  const expN = parseInt(exp, 10);
  if (!Number.isFinite(expN) || expN <= Math.floor(Date.now() / 1000)) return null;
  return { userId };
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === COOKIE_NAME) return trimmed.slice(eq + 1);
  }
  return null;
}

export function getSessionUserId(req: Request): string | null {
  return parseSessionToken(readSessionCookie(req))?.userId ?? null;
}

export function buildSetCookie(value: string, maxAgeSec: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookie(): string {
  return buildSetCookie("", 0);
}

/** Constant-time check of the OWNER_PASSPHRASE env var for admin endpoints. */
export function verifyOwnerPassphrase(input: string): boolean {
  const p = process.env.OWNER_PASSPHRASE;
  if (!p) return false;
  if (input.length === 0) return false;
  return safeStringEqual(input, p);
}

/** True if the request carries a valid `x-owner-passphrase` header. */
export function isAdmin(req: Request): boolean {
  const h = req.headers.get("x-owner-passphrase")?.trim();
  if (!h) return false;
  return verifyOwnerPassphrase(h);
}

/**
 * Use at the top of any user-scoped API route. Returns the user id if
 * authenticated, or a 401 Response that the route should return as-is.
 */
export function requireUser(req: Request): string | Response {
  const userId = getSessionUserId(req);
  if (!userId) return new Response("Unauthorized", { status: 401 });
  return userId;
}

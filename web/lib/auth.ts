/**
 * Single-account passphrase auth.
 *
 * Set OWNER_PASSPHRASE and OWNER_SESSION_SECRET on Railway. Logging in
 * with the passphrase sets a signed `owner_session` cookie (HMAC-SHA256
 * over an expiry timestamp); presence + validity of the cookie =
 * "this device is the owner."
 *
 * Single-user app, so no users table — everyone who knows the passphrase
 * is the same one owner.
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

export function verifyPassphrase(input: string): boolean {
  const p = process.env.OWNER_PASSPHRASE;
  if (!p) return false;
  if (input.length === 0) return false;
  return safeStringEqual(input, p);
}

export function makeSessionToken(): string {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC);
  return `${exp}.${sign(exp)}`;
}

export function isValidSessionToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  if (!safeStringEqual(sign(payload), sig)) return false;
  const exp = parseInt(payload, 10);
  return Number.isFinite(exp) && exp > Math.floor(Date.now() / 1000);
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

export function isOwner(req: Request): boolean {
  return isValidSessionToken(readSessionCookie(req));
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

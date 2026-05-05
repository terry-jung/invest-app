/**
 * Trades — user-logged actions (buy / trim / sell) against tickers.
 *
 * Stored in SQLite (see db.ts schema). One row per logged action; an
 * analysis can have many trades (initial buy, partial trim, final sell).
 *
 * The optional analysis_id links a trade to the saved analysis it was
 * logged against — used to overlay user trades on top of system
 * recommendations on the Saved tab. The link is NOT a hard FK because
 * saved analyses live as JSON on disk, not in SQLite. If an analysis
 * is deleted, the trade is preserved (the ticker history matters even
 * when the original analysis is gone).
 */

import { randomUUID } from "node:crypto";
import { db } from "./db";

export type TradeAction = "buy" | "trim" | "sell";

export type Trade = {
  id: string;
  user_id: string;
  ticker: string;
  action: TradeAction;
  trade_date: string;       // YYYY-MM-DD
  price: number;
  shares: number;
  notes: string | null;
  analysis_id: string | null;
  created_at: string;       // ISO
};

const ACTIONS = new Set<TradeAction>(["buy", "trim", "sell"]);

export function isTradeAction(s: string): s is TradeAction {
  return ACTIONS.has(s as TradeAction);
}

/** Validates and creates a trade. Throws on validation failure. */
export function createTrade(input: {
  userId: string;
  ticker: string;
  action: string;
  trade_date: string;
  price: number;
  shares: number;
  notes?: string | null;
  analysis_id?: string | null;
}): Trade {
  const ticker = (input.ticker ?? "").trim().toUpperCase();
  if (!/^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/.test(ticker)) {
    throw new Error("INVALID_TICKER");
  }
  if (!isTradeAction(input.action)) throw new Error("INVALID_ACTION");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.trade_date)) throw new Error("INVALID_DATE");
  if (!Number.isFinite(input.price) || input.price <= 0) throw new Error("INVALID_PRICE");
  if (!Number.isFinite(input.shares) || input.shares <= 0) throw new Error("INVALID_SHARES");

  const id = randomUUID();
  const now = new Date().toISOString();
  const notes = input.notes?.trim() || null;
  const analysis_id = input.analysis_id?.trim() || null;

  db().prepare(
    `INSERT INTO trades (id, user_id, ticker, action, trade_date, price, shares, notes, analysis_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.userId, ticker, input.action, input.trade_date, input.price, input.shares, notes, analysis_id, now);

  return {
    id,
    user_id: input.userId,
    ticker,
    action: input.action,
    trade_date: input.trade_date,
    price: input.price,
    shares: input.shares,
    notes,
    analysis_id,
    created_at: now,
  };
}

/** All trades for a user, newest first. */
export function listTradesForUser(userId: string): Trade[] {
  return db().prepare(
    `SELECT * FROM trades WHERE user_id = ? ORDER BY trade_date DESC, created_at DESC`
  ).all(userId) as Trade[];
}

/** All trades for a user filtered to a specific ticker, newest first. */
export function listTradesForUserTicker(userId: string, ticker: string): Trade[] {
  const t = ticker.trim().toUpperCase();
  return db().prepare(
    `SELECT * FROM trades WHERE user_id = ? AND ticker = ? ORDER BY trade_date DESC, created_at DESC`
  ).all(userId, t) as Trade[];
}

/** Delete a trade by id, scoped to the owning user (no cross-user delete). */
export function deleteTrade(userId: string, id: string): boolean {
  const res = db().prepare(`DELETE FROM trades WHERE id = ? AND user_id = ?`).run(id, userId);
  return res.changes > 0;
}

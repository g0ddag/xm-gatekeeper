import type { Database } from 'bun:sqlite';

/**
 * Per-group risk-control keywords, stored in their normalised form. Never holds chat text.
 *
 * Kept in runtime_state under `risk_keyword:<chatId>:<keyword>` (the same pattern as community
 * command access) so this feature needs no schema migration: releases stay same-schema and an
 * older release simply ignores these rows. List order is insertion order (rowid).
 */
export class SqliteRiskKeywords {
  constructor(private readonly db: Database) {}

  private prefix(chatId: number): string {
    return `risk_keyword:${chatId}:`;
  }
  list(chatId: number): string[] {
    const p = this.prefix(chatId);
    return (this.db.query('SELECT key FROM runtime_state WHERE substr(key,1,?)=? ORDER BY rowid').all(p.length, p) as { key: string }[])
      .map((r) => r.key.slice(p.length));
  }
  count(chatId: number): number {
    const p = this.prefix(chatId);
    return (this.db.query('SELECT COUNT(*) AS n FROM runtime_state WHERE substr(key,1,?)=?').get(p.length, p) as { n: number }).n;
  }
  /** True when the keyword was new. */
  add(chatId: number, keyword: string, actor: number, now: number): boolean {
    return this.db.query('INSERT OR IGNORE INTO runtime_state(key,value) VALUES (?,?)')
      .run(this.prefix(chatId) + keyword, JSON.stringify({ by: actor, at: now })).changes > 0;
  }
  remove(chatId: number, keyword: string): boolean {
    return this.db.query('DELETE FROM runtime_state WHERE key=?').run(this.prefix(chatId) + keyword).changes > 0;
  }
  removeGroup(chatId: number): void {
    for (const p of [this.prefix(chatId), `risk_strike:${chatId}:`]) {
      this.db.query('DELETE FROM runtime_state WHERE substr(key,1,?)=?').run(p.length, p);
    }
  }

  // ----- strikes: `risk_strike:<chatId>:<userId>` → {"n": count, "at": last strike ms} -----
  /**
   * Records a violation. Returns the strike count and whether this one counted (false inside the
   * grace period after the previous strike). Strikes older than `memoryMs` are forgotten.
   */
  strike(chatId: number, userId: number, now: number, memoryMs: number, graceMs: number): { count: number; counted: boolean } {
    const key = `risk_strike:${chatId}:${userId}`;
    const row = this.db.query('SELECT value FROM runtime_state WHERE key=?').get(key) as { value: string } | null;
    let prev = { n: 0, at: 0 };
    try {
      if (row) prev = JSON.parse(row.value) as { n: number; at: number };
    } catch { /* unreadable entry: start again */ }
    if (now - prev.at > memoryMs) prev = { n: 0, at: 0 };
    if (prev.n > 0 && now - prev.at < graceMs) return { count: prev.n, counted: false };
    const n = prev.n + 1;
    this.db.query('INSERT INTO runtime_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify({ n, at: now }));
    return { count: n, counted: true };
  }
  clearStrikes(chatId: number, userId: number): void {
    this.db.query('DELETE FROM runtime_state WHERE key=?').run(`risk_strike:${chatId}:${userId}`);
  }
}

import {
  RISK_KEYWORD_MAX_LENGTH,
  RISK_KEYWORDS_PER_GROUP,
  applySetting,
  parseRiskKeyword,
  splitKeywordList,
  type Clock,
} from '@guard/core';
import type { GroupRow, Store } from '@guard/database';
import type { Authority } from './authority';
import type { Button, Tg } from '../telegram';
import type { AdminPresentation } from './presentation';

type KeywordStore = Pick<
  Store,
  'listRiskKeywords' | 'addRiskKeywords' | 'removeRiskKeyword' | 'settingsOf' | 'getGroup' | 'updateSettings'
>;
const PER_PAGE = 20;

/** /keywords: the per-group risk-control list. Admin authenticates scope before delegating here. */
export class KeywordEditor {
  constructor(
    private readonly store: KeywordStore,
    private readonly tg: Pick<Tg, 'editMessage'>,
    private readonly authority: Pick<Authority, 'botRights'>,
    private readonly clock: Clock,
    private readonly ui: AdminPresentation,
  ) {}

  /** `/keywords`, `/keywords add a, b`, `/keywords remove a`. */
  async command(userId: number, chatId: number, group: GroupRow, args: string): Promise<void> {
    const [verb = '', ...rest] = args.trim().split(/\s+/);
    const list = rest.join(' ');
    const now = this.clock.now();
    if (verb === 'add' || verb === 'remove') {
      const parsed = splitKeywordList(list).map((raw) => ({ raw, k: parseRiskKeyword(raw) }));
      const bad = parsed.filter((x) => x.k === undefined).map((x) => x.raw);
      const keywords = [...new Set(parsed.flatMap((x) => (x.k ? [x.k] : [])))];
      if (keywords.length === 0) {
        await this.ui.say(chatId, verb === 'add'
          ? `Usage: /keywords add word1, word2 (each 1–${RISK_KEYWORD_MAX_LENGTH} characters; separate with commas or new lines).`
          : 'Usage: /keywords remove word — or tap the keyword in /keywords.');
        return;
      }
      const lines: string[] = [];
      if (verb === 'add') {
        const { added, full } = this.store.addRiskKeywords(group.chat_id, keywords, userId, now);
        const skipped = keywords.filter((k) => !added.includes(k));
        if (added.length) lines.push(`Added ${added.length}: ${added.join(', ')}`);
        if (skipped.length && !full) lines.push(`Already in the list: ${skipped.join(', ')}`);
        if (full) lines.push(`The list is full (${RISK_KEYWORDS_PER_GROUP} keywords). Remove some first.`);
      } else {
        const removed = keywords.filter((k) => this.store.removeRiskKeyword(group.chat_id, k, userId, now));
        const missing = keywords.filter((k) => !removed.includes(k));
        if (removed.length) lines.push(`Removed ${removed.length}: ${removed.join(', ')}`);
        if (missing.length) lines.push(`Not in the list: ${missing.join(', ')}`);
      }
      if (bad.length) lines.push(`Ignored (empty or longer than ${RISK_KEYWORD_MAX_LENGTH} characters): ${bad.join(', ')}`);
      await this.ui.say(chatId, lines.join('\n'));
    } else if (verb) {
      await this.ui.say(chatId, 'Usage: /keywords · /keywords add word1, word2 · /keywords remove word');
      return;
    }
    const panel = await this.panel(userId, this.store.getGroup(group.chat_id) ?? group, 0);
    await this.ui.say(chatId, panel.text, panel.rows);
  }

  /** Buttons: kw (show page), kwdel (remove one keyword), kwtog (risk control on/off). */
  async onAction(userId: number, chatId: number, p: Record<string, string | number>, group: GroupRow, messageId?: number): Promise<string | undefined> {
    const now = this.clock.now();
    let toast: string | undefined;
    if (p.op === 'kwdel') {
      toast = this.store.removeRiskKeyword(group.chat_id, String(p.k), userId, now) ? `Removed: ${p.k}` : 'Already removed';
    } else if (p.op === 'kwtog') {
      const on = !this.store.settingsOf(group).riskControl;
      const change = applySetting(this.store.settingsOf(group), 'riskControl', on ? 'on' : 'off');
      if (change.ok) this.store.updateSettings(group.chat_id, change.settings, userId, 'riskControl', now);
      toast = on ? 'Risk control on' : 'Risk control off';
    }
    const fresh = this.store.getGroup(group.chat_id) ?? group;
    const panel = await this.panel(userId, fresh, Number(p.page ?? 0));
    const edited = messageId !== undefined &&
      (await this.tg.editMessage(chatId, messageId, panel.text, { inline_keyboard: panel.rows }).then(() => true, () => false));
    if (!edited) await this.ui.say(chatId, panel.text, panel.rows);
    return toast;
  }

  private async panel(userId: number, group: GroupRow, requestedPage: number): Promise<{ text: string; rows: Button[][] }> {
    const gid = group.chat_id;
    const on = this.store.settingsOf(group).riskControl;
    const keywords = this.store.listRiskKeywords(gid);
    const pages = Math.max(1, Math.ceil(keywords.length / PER_PAGE));
    const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, pages - 1));
    const shown = keywords.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    let canDelete: boolean | undefined;
    try {
      canDelete = (await this.authority.botRights(gid)).delete;
    } catch {
      canDelete = undefined; // Telegram unreachable: say nothing rather than guess
    }
    const text = [
      `🛡 Risk control for ${this.ui.label(group)}: ${on ? 'ON' : 'OFF'}`,
      `${keywords.length}/${RISK_KEYWORDS_PER_GROUP} keywords.`,
      '',
      'A group message (or edit) containing any keyword is always deleted. Strikes per person: 1st — warning and 1 h mute; 2nd — warning and 24 h mute; 3rd — banned (removed from the group). Strikes are forgotten after 30 days; /unban resets them. Messages within a minute of a strike do not add another.',
      '',
      'Matching ignores case, full-width letters, and spaces or punctuation inserted between letters. Group administrators are exempt.',
      ...(canDelete === false ? ['', '⚠️ I do not have the "Delete messages" admin right in this group yet, so nothing can be deleted. Muting and banning also need "Ban users".'] : []),
      '',
      keywords.length ? (pages > 1 ? `Keywords (page ${page + 1} of ${pages}) — tap one to remove it:` : 'Keywords — tap one to remove it:') : 'No keywords yet.',
      '',
      'Add: /keywords add word1, word2',
      'Remove: tap below, or /keywords remove word',
    ].join('\n');
    const rows: Button[][] = [[this.ui.button(userId, on ? '⏸ Turn risk control off' : '▶️ Turn risk control on', { op: 'kwtog', chat: gid, page })]];
    for (let i = 0; i < shown.length; i += 2) {
      rows.push(shown.slice(i, i + 2).map((k) => this.ui.button(userId, `❌ ${k}`, { op: 'kwdel', chat: gid, k, page })));
    }
    const nav: Button[] = [];
    if (page > 0) nav.push(this.ui.button(userId, '← Previous', { op: 'kw', chat: gid, page: page - 1 }));
    if (page + 1 < pages) nav.push(this.ui.button(userId, 'Next →', { op: 'kw', chat: gid, page: page + 1 }));
    if (nav.length) rows.push(nav);
    rows.push([this.ui.button(userId, '⚙️ Other settings', { op: 'setm', chat: gid })]);
    return { text, rows };
  }
}

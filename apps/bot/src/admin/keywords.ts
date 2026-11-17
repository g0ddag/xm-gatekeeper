import {
  RISK_KEYWORD_MAX_LENGTH,
  RISK_KEYWORDS_PER_GROUP,
  applySetting,
  parseRiskKeyword,
  splitKeywordList,
  type Clock,
} from '@guard/core';
import type { GroupRow, KeywordListKind, Store } from '@guard/database';
import type { Authority } from './authority';
import type { Button, Tg } from '../telegram';
import type { AdminPresentation } from './presentation';

type KeywordStore = Pick<
  Store,
  'listKeywords' | 'addKeywords' | 'removeKeyword' | 'settingsOf' | 'getGroup' | 'updateSettings' | 'getState' | 'setState' | 'deleteState'
>;
const PER_PAGE = 20;

/** Per list: its command and the button ops for show page / remove one / risk control on-off / add / cancel adding. */
const LIST = {
  message: { command: '/keywords', show: 'kw', del: 'kwdel', toggle: 'kwtog', add: 'kwadd', cancel: 'kwcancel' },
  name: { command: '/bannames', show: 'nk', del: 'nkdel', toggle: 'nktog', add: 'nkadd', cancel: 'nkcancel' },
} as const;

/**
 * After an admin taps ➕ Add, their next plain private message is the keyword list. Only then does
 * intake keep the text of a private message that is not a command; the wait ends after 10 minutes.
 */
export const KEYWORD_INPUT_TTL_MS = 10 * 60_000;
type PendingInput = { chat: number; kind: KeywordListKind; at: number };
const inputKey = (userId: number) => `keyword_input:${userId}`;
export function pendingKeywordInput(store: Pick<Store, 'getState'>, userId: number, now: number): PendingInput | undefined {
  const raw = store.getState(inputKey(userId));
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as PendingInput;
    return now - p.at < KEYWORD_INPUT_TTL_MS ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * /keywords (what a group message says) and /bannames (who is speaking or joining): the per-group
 * risk-control lists. Admin authenticates scope before delegating here.
 */
export class KeywordEditor {
  constructor(
    private readonly store: KeywordStore,
    private readonly tg: Pick<Tg, 'editMessage'>,
    private readonly authority: Pick<Authority, 'botRights'>,
    private readonly clock: Clock,
    private readonly ui: AdminPresentation,
  ) {}

  /** `/keywords`, `/keywords add a, b`, `/keywords remove a` — and the same for `/bannames`. */
  async command(userId: number, chatId: number, group: GroupRow, args: string, kind: KeywordListKind = 'message'): Promise<void> {
    const cmd = LIST[kind].command;
    // Keep new lines in the list: they separate keywords.
    const [, verb = '', list = ''] = /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? [];
    const now = this.clock.now();
    if (verb === 'add' || verb === 'remove') {
      const parsed = splitKeywordList(list).map((raw) => ({ raw, k: parseRiskKeyword(raw) }));
      const bad = parsed.filter((x) => x.k === undefined).map((x) => x.raw);
      const keywords = [...new Set(parsed.flatMap((x) => (x.k ? [x.k] : [])))];
      if (keywords.length === 0) {
        await this.ui.say(chatId, verb === 'add'
          ? `Nothing added: send keywords of 1–${RISK_KEYWORD_MAX_LENGTH} characters, separated with commas or new lines.`
          : `Usage: ${cmd} remove word — or tap the keyword in ${cmd}.`);
        return;
      }
      const lines: string[] = [];
      if (verb === 'add') {
        const { added, full } = this.store.addKeywords(kind, group.chat_id, keywords, userId, now);
        const skipped = keywords.filter((k) => !added.includes(k));
        if (added.length) lines.push(`Added ${added.length}: ${added.join(', ')}`);
        if (skipped.length && !full) lines.push(`Already in the list: ${skipped.join(', ')}`);
        if (full) lines.push(`The list is full (${RISK_KEYWORDS_PER_GROUP} keywords). Remove some first.`);
      } else {
        const removed = keywords.filter((k) => this.store.removeKeyword(kind, group.chat_id, k, userId, now));
        const missing = keywords.filter((k) => !removed.includes(k));
        if (removed.length) lines.push(`Removed ${removed.length}: ${removed.join(', ')}`);
        if (missing.length) lines.push(`Not in the list: ${missing.join(', ')}`);
      }
      if (bad.length) lines.push(`Ignored (empty or longer than ${RISK_KEYWORD_MAX_LENGTH} characters): ${bad.join(', ')}`);
      await this.ui.say(chatId, lines.join('\n'));
    } else if (verb) {
      await this.ui.say(chatId, `Usage: ${cmd} · ${cmd} add word1, word2 · ${cmd} remove word`);
      return;
    }
    const panel = await this.panel(userId, this.store.getGroup(group.chat_id) ?? group, 0, kind);
    await this.ui.say(chatId, panel.text, panel.rows);
  }

  /**
   * The admin's plain message after tapping ➕ Add. Returns false when nothing was waiting for it
   * (expired or cancelled), so the caller treats it as an ordinary message. Authority is checked
   * by the caller.
   */
  async takeInput(userId: number, chatId: number, text: string, groupFor: (chat: number) => Promise<GroupRow | undefined>): Promise<boolean> {
    const pending = pendingKeywordInput(this.store, userId, this.clock.now());
    this.store.deleteState(inputKey(userId));
    if (!pending) return false;
    const group = await groupFor(pending.chat);
    if (group) await this.command(userId, chatId, group, `add ${text}`, pending.kind);
    return true;
  }

  /** Buttons (kw… for /keywords, nk… for /bannames): show page, remove one, risk control on/off, add, cancel adding. */
  async onAction(userId: number, chatId: number, p: Record<string, string | number>, group: GroupRow, messageId?: number): Promise<string | undefined> {
    const now = this.clock.now();
    const kind: KeywordListKind = String(p.op).startsWith('nk') ? 'name' : 'message';
    const ops = LIST[kind];
    if (p.op === ops.add) {
      this.store.setState(inputKey(userId), JSON.stringify({ chat: group.chat_id, kind, at: now } satisfies PendingInput));
      await this.ui.say(chatId, [
        kind === 'name' ? `➕ Send the name keywords to ban in ${this.ui.label(group)}.` : `➕ Send the message keywords for ${this.ui.label(group)}.`,
        '',
        'One message: separate several with commas or new lines. Each 1–64 characters.',
      ].join('\n'), [[this.ui.button(userId, '✖️ Cancel', { op: ops.cancel, chat: group.chat_id })]]);
      return 'Send the keywords as a message';
    }
    if (p.op === ops.cancel) {
      this.store.deleteState(inputKey(userId));
      if (messageId !== undefined) await this.tg.editMessage(chatId, messageId, 'Cancelled — nothing added.', { inline_keyboard: [] }).catch(() => undefined);
      return 'Cancelled';
    }
    let toast: string | undefined;
    if (p.op === ops.del) {
      toast = this.store.removeKeyword(kind, group.chat_id, String(p.k), userId, now) ? `Removed: ${p.k}` : 'Already removed';
    } else if (p.op === ops.toggle) {
      const on = !this.store.settingsOf(group).riskControl;
      const change = applySetting(this.store.settingsOf(group), 'riskControl', on ? 'on' : 'off');
      if (change.ok) this.store.updateSettings(group.chat_id, change.settings, userId, 'riskControl', now);
      toast = on ? 'Risk control on' : 'Risk control off';
    }
    const fresh = this.store.getGroup(group.chat_id) ?? group;
    const panel = await this.panel(userId, fresh, Number(p.page ?? 0), kind);
    const edited = messageId !== undefined &&
      (await this.tg.editMessage(chatId, messageId, panel.text, { inline_keyboard: panel.rows }).then(() => true, () => false));
    if (!edited) await this.ui.say(chatId, panel.text, panel.rows);
    return toast;
  }

  private async panel(userId: number, group: GroupRow, requestedPage: number, kind: KeywordListKind): Promise<{ text: string; rows: Button[][] }> {
    const gid = group.chat_id;
    const ops = LIST[kind];
    const on = this.store.settingsOf(group).riskControl;
    const keywords = this.store.listKeywords(kind, gid);
    const pages = Math.max(1, Math.ceil(keywords.length / PER_PAGE));
    const page = Math.max(0, Math.min(Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0, pages - 1));
    const shown = keywords.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
    let rights: { delete: boolean; restrict: boolean } | undefined;
    try {
      const r = await this.authority.botRights(gid);
      rights = { delete: r.delete, restrict: r.restrict };
    } catch {
      rights = undefined; // Telegram unreachable: say nothing rather than guess
    }
    const about = kind === 'message'
      ? [
          'A group message (or edit) containing any keyword — including text quoted from another message — is always deleted. Strikes per person: 1st — warning and 1 h mute; 2nd — warning and 24 h mute; 3rd — banned (removed from the group). Strikes are forgotten after 30 days; /unban resets them. Messages within a minute of a strike do not add another.',
        ]
      : [
          'Anyone whose name (first name, last name or @username) contains a keyword is banned at once, with no warning: when they ask to join (the request is declined), when they join, or when they post (the message is deleted). Use /unban to let someone back in.',
        ];
    const missing = kind === 'message'
      ? (rights && !rights.delete ? ['', '⚠️ I do not have the "Delete messages" admin right in this group yet, so nothing can be deleted. Muting and banning also need "Ban users".'] : [])
      : (rights && !rights.restrict ? ['', '⚠️ I do not have the "Ban users" admin right in this group yet, so nobody can be banned.'] : []);
    const title = kind === 'message' ? `🛡 Risk control for ${this.ui.label(group)}: ${on ? 'ON' : 'OFF'}` : `🚫 Name ban list for ${this.ui.label(group)} — risk control ${on ? 'ON' : 'OFF'}`;
    const text = [
      title,
      `${keywords.length}/${RISK_KEYWORDS_PER_GROUP} keywords.`,
      '',
      ...about,
      '',
      'Matching ignores case, full-width letters, and spaces or punctuation inserted between letters. Group administrators are exempt.',
      ...missing,
      '',
      keywords.length ? (pages > 1 ? `Keywords (page ${page + 1} of ${pages}) — tap ❌ to remove one:` : 'Keywords — tap ❌ to remove one:') : 'No keywords yet — tap ➕ Add keywords.',
    ].join('\n');
    const rows: Button[][] = [
      [this.ui.button(userId, '➕ Add keywords', { op: ops.add, chat: gid })],
      [this.ui.button(userId, on ? '⏸ Turn risk control off' : '▶️ Turn risk control on', { op: ops.toggle, chat: gid, page })],
    ];
    for (let i = 0; i < shown.length; i += 2) {
      rows.push(shown.slice(i, i + 2).map((k) => this.ui.button(userId, `❌ ${k}`, { op: ops.del, chat: gid, k, page })));
    }
    const nav: Button[] = [];
    if (page > 0) nav.push(this.ui.button(userId, '← Previous', { op: ops.show, chat: gid, page: page - 1 }));
    if (page + 1 < pages) nav.push(this.ui.button(userId, 'Next →', { op: ops.show, chat: gid, page: page + 1 }));
    if (nav.length) rows.push(nav);
    rows.push([
      kind === 'message'
        ? this.ui.button(userId, '🚫 Name ban list', { op: LIST.name.show, chat: gid, page: 0 })
        : this.ui.button(userId, '🛡 Message keywords', { op: LIST.message.show, chat: gid, page: 0 }),
      this.ui.button(userId, '⚙️ Other settings', { op: 'setm', chat: gid }),
    ]);
    return { text, rows };
  }
}

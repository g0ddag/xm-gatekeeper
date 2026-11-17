import { InboxProcessor } from './inbox-processor';
import { rememberUser } from './targets';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { errorCode, log, type Clock } from '@guard/core';
import type { InboxRepository, UsernameDirectory } from '@guard/database';
import { classify } from './telegram';

const MAX_INBOX_BACKLOG = 1000;
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'chat_join_request', 'chat_member', 'my_chat_member'] as const;

/** Returns the matched keyword when a group message must be removed by risk control. */
export type RiskCheck = (chatId: number, text: string) => string | undefined;
/** Returns the matched name-ban keyword when a person's name (first, last, @username) is on the group's ban list. */
export type NameCheck = (chatId: number, name: string) => string | undefined;
type Named = { first_name?: string | undefined; last_name?: string | undefined; username?: string | undefined };
/** Everything shown as a person's name: display name and @username. */
function nameOf(u: Named): string {
  return [u.first_name, u.last_name, u.username ? `@${u.username}` : undefined].filter(Boolean).join(' ');
}

type ScannedMessage = {
  text?: string | undefined;
  caption?: string | undefined;
  entities?: { type: string; url?: string }[] | undefined;
  caption_entities?: { type: string; url?: string }[] | undefined;
  poll?: { question: string } | undefined;
  quote?: { text: string } | undefined;
  external_reply?: { poll?: { question: string } | undefined } | undefined;
};
/**
 * Everything a reader sees in a message, including the targets of hidden text links and the
 * quote block of a reply (also a quote taken from another chat, which spammers use to show text
 * they did not type in this group).
 */
function scannedText(m: ScannedMessage): string {
  const links = [...(m.entities ?? []), ...(m.caption_entities ?? [])].flatMap((e) => (e.type === 'text_link' && e.url ? [e.url] : []));
  return [m.text, m.caption, m.poll?.question, m.quote?.text, m.external_reply?.poll?.question, ...links].filter(Boolean).join('\n');
}

type Loose = Record<string, unknown>;
const user = (u: { id: number; is_bot: boolean }) => ({ id: u.id, is_bot: u.is_bot, first_name: '' });
const chat = (c: { id: number; type: string; title?: string | undefined }) => ({
  id: c.id,
  type: c.type,
  ...(c.type !== 'private' && c.title !== undefined ? { title: c.title.slice(0, 128) } : {}),
});

/**
 * Keeps only the fields the application uses. Biographies, names, contacts, free text,
 * media and invite links never reach the inbox. Returns null for updates that need no handling.
 *
 * Group messages are checked against risk-control keywords here, in memory. A hit is stored only
 * as `_risk` (the keyword) with the message ID and sender; the message text itself is discarded.
 * Names of people who join, ask to join or post in a group are checked against the name-ban list
 * the same way: a hit is stored only as `_nameban` (the keyword); the name itself is discarded.
 */
export function projectUpdate(u: Update, risk?: RiskCheck, names?: NameCheck, awaitingKeywords?: (userId: number) => boolean): Loose | null {
  const base = { update_id: u.update_id };
  const nameHit = (chatId: number, who: Named & { is_bot: boolean }): string | undefined =>
    names && !who.is_bot ? names(chatId, nameOf(who)) : undefined;
  const riskHit = (m: NonNullable<Update['message']>): Loose | null => {
    if (!m.from || m.from.is_bot || (m.chat.type !== 'group' && m.chat.type !== 'supergroup')) return null;
    const out = { message_id: m.message_id, date: m.date, chat: chat(m.chat), from: user(m.from) };
    const banned = nameHit(m.chat.id, m.from);
    if (banned !== undefined) return { ...base, message: { ...out, _nameban: banned } };
    const keyword = risk?.(m.chat.id, scannedText(m));
    if (keyword === undefined) return null;
    return { ...base, message: { ...out, _risk: keyword } };
  };
  if (u.edited_message) return riskHit(u.edited_message); // edits matter only when they add a keyword
  if (u.chat_join_request) {
    const r = u.chat_join_request;
    return {
      ...base,
      chat_join_request: {
        chat: chat(r.chat),
        from: user(r.from),
        user_chat_id: r.user_chat_id,
        date: r.date,
        ...((r as { query_id?: string }).query_id ? { query_id: 'present' } : {}),
        ...withNameBan(nameHit(r.chat.id, r.from)),
      },
    };
  }
  if (u.callback_query) {
    const q = u.callback_query;
    if (!q.data || !q.message) return null;
    return {
      ...base,
      callback_query: {
        id: q.id,
        from: user(q.from),
        chat_instance: q.chat_instance,
        data: q.data.slice(0, 64),
        message: { message_id: q.message.message_id, date: q.message.date, chat: chat(q.message.chat) },
      },
    };
  }
  if (u.chat_member || u.my_chat_member) {
    const key = u.chat_member ? 'chat_member' : 'my_chat_member';
    const m = (u.chat_member ?? u.my_chat_member)!;
    const member = (cm: typeof m.new_chat_member) => ({
      status: cm.status,
      user: user(cm.user),
      ...(cm.status === 'restricted' ? { is_member: cm.is_member } : {}),
      ...(cm.status === 'administrator' ? { can_invite_users: cm.can_invite_users, can_restrict_members: cm.can_restrict_members } : {}),
    });
    return {
      ...base,
      [key]: {
        chat: chat(m.chat),
        from: user(m.from),
        date: m.date,
        old_chat_member: member(m.old_chat_member),
        new_chat_member: member(m.new_chat_member),
        ...(key === 'chat_member' ? withNameBan(nameHit(m.chat.id, m.new_chat_member.user)) : {}),
      },
    };
  }
  if (u.message) {
    const m = u.message;
    if (!m.from || m.from.is_bot) return null;
    const out: Loose = { message_id: m.message_id, date: m.date, chat: chat(m.chat), from: user(m.from) };
    if (m.migrate_to_chat_id !== undefined) return { ...base, message: { ...out, migrate_to_chat_id: m.migrate_to_chat_id } };
    if (m.new_chat_title !== undefined) return { ...base, message: { ...out, new_chat_title: m.new_chat_title.slice(0, 128) } };
    const hit = riskHit(m);
    if (hit) return hit;
    const command = m.entities?.find((e) => e.type === 'bot_command' && e.offset === 0);
    if (m.text && command) {
      // Commands keep their text (bounded); nothing else a user types is stored.
      // Only the author of a replied-to message is kept (for /ban). A forum topic's root message is
      // not a real reply target, so it is never treated as one.
      const r = m.reply_to_message;
      const reply =
        r?.from && !r.forum_topic_created
          ? { reply_to_message: { message_id: r.message_id, date: r.date, chat: chat(r.chat), from: user(r.from) } }
          : {};
      return { ...base, message: { ...out, text: m.text.slice(0, 256), entities: [command, ...(m.entities ?? []).filter(e => e.type === 'mention' || e.type === 'text_mention').map(e => e.type === 'text_mention' ? {...e,user:user(e.user)} : e)], ...reply } };
    }
    if (m.chat.type !== 'private') return null;
    // An admin who tapped ➕ Add in a keyword panel is sending the keyword list: only then is plain text kept.
    if (m.text !== undefined && awaitingKeywords?.(m.from.id)) return { ...base, message: { ...out, text: m.text.slice(0, 4000), _keywordInput: true } };
    return { ...base, message: { ...out, ...(m.text === undefined ? { _media: true } : {}) } };
  }
  return null;
}

const withNameBan = (keyword: string | undefined) => (keyword === undefined ? {} : { _nameban: keyword });

export class Poller {
  lastPollAt = 0;
  private readonly inbox: InboxProcessor;

  constructor(
    private readonly bot: Bot,
    private readonly store: InboxRepository & UsernameDirectory,
    private readonly clock: Clock,
    private readonly risk?: RiskCheck,
    private readonly names?: NameCheck,
    private readonly awaitingKeywords?: (userId: number) => boolean,
  ) {
    this.inbox = new InboxProcessor(store, clock, update => bot.handleUpdate(update));
  }

  /** Durable intake: commit the projected batch and the next offset before asking for more. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (this.store.inboxStats(this.clock.now()).pending >= MAX_INBOX_BACKLOG) {
          await this.processInbox();
          await sleep(1000, signal);
          continue;
        }
        const offset = this.store.nextOffset();
        const updates = await this.bot.api.getUpdates(
          { timeout: 30, limit: 50, allowed_updates: ALLOWED_UPDATES, ...(offset !== undefined ? { offset } : {}) },
          signal as unknown as Parameters<typeof this.bot.api.getUpdates>[1],
        );
        // If this throws (disk full, database failure) the offset is NOT advanced.
        await this.accept(updates);
        await this.processInbox();
      } catch (e) {
        if (signal.aborted) return;
        const err = classify(e);
        log('warn', 'poll_error', { kind: err.kind, error: errorCode(e) });
        await sleep(err.kind === 'rate' ? err.retryAfterMs : 3000, signal);
      }
    }
  }

  /**
   * Durable intake shared by polling and the webhook: the projected updates are committed to the
   * inbox before they are acknowledged to Telegram. Throws if the commit fails.
   */
  async accept(updates: Update[]): Promise<void> {
    this.lastPollAt = this.clock.now();
    for (const u of updates) {
      // Ordinary group text is discarded below, but its sender can be resolved by @username.
      const users = [u.message?.from, u.message?.reply_to_message?.from, u.callback_query?.from,
        u.chat_join_request?.from, u.chat_member?.new_chat_member.user];
      for (const e of u.message?.entities ?? []) if (e.type === 'text_mention') users.push(e.user);
      for (const person of users) rememberUser(this.store,person,this.clock.now());
      const queryId = (u.chat_join_request as { query_id?: string } | undefined)?.query_id;
      if (queryId) {
        // Ten-second contract of join-query mode: leave the decision to administrators.
        await this.bot.api.raw
          .answerChatJoinRequestQuery({ chat_join_request_query_id: queryId, result: 'queue' })
          .catch(() => undefined);
      }
    }
    this.store.storeBatchAndAdvance(
      updates.map((u) => ({ update_id: u.update_id, payload: projectUpdate(u, this.risk, this.names, this.awaitingKeywords) })),
      this.clock.now(),
    );
  }

  processInbox(): Promise<void> {
    return this.inbox.process();
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

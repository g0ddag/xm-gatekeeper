import { describe, expect, test } from 'bun:test';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { matchRiskKeyword, normalizeForMatch, parseRiskKeyword, splitKeywordList, RISK_KEYWORDS_PER_GROUP } from '@guard/core';
import { LocalAssetStore } from '@guard/assets';
import { Poller, RISK_NOTICE_TTL_MS, RiskControl, TgError, projectUpdate, registerRoutes } from '@guard/bot';
import { pendingKeywordInput } from '../apps/bot/src/admin/keywords';
import { ASSETS_DIR, BOT_ID, GROUP, OWNER, enrol, harness, type Harness } from './helpers';

const U = 5001;
const MOD = 3100;

function setup(settings: Parameters<typeof enrol>[3] = {}) {
  const h = harness();
  enrol(h, GROUP, OWNER, settings);
  h.tg.admins.get(GROUP)!.push({ userId: MOD, isCreator: false, isBot: false, canInvite: false, canRestrict: true });
  h.store.syncAdmins(GROUP, [OWNER, MOD], h.clock.now()); // as after a chat_member promotion update
  h.store.recordExplicitStart(OWNER, OWNER, h.clock.now());
  const risk = new RiskControl(h.store, h.tg, h.authority, h.clock, (chatId, text) => h.v.notifyAdmins(chatId, text));
  return { h, risk };
}
const check = (h: Harness) => (chatId: number, text: string) => matchRiskKeyword(text, h.store.activeRiskKeywords(chatId));
const groupMessage = (id: number, from: number, extra: Record<string, unknown>, edited = false): Update =>
  ({
    update_id: id,
    [edited ? 'edited_message' : 'message']: {
      message_id: 700 + id,
      date: 1,
      chat: { id: GROUP, type: 'supergroup', title: 'G' },
      from: { id: from, is_bot: false, first_name: 'Spammer', username: 'spam' },
      ...extra,
    },
  }) as unknown as Update;

describe('keyword matching', () => {
  test('ignores case, full-width letters, zero-width characters and padding between letters', () => {
    const keywords = ['free usdt', '加微信', 't.me/joinchat'].map((k) => parseRiskKeyword(k)!);
    expect(matchRiskKeyword('Get FREE USDT today', keywords)).toBe('free usdt');
    expect(matchRiskKeyword('ｆｒｅｅ　ｕｓｄｔ', keywords)).toBe('free usdt'); // full-width
    expect(matchRiskKeyword('fr​ee usdt', keywords)).toBe('free usdt'); // zero-width space
    expect(matchRiskKeyword('f r e e - u s d t', keywords)).toBe('free usdt'); // spaced out
    expect(matchRiskKeyword('有意者請加微信', keywords)).toBe('加微信');
    expect(matchRiskKeyword('join t.me/joinchat/abc', keywords)).toBe('t.me/joinchat');
    expect(matchRiskKeyword('a normal message about portals', keywords)).toBeUndefined();
    expect(matchRiskKeyword('', keywords)).toBeUndefined();
  });
  test('keywords are normalised, bounded, and lists split on commas, 、 and new lines', () => {
    expect(parseRiskKeyword('  Free   USDT ')).toBe('free usdt');
    expect(parseRiskKeyword('')).toBeUndefined();
    expect(parseRiskKeyword('x'.repeat(65))).toBeUndefined();
    expect(splitKeywordList('a, b，c、d\ne;f')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(normalizeForMatch('ＡＢＣ')).toBe('abc');
  });
});

describe('intake', () => {
  test('a matching group message is stored only as a hit marker, never its text', () => {
    const { h } = setup();
    h.store.addRiskKeywords(GROUP, ['free usdt'], OWNER, h.clock.now());
    const hit = projectUpdate(groupMessage(1, U, { text: 'Claim FREE USDT now at example.com' }), check(h));
    expect(hit).toEqual({
      update_id: 1,
      message: { message_id: 701, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: { id: U, is_bot: false, first_name: '' }, _risk: 'free usdt' },
    });
    expect(JSON.stringify(hit)).not.toContain('example.com');
    expect(projectUpdate(groupMessage(2, U, { text: 'hello agents' }), check(h))).toBeNull();
  });
  test('captions, hidden link targets, polls and edits are checked too', () => {
    const { h } = setup();
    h.store.addRiskKeywords(GROUP, ['scam.example'], OWNER, h.clock.now());
    const r = check(h);
    expect(projectUpdate(groupMessage(3, U, { photo: [], caption: 'see scam.example' }), r)).not.toBeNull();
    expect(projectUpdate(groupMessage(4, U, { text: 'click here', entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://scam.example/x' }] }), r)).not.toBeNull();
    expect(projectUpdate(groupMessage(5, U, { poll: { question: 'scam.example?' } }), r)).not.toBeNull();
    const edited = projectUpdate(groupMessage(6, U, { text: 'now with scam.example' }, true), r) as { message: { _risk: string } };
    expect(edited.message._risk).toBe('scam.example');
    expect(projectUpdate(groupMessage(7, U, { text: 'harmless edit' }, true), r)).toBeNull();
  });
  test('nothing is checked when the guard is paused, risk control is off, or for bots', () => {
    const { h } = setup({ riskControl: false });
    h.store.addRiskKeywords(GROUP, ['spam'], OWNER, h.clock.now());
    expect(projectUpdate(groupMessage(8, U, { text: 'spam' }), check(h))).toBeNull();
    const { h: h2 } = setup();
    h2.store.addRiskKeywords(GROUP, ['spam'], OWNER, h2.clock.now());
    h2.store.setEnabled(GROUP, false, OWNER, 'test', h2.clock.now());
    expect(projectUpdate(groupMessage(9, U, { text: 'spam' }), check(h2))).toBeNull();
    const { h: h3 } = setup();
    h3.store.addRiskKeywords(GROUP, ['spam'], OWNER, h3.clock.now());
    const bot = groupMessage(10, U, { text: 'spam' }) as unknown as { message: { from: { is_bot: boolean } } };
    bot.message.from.is_bot = true;
    expect(projectUpdate(bot as unknown as Update, check(h3))).toBeNull();
  });
});

describe('acting on a hit', () => {
  test('first strike: deletes, warns and mutes for an hour, with a notice that removes itself', async () => {
    const { h, risk } = setup({ helpLocale: 'zh-TW' });
    await risk.onHit(GROUP, U, 901, 'free usdt');
    expect(h.tg.deleted).toEqual([901]);
    expect(h.tg.muted).toEqual([[GROUP, U, Math.floor(h.clock.now() / 1000) + 3600]]);
    expect(h.tg.banned).toEqual([]);
    expect(h.tg.prompts).toHaveLength(1);
    expect(h.tg.prompts[0]).toMatchObject({ chatId: GROUP, userId: U, text: '🛡 訊息已刪除：觸發了機器人的風控。\n⚠️ 第 1 次警告（共 2 次）：禁言 1 小時。第三次將被移出群組。' });
    const audit = h.store.listAudit(GROUP, 2).map((a) => [a.action, a.reason_code]);
    expect(audit).toEqual([['risk_muted', 'free usdt · strike 1'], ['risk_deleted', 'free usdt']]);
    // The notice is scheduled for deletion after a minute.
    expect(h.store.dueReviewNotices(h.clock.now())).toEqual([]);
    expect(h.store.dueReviewNotices(h.clock.now() + RISK_NOTICE_TTL_MS)).toEqual([{ chatId: GROUP, messageId: h.tg.prompts[0]!.id }]);
  });
  test('a burst sent before the mute took effect is deleted but counts as one strike', async () => {
    const { h, risk } = setup();
    for (let i = 0; i < 5; i++) await risk.onHit(GROUP, U, 910 + i, 'spam');
    expect(h.tg.deleted).toEqual([910, 911, 912, 913, 914]);
    expect(h.tg.prompts).toHaveLength(1);
    expect(h.tg.muted).toHaveLength(1);
    expect(h.tg.banned).toEqual([]);
  });
  test('second strike mutes for 24 hours; the third bans and removes them', async () => {
    const { h, risk } = setup();
    await risk.onHit(GROUP, U, 1, 'spam');
    h.clock.advance(2 * 3600_000);
    await risk.onHit(GROUP, U, 2, 'spam');
    expect(h.tg.muted[1]).toEqual([GROUP, U, Math.floor(h.clock.now() / 1000) + 86_400]);
    expect(h.tg.prompts[1]!.text).toContain('Warning 2 of 2 — muted for 24 hours');
    h.clock.advance(2 * 86_400_000);
    await risk.onHit(GROUP, U, 3, 'spam');
    expect(h.tg.banned).toEqual([[GROUP, U]]);
    expect(h.tg.muted).toHaveLength(2);
    expect(h.tg.prompts[2]!.text).toBe('🛡 Message removed: third risk-control violation. Removed from the group.');
    expect(h.tg.deleted).toEqual([1, 2, 3]);
    expect(h.store.listAudit(GROUP, 1)[0]).toMatchObject({ action: 'risk_banned', subject_user_id: U });
  });
  test('strikes are per group, forgotten after 30 quiet days, and reset by /unban', async () => {
    const { h, risk } = setup();
    enrol(h, -2002, 2000);
    await risk.onHit(GROUP, U, 1, 'spam');
    await risk.onHit(-2002, U, 2, 'spam'); // another group starts its own count
    expect(h.tg.prompts.map((p) => p.text.includes('Warning 1 of 2'))).toEqual([true, true]);
    h.clock.advance(31 * 86_400_000);
    await risk.onHit(GROUP, U, 3, 'spam');
    expect(h.tg.prompts[2]!.text).toContain('Warning 1 of 2');
    h.clock.advance(3600_000);
    await risk.onHit(GROUP, U, 4, 'spam');
    expect(h.tg.prompts[3]!.text).toContain('Warning 2 of 2');
    await h.admin.moderateInGroup(OWNER, GROUP, U, { kind: 'unban' });
    h.clock.advance(3600_000);
    await risk.onHit(GROUP, U, 5, 'spam');
    expect(h.tg.prompts[4]!.text).toContain('Warning 1 of 2');
    expect(h.tg.banned).toEqual([]);
  });
  test('without the Ban users right the message is still deleted and admins are told', async () => {
    const { h, risk } = setup();
    h.tg.mute = async () => {
      throw new TgError('bad_request', 'Bad Request: not enough rights to restrict/unrestrict chat member');
    };
    await risk.onHit(GROUP, U, 1, 'spam');
    expect(h.tg.deleted).toEqual([1]);
    expect(h.tg.prompts[0]!.text).toBe('🛡 Message removed: it triggered the bot’s risk control.');
    expect(h.tg.messages.filter((m) => m.chatId === OWNER && m.text.includes('Ban users'))).toHaveLength(1);
  });
  test('group administrators are exempt', async () => {
    const { h, risk } = setup();
    await risk.onHit(GROUP, MOD, 930, 'spam');
    await risk.onHit(GROUP, OWNER, 931, 'spam');
    expect(h.tg.deleted).toEqual([]);
  });
  test('switching risk control off stops deletion even for hits already queued', async () => {
    const { h, risk } = setup({ riskControl: false });
    await risk.onHit(GROUP, U, 940, 'spam');
    expect(h.tg.deleted).toEqual([]);
  });
  test('without the Delete messages right, admins are told once an hour and nothing is posted', async () => {
    const { h, risk } = setup();
    h.tg.deleteMessage = async () => {
      throw new TgError('bad_request', "Bad Request: message can't be deleted");
    };
    await risk.onHit(GROUP, U, 950, 'spam');
    await risk.onHit(GROUP, U, 951, 'spam');
    const alerts = h.tg.messages.filter((m) => m.chatId === OWNER && m.text.includes('Delete messages'));
    expect(alerts).toHaveLength(1);
    expect(h.tg.prompts).toHaveLength(0);
    expect(h.store.listAudit(GROUP, 5).some((a) => a.action === 'risk_deleted')).toBe(false);
    h.clock.advance(3_600_001);
    await risk.onHit(GROUP, U, 952, 'spam');
    expect(h.tg.messages.filter((m) => m.chatId === OWNER && m.text.includes('Delete messages'))).toHaveLength(2);
  });
  test('a message someone else already deleted is ignored quietly', async () => {
    const { h, risk } = setup();
    h.tg.deleteMessage = async () => {
      throw new TgError('bad_request', 'Bad Request: message to delete not found');
    };
    await risk.onHit(GROUP, U, 960, 'spam');
    expect(h.tg.prompts).toHaveLength(0);
    expect(h.tg.messages.filter((m) => m.chatId === OWNER)).toHaveLength(0);
  });
  test('end to end: a group message through intake, inbox and routing is deleted', async () => {
    const { h, risk } = setup();
    h.store.addRiskKeywords(GROUP, ['buy followers'], OWNER, h.clock.now());
    const bot = new Bot('1:test', {
      botInfo: { id: BOT_ID, is_bot: true, first_name: 'G', username: 'guard_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as never,
    });
    bot.api.config.use(async () => ({ ok: true, result: true }) as never);
    registerRoutes(bot, { verification: h.v, admin: h.admin, store: h.store, assets: new LocalAssetStore(ASSETS_DIR), tg: h.tg, clock: h.clock, risk });
    const poller = new Poller(bot, h.store, h.clock, check(h));
    await poller.accept([groupMessage(40, U, { text: 'BUY FOLLOWERS cheap' }), groupMessage(41, U, { text: 'good morning' })]);
    await poller.processInbox();
    expect(h.tg.deleted).toEqual([740]);
    expect(h.tg.prompts).toHaveLength(1);
    const stored = JSON.stringify(h.store.db.query('SELECT * FROM inbox').all());
    expect(stored).not.toContain('cheap');
  });
});

describe('/keywords', () => {
  const buttons = (h: Harness, chat: number) => h.tg.messages.filter((m) => m.chatId === chat && m.markup).at(-1)!.markup!.inline_keyboard.flat();
  const tap = (h: Harness, actor: number, label: RegExp, msg = 77) => {
    const b = [...h.tg.edits, ...h.tg.messages].filter((m) => m.markup).flatMap((m) => m.markup!.inline_keyboard.flat()).reverse().find((x) => label.test(x.text))!;
    return h.admin.onAction(actor, actor, (b as { callback_data: string }).callback_data.slice(2), msg);
  };

  test('any group admin adds and removes keywords; the panel lists them as remove buttons', async () => {
    const { h } = setup();
    await h.admin.keywords(MOD, MOD, 'add Free USDT, 加微信，t.me/joinchat');
    expect(h.store.listRiskKeywords(GROUP)).toEqual(['free usdt', '加微信', 't.me/joinchat']);
    expect(h.tg.messages.some((m) => m.chatId === MOD && m.text.startsWith('Added 3'))).toBe(true);
    await h.admin.keywords(MOD, MOD, 'add free usdt');
    expect(h.tg.messages.some((m) => m.chatId === MOD && m.text.includes('Already in the list: free usdt'))).toBe(true);
    expect(buttons(h, MOD).map((b) => b.text)).toEqual(['➕ Add keywords', '⏸ Turn risk control off', '❌ free usdt', '❌ 加微信', '❌ t.me/joinchat', '🚫 Name ban list', '⚙️ Other settings']);
    expect(await tap(h, MOD, /❌ 加微信/)).toBe('Removed: 加微信');
    expect(h.store.listRiskKeywords(GROUP)).toEqual(['free usdt', 't.me/joinchat']);
    await h.admin.keywords(MOD, MOD, 'remove FREE USDT');
    expect(h.store.listRiskKeywords(GROUP)).toEqual(['t.me/joinchat']);
    const actions = h.store.listAudit(GROUP, 20).filter((a) => a.actor_user_id === MOD).map((a) => `${a.action}:${a.reason_code}`);
    expect(actions).toContain('keyword_added:加微信');
    expect(actions).toContain('keyword_removed:free usdt');
  });
  test('the toggle switches risk control off and on', async () => {
    const { h } = setup();
    await h.admin.keywords(OWNER, OWNER, '');
    expect(await tap(h, OWNER, /Turn risk control off/)).toBe('Risk control off');
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).riskControl).toBe(false);
    expect(await tap(h, OWNER, /Turn risk control on/)).toBe('Risk control on');
    expect(h.store.settingsOf(h.store.getGroup(GROUP)!).riskControl).toBe(true);
  });
  test('ordinary members cannot see or change keywords, and buttons are actor-bound', async () => {
    const { h } = setup();
    h.store.addRiskKeywords(GROUP, ['secret word'], OWNER, h.clock.now());
    await h.admin.keywords(7777, 7777, 'add hello');
    await h.admin.keywords(7777, 7777, '');
    expect(h.store.listRiskKeywords(GROUP)).toEqual(['secret word']);
    expect(h.tg.messages.filter((m) => m.chatId === 7777).some((m) => m.text.includes('secret word'))).toBe(false);
    await h.admin.keywords(OWNER, OWNER, '');
    expect(await tap(h, 7777, /❌ secret word/)).toContain('no longer valid');
    expect(h.store.listRiskKeywords(GROUP)).toEqual(['secret word']);
  });
  test('keywords live in runtime_state (no schema change) and go away with the group', () => {
    const { h } = setup();
    h.store.addRiskKeywords(GROUP, ['a:b*c?', '加微信'], OWNER, h.clock.now());
    h.store.addRiskKeywords(-2002, ['other group'], OWNER, h.clock.now());
    expect(h.store.listRiskKeywords(GROUP)).toEqual(['a:b*c?', '加微信']); // punctuation and GLOB characters are literal
    const rows = h.store.db.query("SELECT key FROM runtime_state WHERE key LIKE 'risk_keyword:%' ORDER BY rowid").all() as { key: string }[];
    expect(rows.map((r) => r.key)).toEqual([`risk_keyword:${GROUP}:a:b*c?`, `risk_keyword:${GROUP}:加微信`, 'risk_keyword:-2002:other group']);
    h.store.removeGroup(GROUP, OWNER, h.clock.now());
    expect(h.store.listRiskKeywords(GROUP)).toEqual([]);
    expect(h.store.listRiskKeywords(-2002)).toEqual(['other group']);
  });
  test('the list is capped per group', () => {
    const { h } = setup();
    const many = Array.from({ length: RISK_KEYWORDS_PER_GROUP + 5 }, (_, i) => `word${i}`);
    const { added, full } = h.store.addRiskKeywords(GROUP, many, OWNER, h.clock.now());
    expect(added).toHaveLength(RISK_KEYWORDS_PER_GROUP);
    expect(full).toBe(true);
  });
  test('settings panel and status card show risk control', async () => {
    const { h } = setup();
    h.store.addRiskKeywords(GROUP, ['a1', 'b2'], OWNER, h.clock.now());
    await h.admin.settings(OWNER, OWNER, '');
    expect(buttons(h, OWNER).some((b) => b.text === '🛡 Risk-control keywords: on, 2')).toBe(true);
    expect(buttons(h, OWNER).some((b) => b.text === '🚫 Name ban list: on, 0')).toBe(true);
    await h.admin.status(OWNER, OWNER);
    const card = h.tg.messages.filter((m) => m.chatId === OWNER).at(-1)!.text;
    expect(card).toContain('🛡 <b>Risk control:</b> on · 2 keywords · 0 name bans');
    expect(card).toContain('Delete risky messages: 🔴 missing “Delete messages” right');
  });
});

describe('quoted messages', () => {
  test('the quote block of a reply, and a quote from another chat, are checked', () => {
    const { h } = setup();
    h.store.addRiskKeywords(GROUP, ['scam.example'], OWNER, h.clock.now());
    const r = check(h);
    const quoted = projectUpdate(groupMessage(60, U, { text: 'see this', quote: { text: 'visit scam.example now', position: 0 } }), r) as { message: { _risk: string } };
    expect(quoted.message._risk).toBe('scam.example');
    const external = projectUpdate(groupMessage(61, U, {
      text: 'ok', external_reply: { origin: { type: 'channel', date: 1, chat: { id: -100, type: 'channel', title: 'C' }, message_id: 1 }, chat: { id: -100, type: 'channel', title: 'C' } },
      quote: { text: 'scam.example giveaway', position: 0 },
    }), r);
    expect(external).not.toBeNull();
    expect(projectUpdate(groupMessage(62, U, { text: 'ok', external_reply: { origin: { type: 'hidden_user', date: 1, sender_user_name: 'x' }, poll: { question: 'go to scam.example?' } } }), r)).not.toBeNull();
    expect(projectUpdate(groupMessage(63, U, { text: 'fine', quote: { text: 'also fine', position: 0 } }), r)).toBeNull();
    expect(JSON.stringify(quoted)).not.toContain('visit');
  });
});

describe('name ban list', () => {
  const names = (h: Harness) => (chatId: number, name: string) => matchRiskKeyword(name, h.store.activeNameKeywords(chatId));
  const spamName = { first_name: '莪这有路*子', username: 'road_x' };
  const joinRequest = (id: number, from: Record<string, unknown>): Update => ({
    update_id: id,
    chat_join_request: { chat: { id: GROUP, type: 'supergroup', title: 'G' }, from: { id: U, is_bot: false, ...from }, user_chat_id: U, date: 1 },
  }) as unknown as Update;
  const memberJoin = (id: number, from: Record<string, unknown>): Update => ({
    update_id: id,
    chat_member: {
      chat: { id: GROUP, type: 'supergroup', title: 'G' },
      from: { id: U, is_bot: false, first_name: 'x' },
      date: 1,
      old_chat_member: { status: 'left', user: { id: U, is_bot: false, ...from } },
      new_chat_member: { status: 'member', user: { id: U, is_bot: false, ...from } },
    },
  }) as unknown as Update;
  const pipeline = (h: Harness, risk: RiskControl) => {
    const bot = new Bot('1:test', {
      botInfo: { id: BOT_ID, is_bot: true, first_name: 'G', username: 'guard_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as never,
    });
    bot.api.config.use(async () => ({ ok: true, result: true }) as never);
    registerRoutes(bot, { verification: h.v, admin: h.admin, store: h.store, assets: new LocalAssetStore(ASSETS_DIR), tg: h.tg, clock: h.clock, risk });
    return new Poller(bot, h.store, h.clock, check(h), names(h));
  };
  const requests = (h: Harness) => (h.store.db.query('SELECT COUNT(*) AS n FROM join_requests').get() as { n: number }).n;

  test('an obfuscated name is matched; the name itself never reaches the inbox', () => {
    const { h } = setup();
    h.store.addKeywords('name', GROUP, ['有路子'], OWNER, h.clock.now());
    const hit = projectUpdate(joinRequest(1, spamName), undefined, names(h)) as { chat_join_request: { _nameban: string } };
    expect(hit.chat_join_request._nameban).toBe('有路子');
    expect(JSON.stringify(hit)).not.toContain('莪');
    expect(JSON.stringify(hit)).not.toContain('road_x');
    const ok = projectUpdate(joinRequest(2, { first_name: 'Agent Smith' }), undefined, names(h)) as { chat_join_request: object };
    expect(ok.chat_join_request).not.toHaveProperty('_nameban');
    // @username is checked too
    h.store.addKeywords('name', GROUP, ['road_x'], OWNER, h.clock.now());
    expect((projectUpdate(joinRequest(3, { first_name: 'Nice', username: 'Road_X' }), undefined, names(h)) as { chat_join_request: { _nameban: string } }).chat_join_request._nameban).toBe('road_x');
  });

  test('a join request is declined and the person banned, without starting verification', async () => {
    const { h, risk } = setup();
    h.store.addKeywords('name', GROUP, ['有路子'], OWNER, h.clock.now());
    const poller = pipeline(h, risk);
    await poller.accept([joinRequest(10, spamName)]);
    await poller.processInbox();
    expect(h.tg.declined).toEqual([[GROUP, U]]);
    expect(h.tg.banned).toEqual([[GROUP, U]]);
    expect(requests(h)).toBe(0);
    expect(h.store.listAudit(GROUP, 5).some((a) => a.action === 'name_banned' && a.reason_code === '有路子')).toBe(true);
  });

  test('someone who joins by invite link is banned at once, with no picture check and no group notice', async () => {
    const { h, risk } = setup();
    h.store.addKeywords('name', GROUP, ['这有路'], OWNER, h.clock.now());
    const poller = pipeline(h, risk);
    await poller.accept([memberJoin(20, spamName)]);
    await poller.processInbox();
    expect(h.tg.banned).toEqual([[GROUP, U]]);
    expect(requests(h)).toBe(0);
    expect(h.tg.prompts).toHaveLength(0);
  });

  test('a member whose name matches is banned when they post; their message and the join notice are deleted once', async () => {
    const { h, risk } = setup();
    h.store.addKeywords('name', GROUP, ['有路子'], OWNER, h.clock.now());
    const poller = pipeline(h, risk);
    await poller.accept([
      groupMessage(30, U, { from: { id: U, is_bot: false, ...spamName }, new_chat_members: [{ id: U, is_bot: false, ...spamName }] }),
      groupMessage(31, U, { from: { id: U, is_bot: false, ...spamName }, text: 'hello' }),
    ]);
    await poller.processInbox();
    expect(h.tg.banned).toEqual([[GROUP, U]]);
    expect(h.tg.deleted).toEqual([730, 731]);
    expect(h.store.listAudit(GROUP, 5).filter((a) => a.action === 'name_banned')).toHaveLength(1);
  });

  test('administrators are exempt, and nothing happens with risk control off', async () => {
    const { h, risk } = setup();
    expect(await risk.onNameHit(GROUP, MOD, '有路子', { kind: 'member' })).toBe(false);
    const off = setup({ riskControl: false });
    off.h.store.addKeywords('name', GROUP, ['有路子'], OWNER, off.h.clock.now());
    expect(projectUpdate(joinRequest(40, spamName), undefined, names(off.h)) as object).not.toHaveProperty('chat_join_request._nameban');
    expect(await off.risk.onNameHit(GROUP, U, '有路子', { kind: 'request' })).toBe(false);
    expect([...h.tg.banned, ...off.h.tg.banned]).toEqual([]);
  });

  test('without the Ban users right the normal flow continues and admins are told', async () => {
    const { h, risk } = setup();
    h.tg.ban = async () => {
      throw new TgError('bad_request', 'Bad Request: not enough rights to restrict/unrestrict chat member');
    };
    expect(await risk.onNameHit(GROUP, U, '有路子', { kind: 'member' })).toBe(false);
    expect(h.tg.messages.filter((m) => m.chatId === OWNER && m.text.includes('/bannames'))).toHaveLength(1);
  });

  test('/bannames adds and removes; the list is separate from message keywords and lives in runtime_state', async () => {
    const { h } = setup();
    await h.admin.banNames(MOD, MOD, 'add 有路子, 加V');
    expect(h.store.listKeywords('name', GROUP)).toEqual(['有路子', '加v']);
    expect(h.store.listRiskKeywords(GROUP)).toEqual([]);
    const panel = h.tg.messages.filter((m) => m.chatId === MOD && m.markup).at(-1)!;
    expect(panel.text).toContain('Name ban list');
    expect(panel.markup!.inline_keyboard.flat().map((b) => b.text)).toEqual(['➕ Add keywords', '⏸ Turn risk control off', '❌ 有路子', '❌ 加v', '🛡 Message keywords', '⚙️ Other settings']);
    await h.admin.banNames(MOD, MOD, 'remove 加V');
    expect(h.store.listKeywords('name', GROUP)).toEqual(['有路子']);
    const rows = h.store.db.query("SELECT key FROM runtime_state WHERE key LIKE 'name_keyword:%'").all() as { key: string }[];
    expect(rows.map((r) => r.key)).toEqual([`name_keyword:${GROUP}:有路子`]);
    const actions = h.store.listAudit(GROUP, 20).map((a) => `${a.action}:${a.reason_code}`);
    expect(actions).toContain('name_keyword_added:有路子');
    expect(actions).toContain('name_keyword_removed:加v');
    h.store.removeGroup(GROUP, OWNER, h.clock.now());
    expect(h.store.listKeywords('name', GROUP)).toEqual([]);
  });
});

describe('adding keywords with buttons', () => {
  const privateText = (id: number, from: number, text: string): Update => ({
    update_id: id,
    message: { message_id: 900 + id, date: 1, chat: { id: from, type: 'private', first_name: 'A' }, from: { id: from, is_bot: false, first_name: 'A' }, text },
  }) as unknown as Update;
  const tapLatest = (h: Harness, actor: number, label: RegExp) => {
    const b = [...h.tg.edits, ...h.tg.messages].filter((m) => m.markup).flatMap((m) => m.markup!.inline_keyboard.flat()).reverse().find((x) => label.test(x.text))!;
    return h.admin.onAction(actor, actor, (b as { callback_data: string }).callback_data.slice(2), 77);
  };
  const pipeline = (h: Harness) => {
    const bot = new Bot('1:test', {
      botInfo: { id: BOT_ID, is_bot: true, first_name: 'G', username: 'guard_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as never,
    });
    bot.api.config.use(async () => ({ ok: true, result: true }) as never);
    registerRoutes(bot, { verification: h.v, admin: h.admin, store: h.store, assets: new LocalAssetStore(ASSETS_DIR), tg: h.tg, clock: h.clock });
    return new Poller(bot, h.store, h.clock, undefined, undefined, (userId) => pendingKeywordInput(h.store, userId, h.clock.now()) !== undefined);
  };

  test('tap ➕ Add, then send the list as a plain message: new lines and commas separate keywords', async () => {
    const { h } = setup();
    const poller = pipeline(h);
    await h.admin.banNames(MOD, MOD, '');
    expect(await tapLatest(h, MOD, /➕ Add keywords/)).toBe('Send the keywords as a message');
    expect(h.tg.messages.at(-1)!.text).toContain('Send the name keywords');
    await poller.accept([privateText(1, MOD, '有路子\n加V，代理')]);
    await poller.processInbox();
    expect(h.store.listKeywords('name', GROUP)).toEqual(['有路子', '加v', '代理']);
    expect(h.store.listRiskKeywords(GROUP)).toEqual([]);
    // The wait is over: the next plain message is not kept or added.
    await poller.accept([privateText(2, MOD, 'another')]);
    await poller.processInbox();
    expect(h.store.listKeywords('name', GROUP)).toHaveLength(3);
    expect(JSON.stringify(h.store.db.query('SELECT * FROM inbox').all())).not.toContain('another');
  });

  test('plain private text is still discarded unless that admin is adding; the wait expires and can be cancelled', async () => {
    const { h } = setup();
    const poller = pipeline(h);
    await poller.accept([privateText(10, U, 'my secret')]);
    expect(JSON.stringify(h.store.db.query('SELECT * FROM inbox').all())).not.toContain('secret');
    await h.admin.keywords(MOD, MOD, '');
    await tapLatest(h, MOD, /➕ Add keywords/);
    h.clock.advance(11 * 60_000);
    await poller.accept([privateText(11, MOD, 'late')]);
    await poller.processInbox();
    expect(h.store.listRiskKeywords(GROUP)).toEqual([]);
    await h.admin.keywords(MOD, MOD, '');
    await tapLatest(h, MOD, /➕ Add keywords/);
    expect(await tapLatest(h, MOD, /Cancel/)).toBe('Cancelled');
    await poller.accept([privateText(12, MOD, 'spam')]);
    await poller.processInbox();
    expect(h.store.listRiskKeywords(GROUP)).toEqual([]);
  });

  test('typed lists keep new lines as separators', async () => {
    const { h } = setup();
    await h.admin.keywords(MOD, MOD, 'add one\ntwo words\nthree');
    expect(h.store.listRiskKeywords(GROUP)).toEqual(['one', 'two words', 'three']);
  });
});

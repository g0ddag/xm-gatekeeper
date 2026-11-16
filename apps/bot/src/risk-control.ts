import { RISK_BAN_AT, RISK_STRIKES, errorCode, log, type Clock } from '@guard/core';
import type { Store } from '@guard/database';
import { t } from '@guard/i18n';
import type { Authority } from './admin/authority';
import { classify, type Tg } from './telegram';

/** How long the "removed by risk control" notice stays in the group before the bot deletes it. */
export const RISK_NOTICE_TTL_MS = 60_000;
const RIGHTS_ALERT_INTERVAL_MS = 3_600_000;

type RiskStore = Pick<Store, 'getGroup' | 'settingsOf' | 'audit' | 'scheduleReviewNotice' | 'getState' | 'setState' | 'recordRiskStrike'>;

/**
 * Acts on a group message that intake matched against a risk-control keyword. The message is
 * always deleted. Then strikes escalate: strikes 1 and 2 warn and mute (1 h, then 24 h); strike 3
 * bans, which removes the person from the group. Each counted strike posts one notice naming the
 * sender that deletes itself after a minute. Group administrators are exempt. The message text
 * was never stored; only the keyword that matched is known here.
 */
export class RiskControl {
  constructor(
    private readonly store: RiskStore,
    private readonly tg: Pick<Tg, 'deleteMessage' | 'sendGroupPrompt' | 'mute' | 'ban'>,
    private readonly authority: Pick<Authority, 'admins'>,
    private readonly clock: Clock,
    private readonly notifyAdmins: (chatId: number, text: string) => Promise<void>,
  ) {}

  async onHit(chatId: number, userId: number, messageId: number, keyword: string): Promise<void> {
    const group = this.store.getGroup(chatId);
    if (!group || !group.enabled) return;
    const settings = this.store.settingsOf(group);
    if (!settings.riskControl) return;
    // Admins are exempt. If Telegram cannot be asked right now, act anyway: spam removal wins.
    const admins = await this.authority.admins(chatId, false).catch(() => undefined);
    if (admins?.some((a) => a.userId === userId)) return;

    const now = this.clock.now();
    try {
      await this.tg.deleteMessage(chatId, messageId);
    } catch (e) {
      const err = classify(e);
      if (/message to delete not found/i.test(err.message)) return; // already gone
      if (err.kind === 'forbidden' || /can't be deleted|not enough rights/i.test(err.message)) {
        await this.alertMissingRight(chatId, settings.label || String(chatId), now);
        return;
      }
      log('warn', 'risk_delete_failed', { kind: err.kind, error: errorCode(e) });
      return;
    }
    this.store.audit(chatId, null, userId, 'risk_deleted', keyword, now);
    log('info', 'risk_deleted', { chat: chatId });

    // Messages sent in a burst before the first mute took effect count as one strike.
    const strike = this.store.recordRiskStrike(chatId, userId, now);
    if (!strike.counted) return;
    const label = settings.label || String(chatId);
    const locale = settings.helpLocale;
    let text: string;
    try {
      if (strike.count >= RISK_BAN_AT) {
        await this.tg.ban(chatId, userId);
        this.store.audit(chatId, null, userId, 'risk_banned', keyword, now);
        text = t(locale, 'risk.banned');
      } else {
        const step = RISK_STRIKES[Math.min(strike.count, RISK_STRIKES.length) - 1]!;
        await this.tg.mute(chatId, userId, Math.floor(now / 1000) + step.muteSec);
        this.store.audit(chatId, null, userId, 'risk_muted', `${keyword} · strike ${strike.count}`, now);
        text = t(locale, 'risk.warned', { strike: strike.count, duration: t(locale, strike.count === 1 ? 'risk.dur.1' : 'risk.dur.2') });
      }
    } catch (e) {
      const err = classify(e);
      log('warn', 'risk_escalation_failed', { kind: err.kind, error: errorCode(e) });
      if (err.kind === 'forbidden' || /not enough rights/i.test(err.message)) {
        await this.alertMissing(chatId, label, now, 'nobanright', `⚠️ ${label}: risk control deleted a message but could not mute or ban its sender. Give me the "Ban users" admin right.`);
      }
      text = t(locale, 'risk.removed');
    }
    try {
      const notice = await this.tg.sendGroupPrompt(chatId, userId, text, { inline_keyboard: [] });
      this.store.scheduleReviewNotice(chatId, notice, now + RISK_NOTICE_TTL_MS);
    } catch (e) {
      log('warn', 'risk_notice_failed', { kind: classify(e).kind });
    }
  }

  private alertMissingRight(chatId: number, label: string, now: number): Promise<void> {
    return this.alertMissing(chatId, label, now, 'nodelete',
      `⚠️ ${label}: a message matched a risk-control keyword but I could not delete it. Give me the "Delete messages" admin right, or turn risk control off in /keywords.`);
  }

  /** One warning per problem per group per hour. */
  private async alertMissing(chatId: number, _label: string, now: number, kind: string, text: string): Promise<void> {
    const key = `${kind}:${chatId}`;
    if (now - Number(this.store.getState(key) ?? '0') < RIGHTS_ALERT_INTERVAL_MS) return;
    this.store.setState(key, String(now));
    await this.notifyAdmins(chatId, text);
  }
}

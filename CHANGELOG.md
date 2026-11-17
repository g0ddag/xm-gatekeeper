# Changelog

## Unreleased

## 0.1.0-alpha.3

Add a per-group name ban list. Administrators manage it with `/bannames` (same
commands, buttons and matching rules as `/keywords`). Anyone whose first name, last
name or `@username` contains one of these keywords is banned at once: join requests
are declined, people who join are banned before verification starts, and members who
post are banned with the message deleted. No group notice is posted; bans are recorded
in audit with the keyword. Follows the risk-control switch, exempts administrators and
requires the **Ban users** right. Names are checked in memory and never stored.

Risk-control keywords now also match quoted text: the quote block of a reply,
including quotes taken from another chat, and polls quoted from another chat.

Keyword panels now add keywords with a **➕ Add keywords** button: the administrator
sends the list as one ordinary message. The bot keeps that one message's text only
while the add is pending (10 minutes, or until cancelled); other plain private
messages are still discarded. `/settings` links to both lists and the status card
shows the name-ban count. Typed `/keywords add` lists now keep new lines as
separators.

Both lists use existing storage; no schema change.

## 0.1.0-alpha.2

Add per-group risk control. Administrators manage keywords with `/keywords`;
matching group messages and edits are deleted, and senders are warned and muted for
one hour, then 24 hours, then banned on the third strike within 30 days. Requires the
**Delete messages** right. Keywords and strikes use existing storage; no schema change.

Automatically remove members or reject join requests after delivered checks time
out or exhaust wrong-answer attempts. Keep help requests, raid mode and detected
service problems in manual review. Existing review records are not retroactively
removed. Automatic decisions use the persistent outbox and are recorded in audit.

Automatically remove group review notices after one minute with persistent retries.
Existing tracked review notices are scheduled once on upgrade. Verification and
administrator review decisions are unchanged.

Paginate group selection and the status view, re-checking each administrator's
authority on every page. Clarify that picture attempt limits are a rate limit,
separate from the Cap and picture stage deadlines. Improve setup and onboarding
guidance for administrators.

## 0.1.0-alpha.1

First public Alpha release: Telegram member verification, self-hosted Cap and
picture checks, prepared image banks, durable queues, administrator controls and
English/Chinese verification. Includes original demo assets and automated tests.
Interfaces and schema may change before 1.0.

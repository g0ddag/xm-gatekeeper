# Changelog

## Unreleased

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

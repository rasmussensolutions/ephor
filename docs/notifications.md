# Notifications

Open the bell in the dashboard header or **Notifications** in the sidebar. The
Inbox contains in-app alerts, with unread indicators and individual/bulk read
controls. **Delivery history** shows in-app availability and each email's queue,
retry, failure, or submission status. Both views support older pages; history is
retained for 90 days.

## Setup

Apply migration `0011_notifications.sql` before starting the updated panel. No
machine/daemon upgrade is required. Notifications start observing new job results
when the notification settings are first initialized; historical failures are not
replayed. Existing offline machines are detected on the first background check.

In **Notifications → Notification settings**:

1. Choose events independently for in-app and email notifications. Preferences
   apply to all machines and apps in this single-owner installation.
2. To enable email, verify a sending domain in your own Resend account. Create a
   sending-only API key scoped to that domain, then enter it, a sender email, and
   up to five recipient addresses. Recipients are visible together in the To field.
3. Save settings using your passkey. A blank key field preserves an existing key.
   **Disconnect Resend** removes the saved key and disables email.
4. Use **Test in-app** or **Send test email**. Tests use saved settings and bypass
   event preferences. Watch Delivery history; email tests normally start within
   one minute. No external email is sent until email has been explicitly enabled.

Resend requires its own account/domain setup. A provider acceptance does not prove
inbox delivery. This release shows **Accepted by Resend**, with the message ID;
inspect Resend for delivery, suppression, and bounce details. It does not yet ingest
Resend delivery webhooks.

## Events and defaults

Failure, overdue, recovery, and restore notifications default on for both channels;
email remains globally disabled until configured. Routine successful backups default
off. Supported events are backup failure/overdue/recovery/success, failed storage
checks, completed or failed restores, failed deployment operations, and machines
losing or regaining telemetry.

A machine is offline after five minutes without telemetry. Daily and weekly backup
freshness checks allow the schedule interval plus one hour since the last verified
backup (or plan creation/notification initialization if newer). Manual plans are
excluded. This detects missing verified copies even if no job ever reports failure.

Backup failures and offline machines open incidents: repeated failures do not send
a new alert each poll. Unresolved conditions get at most one reminder per 24 hours.
A successful backup or new telemetry closes the corresponding incident and can
send a recovery notification. Storage checks, restores, and failed deployments
produce one notification per completed operation. Turning an overdue plan to Manual
closes its freshness incident without claiming a successful recovery.

## Background execution and delivery

The Node/Bun panel runs the processor on startup and every minute. Cloudflare uses
a one-minute scheduled trigger. A database lease prevents normal overlapping scans;
individual email claims also use atomic leases. Neither browser activity nor machine
polling drives notifications. The inbox warns if processing has not checked in for
five minutes. A stopped/unreachable panel cannot send its own outage notification;
use independent monitoring for the panel itself.

The processor reads durable job results and machine/backup state. Event keys and
processed-source markers prevent duplicate alerts across restarts. Each notification
and its encrypted email envelope are created in one database insert. The envelope
freezes the sender, recipients, credential, and panel origin for that delivery.
Changed preferences apply to future events; queued emails retain their original
settings. Disabling email cancels unstarted queued emails, but cannot recall an
in-flight message already accepted by the provider.

Resend calls use a fixed HTTPS endpoint, no redirects, a ten-second timeout, and a
stable per-notification idempotency key. Transient failures retry with backoff, at
most five attempts. An interrupted delivery can be reclaimed after its lease
expires. Automatic retries stop before Resend's 24-hour idempotency window expires;
ambiguous outcomes are labelled **Email delivery uncertain** rather than silently
resending outside that window. No manual redelivery endpoint is exposed in this
release; inspect Resend and send a new test after fixing the configuration.

Secrets are encrypted with record-bound AES-GCM using a separate notifications
key namespace. API responses never return API keys or delivery envelopes. Terminal
delivery records discard their credential snapshots. Settings and test mutations
require the owner's fresh passkey, exact-origin JSON requests, and test rate limits.
Read/unread actions require the owner session. Notification bodies include app or
machine names and safe panel links, not app secrets, raw logs, or provider errors.

## Verification

`bun test packages/api/test/notifications.test.ts` exercises encryption/redaction,
preferences, authorization, retries, crash recovery, concurrent claims, event
collection, offline/overdue detection, and history pagination. Set
`TEST_DATABASE_URL` to run the same suite against PostgreSQL. Tests use an injected
Resend transport and never send real email.

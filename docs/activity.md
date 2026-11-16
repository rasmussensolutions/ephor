# Activity

The Activity page records actions sent through the panel API: machines, deployments,
service configuration and variables, map and display changes, backups, integrations,
notification settings and read state, passkeys, recovery, and sessions. Explicit
DNS/HTTPS checks and workflow downloads are recorded too. Routine page reads,
polling, daemon telemetry, webhooks, and browser-only preferences are not panel
actions in this feed.

Each new entry stores the authenticated user's stable ID and a snapshot of their
name. The client cannot supply the actor. Sign-in and initial passkey registration
use the verified authentication response; sign-out retains the actor captured
before the session is deleted. Unauthenticated attempts are labeled accordingly.
Resource IDs and names are preserved even after renames or deletion. This is ready
for future multiple-user authentication without adding another user schema now.

Entries are inserted before executing the action, then marked succeeded or failed
from its HTTP response. A crash or an unavailable database during finalization
leaves an unconfirmed entry. A failure to insert prevents execution. This is a
request history, not an atomic transaction log: a failed or unconfirmed request
may have partially changed state. A successful queue request does not mean a
background deployment, update, or backup has completed; those results remain on
the corresponding resource pages and in Notifications.

The shared middleware captures all POST/PUT/PATCH/DELETE panel requests, including
future routes. Add a descriptive label and resource mapping in
`packages/api/src/activity/middleware.ts` when adding a route. Requests rejected by
the origin, request-size, or rate-limit boundary never reach activity logging.
Only explicitly selected identifiers and resource names are stored. Request and
response bodies, headers, variable values, passwords, tokens, and recovery codes
are not stored. The activity endpoint requires the normal authenticated boundary.

`GET /api/activity` supports `q`, `category`, `user`, `outcome`, `from`, `to`, and
`before`. Dates are epoch milliseconds (inclusive `from`, exclusive `to`). Results
are newest first, 50 at a time, with a timestamp and ID cursor to keep equal-time
entries stable. The UI interprets date filters and displays times in the browser's
local timezone. History has no automatic expiry.

Apply migration `0017_activity.sql` with the normal PostgreSQL or D1 migration
command before deploying the new API. It copies the available legacy audit events
once, preserving their original IDs and timestamps. Their actor and request
outcome are marked unknown because the old log did not record them. Actions that
were never recorded cannot be reconstructed.

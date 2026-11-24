# Connect an AI agent to Ephor

Every installation serves a remote MCP endpoint at `https://YOUR-EPHOR/mcp`.
The same implementation runs on Cloudflare Workers/D1 and Node/PostgreSQL
(including Docker, a VPS, and Railway). No central Ephor account or relay is needed.
Use HTTPS in production. The client must be able to reach the instance.

## Install and connect

1. Apply migration `0028_mcp.sql` with the normal deployment migration command,
   then deploy the API and dashboard together. The Worker asset routing config
   includes `/mcp`, `/oauth/*`, and `/.well-known/*`; preserve these routes in
   reverse proxies as well. Local dashboard development proxies them to the API.
2. Open **Settings → AI connections**. Select projects, deployment machines,
   repository discovery, permission to request changes, and optionally log access.
   New connections start with no project or machine access and no write permissions.
3. Add the endpoint to a remote MCP client supporting Streamable HTTP and OAuth
   authorization code with S256 PKCE and dynamic client registration. Sign in to
   Ephor, return to AI connections if login took you elsewhere, review the client
   return address, select permissions, and approve with your passkey. Only approve
   a connection you personally initiated. OAuth client names are untrusted labels.
4. Alternatively create an access token in AI connections, and configure your
   client to send `Authorization: Bearer <token>` using its secret/environment
   configuration. The token appears once. Never paste it into a model conversation,
   commit it, or put it in a URL. This works with clients that support bearer headers.

OAuth access tokens last one hour. Refresh tokens rotate on every use, expire with
the connection, and reuse revokes that connection. Clients must serialize refreshes
and save the replacement refresh token. There are no persistent MCP sessions.
Connections created in the UI expire after 30 days; the owner API permits 1–90 days.
Revocation is checked on every request and before execution/result disclosure.
Owner recovery and authentication-epoch changes invalidate existing connections.

## Edit an existing connection

In **Settings → AI connections → Connections**, choose **Edit permissions**.
Change the selected projects, machines, or capabilities, then choose **Save
permissions** and confirm with your passkey. The same OAuth connection or access
token continues working, with its existing expiration date. Permissions are read
again for subsequent requests and operation approvals; an edit does not stop work
that has already started. If another edit happened meanwhile, reopen the editor
and review the latest permissions before saving.

**Read all current and future projects** includes projects created later.
**Access all current and future machines** separately includes machines enrolled
later. Both are explicit grants. Existing connections retain their original
machine restrictions until you change them. Neither option bypasses approval for
infrastructure changes or log disclosure. Clients that cache their tool list may
need a tool refresh after capabilities such as changes or logs are enabled.

## Deploy a group of repositories

For “deploy these repos in Creatorical, configure domains, and verify health”:

1. Enroll the target machine and enable its deployment worker in Ephor. Connect
   the GitHub App to the repositories. These owner/bootstrap operations are not
   exposed to agents. Cloudflare hosts the panel; workloads run on enrolled Linux
   machines.
2. Grant the agent Creatorical project access, the target machine, repository
   discovery, and permission to request changes. To let it create Creatorical
   itself, explicitly grant all-project access; otherwise create the project first.
   You can grant all current and future machines instead of individual machines.
3. The agent lists projects, machines and repositories, then calls `create_service`
   per repository with its source, build settings, resources and domains. It must
   supply a unique `requestKey` and reuse it for retries of the same request.
4. Approve each concrete request in AI connections. Creation saves configuration
   and project membership; it does not deploy. GitHub automatic deployment is
   disabled for MCP-created services so pushes cannot bypass deployment approval.
5. The agent requests variable changes or database connections as needed.
   Variable values are write-only. A database reference is a whole value such as
   `${{SERVICE_UUID.DATABASE_URL}}`; both services must be in authorized projects.
6. The agent calls `deploy_service`. Review the service configuration, domains and
   GitHub commit before approving. A changed configuration or branch head requires
   a new request. Ephor queues the existing build/deployment worker pipeline.
7. The agent polls `operation_status`, then `inspect_service` for build/deployment
   progress and fresh runtime health. `check_domains` checks public DNS and TLS.
   Configuring a hostname in Ephor does not create records at your DNS provider.

The connector also supports catalog creation, resource/domain changes, stop,
rollback, metrics, environment variable names, and separately approved bounded
runtime/build log snapshots. There is no shell, arbitrary HTTP request, owner
credential management, secret reveal, or persistent-data deletion tool.

## Approval and security model

- The MCP endpoint accepts only its own bearer credentials, never owner cookies,
  daemon credentials, or provider tokens. Tokens are stored hashed. OAuth codes
  are one-use, short-lived and bound to the client, exact registered redirect,
  resource URL and PKCE challenge. Discovery uses configured `EPHOR_ORIGIN`.
- Project access includes future services in that project. Machine grants permit
  machine inspection and placement of new services; project access permits
  management of existing services in that project. Repository discovery exposes
  metadata from all connected GitHub installations and is a separate grant.
- Every mutation and log disclosure requires a fresh owner passkey through the
  same-origin owner API. An agent cannot approve itself or submit an approval flag.
  Approved operations are claimed with an atomic database update before execution.
  Approvals expire after ten minutes and are tied to exact validated arguments.
  Tool schemas reject additional fields. Independent agents cannot read each
  other's requests or results.
- Pending arguments and results are encrypted, including submitted variable values.
  The review screen shows variable names but hides their new values. Ordinary
  service reads are explicitly projected and exclude logs, registry credentials,
  variable values and raw database rows. References do not disclose credentials.
- Deploying or changing an application's code/domain can give that application
  access to its configured secrets. Read-only agents cannot request these changes;
  review production changes accordingly. Logs are untrusted and can contain secrets
  even after redaction, so disclosure has its own permission and approval.
- Successful approval means the operation was processed, not that a deployment is
  healthy. Builds run asynchronously. Errors expose bounded codes, not raw exception
  messages. Expired operation results are not returned to agents.
- A crash after claiming an operation leaves it `executing`; it is never blindly
  retried. Inspect actual service/build state before issuing a new request. Some
  multi-step operations can partially succeed (for example service creation before
  project attachment); the owner can reconcile them in the dashboard.
- Security activity records connection IDs, tool names and approval IDs without
  arguments, tokens or secrets. `auth:admin cleanup` removes expired OAuth data
  and encrypted operation payload/results, retaining request-key tombstones to
  prevent retries from silently re-executing old actions. Audit retention is 90 days.

## Verification

`bun test packages/api/test/mcp.test.ts` covers a real SDK client, scoped discovery,
owner approval, create/deploy/worker-report/health flow, replay, revocation, stale
state, fresh authentication, secret omission, log disclosure and OAuth/PKCE/refresh.
Set `TEST_DATABASE_URL` to an isolated PostgreSQL database to run the same tests
with PostgreSQL; otherwise they use SQLite. `bun run test:worker` exercises the
actual Worker, D1 migrations, discovery, bearer authentication and MCP transport.
These are local integration tests, not proof that a particular production instance,
external DNS provider or AI client has been configured correctly.

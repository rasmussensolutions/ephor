# Connect an AI agent to Ephor

Every installation serves remote MCP at `https://YOUR-EPHOR/mcp`, on Cloudflare
Workers/D1 or Node/PostgreSQL (Docker, VPS, Railway). Use HTTPS in production.

## Connect once, work from chat

1. Add your instance's MCP URL to your client using Streamable HTTP and OAuth.
   Ephor supports authorization code with S256 PKCE and dynamic client registration.
2. The browser opens a dedicated **Connect an AI client** page. If you need to
   sign in, Ephor returns you to that same request afterward.
3. Review the requesting client and return address. The editable connection name
   is prefilled from the client's registered name, for example ChatGPT or Codex.
   Client names are self-reported, not a verified identity.
4. Existing projects and machines are selected for read access initially. Choose
   **Manage and deploy** for infrastructure changes. Review the individual grants:
   - Access to all current and future projects is required to create projects.
   - Access to all current and future machines is an independent opt-in.
   - Repository discovery covers connected GitHub installations.
   - Log access is separate and off by default; logs can contain sensitive output.
   - **Allow permitted actions directly from chat** means no per-action panel visit.
5. Choose **Connect**. A fresh owner passkey session authorizes the one-time grant.
   Ephor returns you to your AI client. Connections expire after 30 days.

The client controls its confirmation prompts. Ephor cannot prove that a client
showed a prompt, so grant only the authority you trust that client to exercise.
There is no agent-supplied approval flag. Ephor enforces the current connection
permissions for every call and immediately before executing an operation.

For clients using bearer credentials, create a token under **Settings → AI
connections** and review the same permissions. Put the token in the client's secure
credential configuration, never in chat, URLs or source control. It appears once.

## Existing connections

Open **Settings → MCP → Edit permissions** to change a connection's
name or grants. Save with your passkey. Credentials and expiry stay the same;
revocation and permission narrowing apply to subsequent calls. Work already
running is not cancelled.

Connections created before direct execution retain their original per-action
panel approvals. They are not silently upgraded to broader authority. To switch
an existing connection once, explicitly enable **Allow permitted actions directly
from chat** and save. New requests then run from chat. An old request key belonging
to a panel approval cannot be reused as a direct operation: inspect its state and
submit a new request key. Pending legacy requests are never automatically executed.

Authenticated clients discover the complete tool catalog regardless of their
grants. A listed tool does not imply access. `MCP_SCOPE_DENIED` means the connection
lacks a required grant. Updating permissions does not require refreshing tools.
After upgrading server tool descriptions or schemas, refresh the client's imported
metadata once. Clients that retain an older filtered catalog may need a reimport.
Panel 0.3.11 fixed creation schemas rejected by Python JSON Schema validators.

## Deploy repositories

Enroll the target machine and connect the GitHub App to your repositories in Ephor
once. Cloudflare hosts the panel; workloads run on enrolled Linux machines.

With the appropriate grants, the agent can:

1. List projects, machines and repositories, and create a project if needed.
2. Create services from GitHub repositories, container images or catalog templates.
   Creation saves configuration without deploying; GitHub auto-deploy is disabled.
3. Configure resources, domains and variables. Variable values are write-only;
   existing secret values cannot be read. Database references must refer to an
   authorized service, using the whole-value `${{SERVICE_UUID.DATABASE_URL}}` form.
4. Deploy, stop or roll back services. Deployments pin configuration and GitHub
   commits. If state changes during preparation, inspect it before retrying.
5. Poll `operation_status`, inspect fresh health, and verify DNS and HTTPS.
   Setting a domain in Ephor does not create DNS records at your domain provider.
6. Read bounded application/build logs only if separately granted log access.

Every tracked operation requires a unique `requestKey`. Reuse it on retries of the
same operation, including after a network timeout. A completed result is returned
without executing again; a concurrent retry observes the already claimed request.
A completed deployment operation means deployment was queued, not that the service
is healthy. Builds and deployments run asynchronously and need health verification.

`configure_service` accepts partial `buildSettings` for GitHub services: build
memory, CPU, build type, context directory, and Dockerfile path. Unspecified source
settings are preserved. Build limits are separate from runtime resources; for a
monorepo, use the repository root as context when the Dockerfile needs the root
lockfile or sibling workspace manifests. Deploy separately to apply changes.

## Security and failure handling

- OAuth discovery uses the configured instance origin. Codes are single-use and
  bound to the registered callback, resource, client and S256 PKCE challenge.
  Tokens are hashed; OAuth access tokens last one hour. Refresh tokens rotate and
  replay revokes the connection. Clients must serialize refresh requests.
- Connection creation, editing and revocation require a fresh owner passkey.
  MCP credentials cannot access owner APIs, approve legacy requests or grant
  themselves additional permissions. Owner recovery invalidates connections.
- Every call enforces project/machine scopes and separate management, repository
  and log capabilities. Execution atomically claims an operation against the
  current connection policy, revocation, expiry and authentication epoch, then
  checks authorization again before executing. There is no shell, arbitrary HTTP,
  secret-reveal, owner-credential management or persistent-data deletion tool.
- Operation payloads and results are encrypted, including submitted variables.
  Ordinary reads omit secret values, registry credentials and raw logs. Audit and
  operation summaries omit secrets. Log redaction is best-effort; log access can
  disclose application output to the AI client/model provider.
- Deploying code grants the workload access to its configured secrets. Review
  the authority you grant and use your AI client's confirmation controls.
- Requests/results expire after ten minutes. Expired request keys cannot execute
  again. A crash after claiming leaves the operation `executing`; it is never
  blindly retried. Inspect actual state before submitting a new operation.
- Multi-step operations may partially succeed. Failed results retain the operation
  ID and a bounded error code; inspect state before retrying. Permission changes
  and revocation also govern subsequent result disclosure.
- Security activity records connection/tool/operation identifiers, never tokens
  or secret arguments. `auth:admin cleanup` removes expired OAuth and encrypted
  operation data while retaining request-key tombstones. Audit retention is 90 days.

## Verification

`bun test packages/api/test/mcp.test.ts apps/dashboard/test/mcp.test.ts` covers
OAuth/PKCE/refresh, scoped consent details, login continuation validation, stable
SDK discovery, direct create/deploy/health/log flows, replay, legacy compatibility,
permission races, passkeys, revocation, secret omission and schema portability.
Python 3 (standard library only) checks regex compatibility with non-JavaScript
clients. `TEST_DATABASE_URL` runs backend tests in isolated PostgreSQL schemas;
otherwise they use SQLite. `bun run test:worker` exercises the real Worker/D1
runtime. These checks do not prove a particular AI client displays confirmations.

### Connection history and client registration

Revoked connections can be deleted from Settings → MCP. Deletion removes their
credentials, OAuth grants and operation details. Named agent activity remains in
Activity, including operations recorded before this upgrade. Work already executing
must finish before its connection can be deleted.

OAuth supports HTTPS Client ID Metadata Documents (CIMD) as well as dynamic client
registration. Metadata identity, redirect URIs and supported authentication methods
are validated before consent. Documents are bounded, time limited, cached according
to their HTTP freshness, and never fetched through redirects. Node/Bun pins a public
DNS address; Workers uses its public Internet fetch transport. Private and mixed
public/private DNS results are rejected. Authorization responses include the exact
issuer (`iss`). PKCE, resource binding and rotating refresh tokens apply to both
registration methods.

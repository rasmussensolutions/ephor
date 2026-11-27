import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createApi } from "../src";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { Builds } from "../src/services/builds";
import { catalogConfig } from "../src/services/catalog";
import { referenceValue } from "../src/services/connections";
import { dnsRecords, reserveDomains } from "../src/services/domains";
import { GitHubApp } from "../src/services/github-app";
import { type ServiceSource, serviceDomains } from "../src/services/spec";
import { Services } from "../src/services/store";
import { ServiceVariables } from "../src/services/variables";
import { enrolled, fixture } from "./helpers";

const sha = "a".repeat(40),
  newer = "b".repeat(40);
const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs1" },
  publicKeyEncoding: { format: "pem", type: "spki" },
}).privateKey;
const secret = "a-webhook-secret";
async function setup() {
  const f = await fixture();
  let head = sha;
  let avatarUrl = "https://avatars.githubusercontent.com/u/456?v=4";
  let avatarBytes = "first avatar";
  const requests: {
    path: string;
    ref: string | null;
    body: unknown;
    origin: string;
    authenticated: boolean;
    avatarSize: string | null;
  }[] = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      ref: url.searchParams.get("ref"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      origin: url.origin,
      authenticated: new Headers(init?.headers).has("Authorization"),
      avatarSize: url.searchParams.get("s"),
    });
    if (url.origin === "https://avatars.githubusercontent.com")
      return new Response(avatarBytes, {
        headers: { "Content-Type": "image/png" },
      });
    let body: unknown;
    if (url.pathname.endsWith("/access_tokens"))
      body = { token: "ghs_ephemeral-token" };
    else if (url.pathname === "/installation/repositories")
      body = {
        total_count: 2,
        repositories: [
          {
            id: 123,
            full_name: "acme/web",
            owner: { id: 456 },
            default_branch: "main",
            private: true,
            archived: false,
            pushed_at: "2026-11-16T12:00:00Z",
          },
          {
            id: 124,
            full_name: "acme/archived",
            owner: { id: 456 },
            default_branch: "main",
            private: false,
            archived: true,
          },
        ],
      };
    else if (url.pathname === "/repositories/123")
      body = {
        id: 123,
        full_name: "acme/web",
        owner: { id: 456 },
        default_branch: "main",
        private: true,
        archived: false,
      };
    else if (url.pathname === "/repos/acme/web/branches/main")
      body = { commit: { sha: head } };
    else if (url.pathname === "/repos/acme/web/contents")
      body = [
        { type: "dir", name: "apps" },
        { type: "dir", name: "folder with spaces" },
        { type: "dir", name: ".git" },
        { type: "symlink", name: "linked" },
        {
          type: "file",
          name: "submodule",
          submodule_git_url: "https://example.com/private",
        },
        { type: "file", name: "Dockerfile" },
      ];
    else if (url.pathname === "/repos/acme/web/contents/apps")
      body = [{ type: "dir", name: "web" }];
    else if (url.pathname === "/repos/acme/web/contents/file")
      body = { type: "file", name: "file", content: "private file contents" };
    else if (url.pathname === "/repos/acme/web/contents/apps/web")
      body = [{ type: "file", name: "package.json" }];
    else if (url.pathname === "/repos/acme/web/contents/apps/web/package.json")
      body = {
        dependencies:
          url.searchParams.get("ref") === newer
            ? { next: "latest", react: "latest" }
            : { "@tanstack/react-start": "latest", react: "latest" },
      };
    else if (url.pathname === "/app/installations/99")
      body = {
        app_id: 10,
        suspended_at: null,
        account: { login: "acme", avatar_url: avatarUrl },
      };
    else if (url.pathname.includes("/app-manifests/"))
      body = { id: 10, slug: "ephor-example", pem, webhook_secret: secret };
    else return new Response("{}", { status: 404 });
    return Response.json(body);
  }) as typeof fetch;
  const github = new GitHubApp(
      f.sql,
      f.env.secret,
      "https://ephor.acme.org",
      request,
    ),
    services = new Services(f.sql, f.env.secret),
    builds = new Builds(f.sql, f.env.secret, github);
  await github.integrations.set("github", {
    id: 10,
    slug: "ephor-example",
    pem,
    webhookSecret: secret,
  });
  await f.sql.query(
    "INSERT INTO ephor_github_installation (id,account) VALUES ('99','acme')",
  );
  const machineStore = new MachineStore(f.sql);
  async function machine() {
    const ticket = await machineStore.create("machine");
    await machineStore.enroll(ticket.token, randomToken());
    await f.sql.query("UPDATE ephor_machine SET telemetry=$1 WHERE id=$2", [
      JSON.stringify({ arch: "x86_64", ipAddresses: ["203.0.113.5"] }),
      ticket.id,
    ]);
    const token = await services.issueWorker(ticket.id);
    await services.enroll(token, randomToken());
    await services.heartbeat(ticket.id, 2);
    return ticket.id;
  }
  const machineId = await machine();
  const source = await github.source({
    type: "github",
    installationId: "99",
    repositoryId: "123",
    branch: "main",
    buildType: "auto",
  });
  const config = {
    image: "ephor.local/pending:latest",
    environment: { RUNTIME_SECRET: "do-not-send-to-builder" },
  };
  const service = await services.create(
    {
      machineId,
      name: "web",
      domain: "acme.org",
      spec: config,
      domains: {
        primary: "acme.org",
        aliases: ["www.acme.org"],
        redirect: true,
      },
    },
    source,
  );
  return {
    ...f,
    github,
    services,
    builds,
    machine,
    machineId,
    serviceId: service.id,
    source,
    requests,
    setHead: (s: string) => {
      head = s;
    },
    setAvatar: (url: string, bytes: string) => {
      avatarUrl = url;
      avatarBytes = bytes;
    },
  };
}
test("linked GitHub scopes use a fresh avatar from GitHub without forwarding credentials", async () => {
  const f = await setup();
  const first = await f.github.avatar("99");
  expect(first?.headers.get("Content-Type")).toBe("image/png");
  expect(first?.headers.get("Cache-Control")).toBe("no-store");
  expect(await first?.text()).toBe("first avatar");
  expect(f.requests.at(-1)).toMatchObject({
    origin: "https://avatars.githubusercontent.com",
    authenticated: false,
    avatarSize: "64",
  });
  // GitHub can change the picture without changing the avatar URL.
  f.setAvatar(
    "https://avatars.githubusercontent.com/u/456?v=4",
    "updated avatar",
  );
  expect(await (await f.github.avatar("99"))?.text()).toBe("updated avatar");
  const count = f.requests.length;
  expect(await f.github.avatar("100")).toBeNull();
  expect(f.requests).toHaveLength(count);
});

test("unavailable avatars fall back instead of loading images from an unrelated host", async () => {
  const f = await setup();
  f.setAvatar("https://example.com/avatar.png", "unavailable");
  expect(await f.github.avatar("99")).toBeNull();
  expect(f.requests.at(-1)?.origin).toBe("https://api.github.com");
});

test("repository picker receives the last push date and excludes archived repositories", async () => {
  const f = await setup();
  expect(await f.github.repositories("99", 1)).toEqual({
    repositories: [
      {
        id: "123",
        name: "acme/web",
        branch: "main",
        private: true,
        pushedAt: "2026-11-16T12:00:00Z",
      },
    ],
    more: false,
  });
});

test("service technology follows the selected folder and build commit", async () => {
  const f = await setup();
  const source = await f.github.source({
    ...f.source,
    context: "apps/web",
  });
  expect(source.technology).toBe("tanstack");
  await f.services.configure(
    f.serviceId,
    { spec: { image: "ephor.local/pending:latest" } },
    source,
  );
  f.setHead(newer);
  const build = await f.builds.queue(f.serviceId);
  expect((await f.builds.next(f.machineId))?.id).toBe(build?.id);
  expect((await f.services.list(f.serviceId))[0]?.source.technology).toBe(
    "next",
  );
  expect(f.requests.at(-1)).toMatchObject({
    path: "/repos/acme/web/contents/apps/web/package.json",
    ref: newer,
  });
});

test("repository builds keep linked database secrets away from builders and require a compatible deploy worker", async () => {
  const f = await setup();
  const db = catalogConfig("postgres");
  const source = await f.services.create(
    { machineId: f.machineId, name: "postgres", spec: db.config },
    db.source,
  );
  const variables = new ServiceVariables(f.sql, f.env.secret);
  await variables.update(f.serviceId, {
    revision: (await variables.list(f.serviceId)).revision,
    set: { DATABASE_URL: referenceValue(source.id, "DATABASE_URL") },
  });
  await expect(f.builds.queue(f.serviceId)).rejects.toThrow(
    "CONNECTION_WORKER_REQUIRED",
  );
  await f.services.heartbeat(f.machineId, 5);
  const build = await f.builds.queue(f.serviceId);
  const builder = await f.builds.next(f.machineId);
  expect(JSON.stringify(builder)).not.toContain(
    db.config.environment.DB_PASSWORD as string,
  );
  expect(JSON.stringify(builder)).not.toContain("DATABASE_URL");
  await f.builds.report(f.machineId, {
    id: build?.id,
    digest: `ephor.local/${f.serviceId}@sha256:${"c".repeat(64)}`,
  });
  expect(await f.services.next(f.machineId, 4)).toBeNull();
  const deployment = await f.services.next(f.machineId, 5);
  expect(deployment?.spec.connections).toEqual([
    { serviceId: source.id, template: "postgres" },
  ]);
  expect(deployment?.spec.environment.DATABASE_URL).toContain(
    db.config.environment.DB_PASSWORD as string,
  );
});

test("GitHub App setup uses one-use expiring state, encrypted PKCS1 keys, and read-only permissions", async () => {
  const f = await setup();
  await f.github.disconnect();
  const flow = await f.github.start();
  expect(flow.manifest?.redirect_url).toBe(
    "https://ephor.acme.org/settings/integrations?github=register",
  );
  expect(flow.manifest?.setup_url).toBe(
    "https://ephor.acme.org/settings/integrations?github=install",
  );
  expect(flow.manifest?.default_permissions).toEqual({
    contents: "read",
    metadata: "read",
  });
  await expect(
    f.github.finish({ kind: "register", state: "0".repeat(64), code: "abc" }),
  ).rejects.toThrow("GITHUB_STATE_EXPIRED");
  const installed = await f.github.finish({
    kind: "register",
    state: flow.state,
    code: "abc",
  });
  expect("url" in installed).toBe(true);
  await expect(
    f.github.finish({ kind: "register", state: flow.state, code: "abc" }),
  ).rejects.toThrow();
  await f.github.finish({
    kind: "install",
    state: "state" in installed ? installed.state : "",
    installationId: "99",
  });
  expect((await f.github.status()).installations).toHaveLength(1);
  expect(await f.github.token("99", "123")).toBe("ghs_ephemeral-token");
  expect(f.requests.at(-1)?.body).toEqual({
    permissions: { contents: "read", metadata: "read" },
    repository_ids: [123],
  });
  await expect(f.github.token("98", "123")).rejects.toThrow(
    "GITHUB_INSTALLATION_UNAVAILABLE",
  );
  expect(
    JSON.stringify(await f.sql.query("SELECT * FROM ephor_integration")),
  ).not.toContain("PRIVATE KEY");
  expect(JSON.stringify(await f.github.status())).not.toContain(secret);
});
test("webhooks authenticate the exact raw payload with HMAC before accepting pushes", async () => {
  const f = await setup(),
    raw = JSON.stringify({
      repository: { id: 123 },
      installation: { id: 99 },
      ref: "refs/heads/main",
      after: sha,
    });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature =
    "sha256=" +
    Array.from(
      new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  await f.github.verifyWebhook(raw, signature);
  await expect(f.github.verifyWebhook(`${raw} `, signature)).rejects.toThrow(
    "INVALID_WEBHOOK",
  );
  await expect(f.github.verifyWebhook(raw, "")).rejects.toThrow(
    "INVALID_WEBHOOK",
  );
  const response = await createApi(f.env).request(
    "/api/integrations/github/webhook",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        "x-github-delivery": crypto.randomUUID(),
      },
      body: raw,
    },
  );
  expect(response.status).toBe(401);
  expect(await f.builds.list()).toHaveLength(0);
  const delivery = crypto.randomUUID();
  const send = () =>
    createApi(f.env).request("/api/integrations/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": delivery,
        "x-github-event": "push",
      },
      body: raw,
    });
  // A signed webhook queues without outbound GitHub requests, and retries are idempotent.
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect(await f.builds.list()).toHaveLength(1);
  const job = await f.builds.next(f.machineId);
  expect(job?.sha).toBe(sha);
  expect(job?.repository).toBe("acme/web");
  await f.builds.webhook(
    "installation",
    { action: "deleted", installation: { id: 99 } },
    crypto.randomUUID(),
  );
  expect((await f.builds.progress(f.machineId, { id: job?.id })).active).toBe(
    false,
  );
  await expect(f.github.token("99", "123")).rejects.toThrow(
    "GITHUB_INSTALLATION_UNAVAILABLE",
  );
});
test("local builds snapshot secrets, expose only build variables, and deploy a verified immutable receipt", async () => {
  const f = await setup();
  await f.builds.setEnvironment(f.serviceId, {
    PUBLIC_URL: "https://acme.org",
    BUILD_SECRET: "build-only-value",
  });
  const build = await f.builds.queue(f.serviceId);
  expect(build).not.toBeNull();
  if (!build) throw new Error("missing build");
  await f.builds.setEnvironment(f.serviceId, {
    BUILD_SECRET: "changed-after-queue",
  });
  const job = await f.builds.next(f.machineId);
  expect(job?.variables.BUILD_SECRET).toBe("build-only-value");
  expect(JSON.stringify(job)).not.toContain("do-not-send-to-builder");
  expect(job?.sha).toBe(sha);
  expect(JSON.stringify(await f.builds.list())).not.toContain(
    "build-only-value",
  );
  await f.builds.progress(f.machineId, {
    id: build.id,
    phase: "building",
    logs: "build-only-value",
  });
  expect((await f.builds.list())[0]?.logs).toBe("[redacted]");
  await expect(
    f.builds.report(await f.machine(), {
      id: build.id,
      digest: `ephor.local/${f.serviceId}@sha256:${"c".repeat(64)}`,
    }),
  ).rejects.toThrow("BUILD_NOT_FOUND");
  await expect(
    f.builds.report(f.machineId, {
      id: build.id,
      digest: `docker.io/other/image@sha256:${"c".repeat(64)}`,
    }),
  ).rejects.toThrow("INVALID_BUILD_IMAGE");
  const digest = `ephor.local/${f.serviceId}@sha256:${"c".repeat(64)}`;
  await f.builds.report(f.machineId, { id: build.id, digest });
  await f.builds.report(f.machineId, { id: build.id, digest });
  expect(await f.services.history()).toHaveLength(1);
  const deployment = await f.services.next(f.machineId, 2);
  expect(deployment?.spec.image).toBe(digest);
  expect(deployment?.spec.environment.RUNTIME_SECRET).toBe(
    "do-not-send-to-builder",
  );
  expect(deployment?.domains).toEqual({
    primary: "acme.org",
    aliases: ["www.acme.org"],
    redirect: true,
  });
});
test("build progress preserves the authoritative deployment protocol", async () => {
  const f = await setup();
  await f.services.heartbeat(f.machineId, 8);
  const build = await f.builds.queue(f.serviceId);
  if (!build) throw new Error("missing build");
  await f.builds.next(f.machineId);
  await f.sql.query(
    "UPDATE ephor_service_worker SET last_seen=1 WHERE machine_id=$1",
    [f.machineId],
  );
  expect(
    await f.builds.progress(f.machineId, { id: build.id, phase: "building" }),
  ).toEqual({ active: true });
  const [worker] = await f.sql.query(
    "SELECT version,last_seen FROM ephor_service_worker WHERE machine_id=$1",
    [f.machineId],
  );
  expect(worker?.version).toBe("8");
  expect(Number(worker?.last_seen)).toBeGreaterThan(1);
  // Real capability changes must still take effect, including downgrades.
  await f.services.next(f.machineId, 5);
  const [downgraded] = await f.sql.query(
    "SELECT version FROM ephor_service_worker WHERE machine_id=$1",
    [f.machineId],
  );
  expect(downgraded?.version).toBe("5");
});
test("duplicate, obsolete, and cancelled builds cannot replace newer deployments", async () => {
  const f = await setup();
  const first = await f.builds.queue(f.serviceId, true, "delivery-one");
  if (!first) throw new Error("missing");
  expect(await f.builds.queue(f.serviceId, true, "delivery-one")).toEqual(
    first,
  );
  await f.builds.next(f.machineId);
  f.setHead(newer);
  const second = await f.builds.queue(f.serviceId, true, "delivery-two");
  if (!second) throw new Error("missing");
  await f.builds.report(f.machineId, {
    id: first.id,
    digest: `ephor.local/${f.serviceId}@sha256:${"c".repeat(64)}`,
  });
  expect(await f.services.history()).toHaveLength(0);
  expect((await f.builds.next(f.machineId))?.id).toBe(second.id);
  await f.builds.cancel(second.id);
  expect(
    await f.builds.progress(f.machineId, {
      id: second.id,
      phase: "building",
      logs: "",
    }),
  ).toEqual({ active: false });
  await f.builds.report(f.machineId, {
    id: second.id,
    digest: `ephor.local/${f.serviceId}@sha256:${"d".repeat(64)}`,
  });
  expect(await f.services.history()).toHaveLength(0);
});
test("remote builders receive push credentials while deployment receives only pull credentials", async () => {
  const f = await setup(),
    builder = await f.machine();
  const source = { ...f.source, buildMachineId: builder } as ServiceSource;
  await f.sql.query("UPDATE ephor_service SET source=$1 WHERE id=$2", [
    JSON.stringify({ ...source, architecture: "x86_64" }),
    f.serviceId,
  ]);
  await expect(f.builds.queue(f.serviceId)).rejects.toThrow(
    "BUILD_REGISTRY_REQUIRED",
  );
  await f.builds.registry({
    prefix: "ghcr.io/acme/ephor",
    push: { username: "writer", password: "push-only-secret" },
    pull: { username: "reader", password: "pull-only-secret" },
  });
  const job = await f.builds.queue(f.serviceId);
  if (!job) throw new Error("missing");
  expect(await f.builds.next(f.machineId)).toBeNull();
  const task = await f.builds.next(builder);
  expect(task?.registry?.password).toBe("push-only-secret");
  expect(JSON.stringify(task)).not.toContain("pull-only-secret");
  await f.builds.report(builder, {
    id: job.id,
    digest: `ghcr.io/acme/ephor/${f.serviceId}@sha256:${"c".repeat(64)}`,
  });
  const deployment = await f.services.next(f.machineId, 2);
  expect(deployment?.spec.registry?.password).toBe("pull-only-secret");
  expect(JSON.stringify(deployment)).not.toContain("push-only-secret");
});
test("domain reservations support apex, aliases, redirects, and reject collisions and SSRF-shaped names", async () => {
  const f = await setup();
  expect(
    serviceDomains({
      primary: "EXAMPLE.ORG",
      aliases: ["www.example.org"],
      redirect: true,
    }).primary,
  ).toBe("example.org");
  for (const name of [
    "https://example.org",
    "localhost",
    "127.0.0.1",
    "evil.com/route",
    "*.example.org",
    "x.internal",
  ])
    expect(() => serviceDomains({ primary: name })).toThrow();
  const other = await f.services.create(
    {
      machineId: f.machineId,
      name: "other",
      spec: { image: "docker.io/library/nginx:latest" },
    },
    { type: "image" },
  );
  await expect(
    reserveDomains(f.sql, other.id, { primary: "www.acme.org" }),
  ).rejects.toThrow("DOMAIN_IN_USE");
  const calls: string[] = [];
  const request = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json({
      Status: 0,
      Answer: [{ type: 1, data: "203.0.113.5" }],
    });
  }) as typeof fetch;
  expect(await dnsRecords("acme.org", request)).toHaveLength(2);
  expect(calls.every((c) => new URL(c).hostname === "cloudflare-dns.com")).toBe(
    true,
  );
});
test("GitHub mutations require the owner, fresh passkey, and same-origin JSON", async () => {
  const f = await enrolled();
  expect((await f.app.request("/api/integrations/github")).status).toBe(401);
  expect((await f.browser.request("/integrations/github")).status).toBe(200);
  expect(
    (
      await f.browser.request(
        "/integrations/github/start",
        {},
        { origin: "https://evil.org" },
      )
    ).status,
  ).toBe(403);
});

test("build settings remain editable and changing repository identity invalidates an old build", async () => {
  const f = await setup();
  await f.services.configure(f.serviceId, {
    spec: { image: "ephor.local/pending:latest" },
    buildSettings: {
      buildType: "dockerfile",
      context: "apps/web",
      buildMemoryMb: 2048,
      buildCpus: 2,
    },
  });
  const source = JSON.parse((await f.services.get(f.serviceId)).source);
  expect(source.repositoryId).toBe("123");
  expect(source.context).toBe("apps/web");
  const build = await f.builds.queue(f.serviceId);
  const job = await f.builds.next(f.machineId);
  expect(job?.buildMemoryMb).toBe(2048);
  await f.sql.query("UPDATE ephor_service SET source=$1 WHERE id=$2", [
    JSON.stringify({ ...source, branch: "release" }),
    f.serviceId,
  ]);
  await f.builds.report(f.machineId, {
    id: build?.id,
    digest: `ephor.local/${f.serviceId}@sha256:${"a".repeat(64)}`,
  });
  expect((await f.builds.list())[0]?.status).toBe("superseded");
  expect(await f.services.history()).toHaveLength(0);
});

test("older service workers cannot claim domain-aware deployment jobs", async () => {
  const f = await setup();
  await f.services.queue(f.serviceId, "stop");
  expect(await f.services.next(f.machineId, 1)).toBeNull();
  expect((await f.services.next(f.machineId, 2))?.action).toBe("stop");
});

test("out-of-order webhook delivery cannot discard the current branch head", async () => {
  const f = await setup();
  f.setHead(newer);
  const current = await f.builds.queue(
    f.serviceId,
    true,
    "current-push",
    newer,
  );
  await f.builds.queue(f.serviceId, true, "delayed-old-push", sha);
  // Equal-millisecond deliveries may claim the obsolete job first; the next poll advances.
  const job =
    (await f.builds.next(f.machineId)) ?? (await f.builds.next(f.machineId));
  expect(job?.id).toBe(current?.id);
  expect(job?.sha).toBe(newer);
  await f.builds.report(f.machineId, {
    id: job?.id,
    digest: `ephor.local/${f.serviceId}@sha256:${"c".repeat(64)}`,
  });
  expect(await f.services.history()).toHaveLength(1);
  expect(await f.builds.next(f.machineId)).toBeNull();
  expect((await f.services.history())[0]?.source_ref).toBe(newer);
});

test("directory browsing is scoped, commit-pinned, lazy and contains only safe directory metadata", async () => {
  const f = await setup();
  f.requests.length = 0;
  const root = await f.github.directory("99", "123", "main");
  expect(root.path).toBe(".");
  expect(root.hints).toEqual(["Dockerfile"]);
  expect(root.directories).toEqual([
    { name: "apps", path: "apps", selectable: true },
    {
      name: "folder with spaces",
      path: "folder with spaces",
      selectable: false,
    },
  ]);
  expect(f.requests.filter((r) => r.path.includes("/contents"))).toHaveLength(
    1,
  );
  expect(f.requests.at(-1)?.ref).toBe(sha);
  expect(JSON.stringify(root)).not.toContain("ghs_");
  f.setHead(newer);
  const nested = await f.github.directory("99", "123", "main", "apps/web");
  expect(nested.commit).toBe(newer);
  expect(nested.hints).toEqual(["Node.js"]);
  expect(nested.directories).toEqual([]);
  expect(
    (await f.github.directory("99", "123", "main", "./apps/web/")).path,
  ).toBe("apps/web");
  for (const path of ["../secret", "/etc", "apps/.git", "apps/../web"])
    await expect(f.github.directory("99", "123", "main", path)).rejects.toThrow(
      "INVALID_BUILD_PATH",
    );
  for (const path of ["missing", "file"])
    await expect(f.github.directory("99", "123", "main", path)).rejects.toThrow(
      "GITHUB_DIRECTORY_NOT_FOUND",
    );
  await expect(f.github.directory("100", "123", "main")).rejects.toThrow(
    "GITHUB_INSTALLATION_UNAVAILABLE",
  );
  await expect(
    f.github.source({
      type: "github",
      installationId: "99",
      repositoryId: "123",
      branch: "main",
      context: "missing",
    }),
  ).rejects.toThrow("GITHUB_DIRECTORY_NOT_FOUND");
  expect(
    (
      await f.app.request(
        "/api/integrations/github/directories?installation=99&repository=123&branch=main",
      )
    ).status,
  ).toBe(401);
});

test("directory browsing rejects oversized listings and does not follow redirects with credentials", async () => {
  const f = await setup();
  for (const response of [
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
    new Response(null, {
      status: 302,
      headers: { Location: "https://other.example/" },
    }),
  ]) {
    const client = new GitHubApp(f.sql, f.env.secret, f.env.origin, (async (
      input,
      init,
    ) => {
      if (String(input).includes("/contents")) {
        expect(init?.redirect).toBe("manual");
        return response;
      }
      return f.github.request(input, init);
    }) as typeof fetch);
    await expect(client.directory("99", "123", "main")).rejects.toThrow();
  }
});

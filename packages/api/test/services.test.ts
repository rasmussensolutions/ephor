import { expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { createApi } from "../src";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { ServiceSecrets } from "../src/services/crypto";
import { githubIdentity, workflow } from "../src/services/github";
import { serviceInstaller } from "../src/services/installer";
import { domainName, type ServiceSource, spec } from "../src/services/spec";
import { Services } from "../src/services/store";
import { enrolled, fixture, timestamp } from "./helpers";

const config = {
  image: "docker.io/library/example:latest",
  port: 3000,
  healthPath: "/health",
  memoryMb: 256,
  cpus: 0.5,
  environment: { API_SECRET: "a-sensitive-value" },
  registry: {
    server: "docker.io",
    username: "reader",
    password: "registry-secret",
  },
};
const source = { type: "image" as const };
async function setup() {
  const f = await fixture(),
    machines = new MachineStore(f.sql),
    services = new Services(f.sql, f.env.secret);
  const ticket = await machines.create("vps"),
    monitor = randomToken();
  await machines.enroll(ticket.token, monitor);
  const enrollment = await services.issueWorker(ticket.id),
    worker = randomToken();
  await services.enroll(enrollment, worker);
  await services.next(ticket.id, 2);
  const service = await services.create(
    { machineId: ticket.id, name: "app", domain: "app.acme.org", spec: config },
    source,
  );
  return {
    ...f,
    machines,
    services,
    machineId: ticket.id,
    monitor,
    worker,
    serviceId: service.id,
  };
}
function agent(
  app: ReturnType<typeof createApi>,
  action: string,
  token: string,
  body: unknown,
) {
  return app.request(`/api/agent/services/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

test("service settings and immutable deployment snapshots encrypt secrets with record binding", async () => {
  const f = await setup();
  const queued = await f.services.queue(f.serviceId, "deploy");
  const rows = await f.sql.query("SELECT config FROM ephor_service"),
    jobs = await f.sql.query("SELECT spec FROM ephor_deployment");
  expect(
    JSON.stringify([
      rows,
      jobs,
      await f.services.list(),
      await f.services.history(),
    ]),
  ).not.toContain("a-sensitive-value");
  expect(
    JSON.stringify([
      rows,
      jobs,
      await f.services.list(),
      await f.services.history(),
    ]),
  ).not.toContain("registry-secret");
  const secrets = new ServiceSecrets(f.env.secret);
  await expect(
    secrets.open(queued.id, String(rows[0]?.config)),
  ).rejects.toThrow();
  await f.services.configure(f.serviceId, {
    spec: { ...config, environment: { API_SECRET: "new-value" } },
    autoDeploy: false,
  });
  expect(
    (await f.services.next(f.machineId, 2))?.spec.environment.API_SECRET,
  ).toBe("a-sensitive-value");
});
test("deployment worker credentials cannot act as monitor or owner credentials, and are revoked with the machine", async () => {
  const f = await setup();
  expect((await agent(f.app, "next", f.monitor, { protocol: 2 })).status).toBe(
    401,
  );
  expect((await agent(f.app, "next", f.worker, { protocol: 2 })).status).toBe(
    200,
  );
  expect(
    (
      await f.app.request("/api/services", {
        headers: { authorization: `Bearer ${f.worker}` },
      })
    ).status,
  ).toBe(401);
  await f.machines.revoke(f.machineId);
  expect((await agent(f.app, "next", f.worker, { protocol: 2 })).status).toBe(
    401,
  );
});
test("one-use worker enrollment cannot be stolen or reused with another credential", async () => {
  const f = await setup(),
    token = await f.services.issueWorker(f.machineId);
  await expect(f.services.enroll(token, randomToken())).rejects.toThrow();
  const ticket = await f.machines.create("fresh"),
    monitor = randomToken();
  await f.machines.enroll(ticket.token, monitor);
  const grant = await f.services.issueWorker(ticket.id),
    credential = randomToken();
  const results = await Promise.allSettled([
    f.services.enroll(grant, credential),
    f.services.enroll(grant, randomToken()),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await f.services.enroll(grant, credential);
  await f.sql.query(
    "UPDATE ephor_service_worker SET enrollment_expires=0 WHERE machine_id=$1",
    [ticket.id],
  );
  await expect(f.services.enroll(grant, credential)).rejects.toThrow();
});
test("serializes deployments across services on one machine; duplicate receipts do not reopen jobs", async () => {
  const f = await setup();
  const other = await f.services.create(
    { machineId: f.machineId, name: "other", spec: config },
    source,
  );
  const jobs = await Promise.allSettled([
    f.services.queue(f.serviceId, "deploy"),
    f.services.queue(f.serviceId, "deploy"),
  ]);
  expect(jobs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await f.services.queue(other.id, "deploy");
  const next = await f.services.next(f.machineId, 2);
  expect(next).not.toBeNull();
  expect((await f.services.next(f.machineId, 2))?.id).toBe(next?.id);
  const digest = `docker.io/library/example@sha256:${"a".repeat(64)}`;
  await f.services.report(f.machineId, {
    id: next?.id,
    status: "succeeded",
    digest,
  });
  await f.services.report(f.machineId, {
    id: next?.id,
    status: "succeeded",
    digest,
  });
  await expect(
    f.services.report(f.machineId, { id: next?.id, status: "failed" }),
  ).rejects.toThrow();
  expect((await f.services.next(f.machineId, 2))?.id).not.toBe(next?.id);
});
test("worker cannot read or report another machine's deployment or logs", async () => {
  const f = await setup();
  const other = await f.machines.create("other");
  await f.machines.enroll(other.token, randomToken());
  await f.services.queue(f.serviceId, "deploy");
  const job = await f.services.next(f.machineId, 2);
  await expect(
    f.services.report(other.id, { id: job?.id, status: "failed" }),
  ).rejects.toThrow();
  await expect(
    f.services.runtime(other.id, {
      id: f.serviceId,
      status: "running",
      logs: "hello",
      container: "ephor-example",
    }),
  ).rejects.toThrow();
  expect(await f.services.next(other.id, 1)).toBeNull();
});
test("failed deploy retains current revision and rollback pins the original digest and environment", async () => {
  const f = await setup(),
    first = await f.services.queue(f.serviceId, "deploy");
  await f.services.next(f.machineId, 2);
  const digest = `docker.io/library/example@sha256:${"b".repeat(64)}`;
  await f.services.report(f.machineId, {
    id: first.id,
    status: "succeeded",
    digest,
  });
  await f.services.configure(f.serviceId, {
    spec: { ...config, environment: { API_SECRET: "changed" } },
    autoDeploy: false,
  });
  const failed = await f.services.queue(f.serviceId, "deploy");
  await f.services.next(f.machineId, 2);
  await f.services.report(f.machineId, {
    id: failed.id,
    status: "failed",
    error: "secret must not be logged",
  });
  expect((await f.services.get(f.serviceId)).current_deployment).toBe(first.id);
  await f.services.queue(f.serviceId, "rollback", { deploymentId: first.id });
  const job = await f.services.next(f.machineId, 2);
  expect(job?.spec.image).toBe(digest);
  expect(job?.spec.environment.API_SECRET).toBe("a-sensitive-value");
  expect(JSON.stringify(await f.services.history())).not.toContain(
    "secret must not be logged",
  );
});
test("domain reservations, limits, runtime log redaction, and queued cancellation", async () => {
  const f = await setup();
  await expect(
    f.services.create(
      {
        machineId: f.machineId,
        name: "other",
        domain: "app.acme.org",
        spec: config,
      },
      source,
    ),
  ).rejects.toThrow();
  await f.services.runtime(f.machineId, {
    id: f.serviceId,
    status: "running",
    logs: "a-sensitive-value registry-secret",
    container: "ephor-example",
  });
  expect((await f.services.list())[0]?.runtime?.logs).toBe(
    "[redacted] [redacted]",
  );
  const job = await f.services.queue(f.serviceId, "deploy");
  await f.services.cancel(job.id);
  expect(await f.services.next(f.machineId, 2)).toBeNull();
  const next = await f.services.queue(f.serviceId, "deploy");
  await f.services.next(f.machineId, 2);
  await expect(f.services.cancel(next.id)).rejects.toThrow();
});
test("owner mutations require fresh passkey and exact origin", async () => {
  const f = await enrolled();
  const body = {
    machineId: crypto.randomUUID(),
    name: "app",
    spec: config,
    source,
  };
  expect(
    (
      await f.app.request("/api/services/create", {
        method: "POST",
        headers: { origin: f.env.origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.browser.request("/services/create", body, {
        origin: "https://evil.test",
      })
    ).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect((await f.browser.request("/services/create", body)).status).toBe(403);
});
test("rejects command injection, host paths, domain wildcards, unsafe resource limits", () => {
  for (const image of [
    "--privileged",
    "docker.io/app:1;id",
    "file:///etc/passwd",
    "https://example.com/app",
    "example",
    "docker.io/app:tag\n--volume=/etc:/etc",
  ]) {
    expect(() => spec({ ...config, image })).toThrow();
  }
  for (const domain of [
    "*.example.com",
    "localhost",
    "127.0.0.1",
    "example.com:80",
    "example.com\nfoo",
    "https://example.com",
  ]) {
    expect(() => domainName(domain)).toThrow();
  }
  for (const patch of [
    { port: 80 },
    { memoryMb: 1 },
    { cpus: 100 },
    { healthPath: "/../../etc/passwd?" },
    { environment: { BAD: "\0" } },
  ])
    expect(() => spec({ ...config, ...patch })).toThrow();
  expect(
    spec({ ...config, privileged: true, volumes: ["/:/host"] }),
  ).not.toHaveProperty("privileged");
});
test("GitHub deployment verifies signature and binds repository identity, branch, workflow and audience", async () => {
  const key = await generateKeyPair("RS256"),
    jwk = await exportJWK(key.publicKey);
  jwk.kid = "test";
  const keys = createLocalJWKSet({ keys: [jwk] }),
    id = crypto.randomUUID();
  const source: ServiceSource = {
    type: "github",
    repository: "acme/app",
    repositoryId: "12",
    ownerId: "34",
    branch: "main",
    dockerfile: "Dockerfile",
    context: ".",
  };
  const claims = {
    repository_id: "12",
    repository_owner_id: "34",
    repository: "acme/app",
    ref: "refs/heads/main",
    workflow_ref: `acme/app/.github/workflows/ephor-${id}.yml@refs/heads/main`,
    event_name: "push",
    runner_environment: "github-hosted",
    sha: "a".repeat(40),
    run_id: "123",
    run_number: "10",
  };
  const token = async (patch: Record<string, unknown> = {}) =>
    new SignJWT({ ...claims, ...patch })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience(`ephor:${id}`)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key.privateKey);
  expect((await githubIdentity(await token(), id, source, keys)).sha).toBe(
    claims.sha,
  );
  for (const patch of [
    { repository_id: "999" },
    { repository_owner_id: "99" },
    { ref: "refs/heads/fork" },
    { event_name: "pull_request" },
    { workflow_ref: "other.yml" },
    { runner_environment: "self-hosted" },
  ])
    await expect(
      githubIdentity(await token(patch), id, source, keys),
    ).rejects.toThrow();
  await expect(
    githubIdentity(await token(), crypto.randomUUID(), source, keys),
  ).rejects.toThrow();
  const yaml = workflow(id, source, "https://panel.acme.org");
  expect(yaml).not.toContain("pull_request");
  expect(yaml).toContain("id-token: write");
  expect(yaml).toContain("persist-credentials: false");
});
test("service installer validates architecture digests and keeps Docker access in separate worker", async () => {
  const script = serviceInstaller("https://panel.acme.org", {
    serviceProtocol: 2,
    x86_64: "a".repeat(64),
  });
  const child = Bun.spawn(["sh", "-n"], {
    stdin: new Blob([script]),
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(script).toContain("sha256sum --check");
  expect(script).not.toContain("usermod");
  expect(script).toContain("/usr/local/libexec/ephor-services");
});

test("GitHub deliveries are idempotent and older runs never deploy after a newer accepted run", async () => {
  const f = await setup();
  await f.sql.query("UPDATE ephor_service SET auto_deploy=1 WHERE id=$1", [
    f.serviceId,
  ]);
  const options = {
    delivery: `github:${f.serviceId}:100`,
    run: 10,
    sha: "a".repeat(40),
    image: config.image,
  };
  const queued = await f.services.queue(f.serviceId, "deploy", options);
  expect((await f.services.queue(f.serviceId, "deploy", options)).id).toBe(
    queued.id,
  );
  await f.services.next(f.machineId, 2);
  await f.services.report(f.machineId, { id: queued.id, status: "failed" });
  await expect(
    f.services.queue(f.serviceId, "deploy", {
      ...options,
      delivery: "older",
      run: 9,
    }),
  ).rejects.toThrow();
  const newer = await f.services.queue(f.serviceId, "deploy", {
    ...options,
    delivery: "newer",
    run: 11,
  });
  expect(newer.id).not.toBe(queued.id);
  await f.services.cancel(newer.id);
  await f.sql.query("UPDATE ephor_service SET auto_deploy=0 WHERE id=$1", [
    f.serviceId,
  ]);
  await expect(
    f.services.queue(f.serviceId, "deploy", {
      ...options,
      delivery: "paused",
      run: 12,
    }),
  ).rejects.toThrow();
});

test("owner create/configure/deploy flows through authenticated HTTP worker polling and receipts", async () => {
  const f = await enrolled(),
    machines = new MachineStore(f.sql),
    services = new Services(f.sql, f.env.secret);
  const machine = await machines.create("api-test");
  await machines.enroll(machine.token, randomToken());
  const token = await services.issueWorker(machine.id),
    worker = randomToken();
  expect(
    (await agent(f.app, "enroll", token, { credential: worker })).status,
  ).toBe(200);
  expect(
    (await agent(f.app, "heartbeat", worker, { protocol: 2 })).status,
  ).toBe(200);
  const created = await f.browser.request("/services/create", {
    machineId: machine.id,
    name: "HTTP app",
    domain: "api.acme.org",
    spec: config,
    source,
  });
  expect(created.status).toBe(200);
  const { id } = await created.json();
  expect(
    (
      await f.browser.request(`/services/${id}/configure`, {
        spec: { ...config, environment: { SECRET: "updated-secret" } },
        autoDeploy: false,
      })
    ).status,
  ).toBe(200);
  const deploy = await f.browser.request(`/services/${id}/action`, {
    action: "deploy",
  });
  expect(deploy.status).toBe(200);
  const response = await agent(f.app, "next", worker, { protocol: 2 });
  const { job } = await response.json();
  expect(job.serviceId).toBe(id);
  expect(job.spec.environment.SECRET).toBe("updated-secret");
  expect(
    (
      await agent(f.app, "report", worker, {
        id: job.id,
        status: "succeeded",
        digest: `docker.io/library/example@sha256:${"c".repeat(64)}`,
      })
    ).status,
  ).toBe(200);
  const list = await f.browser.request("/services");
  const body = await list.json();
  expect(body.services[0].currentDeployment).toBe(job.id);
  expect(body.deployments[0].status).toBe("succeeded");
  expect(JSON.stringify(body)).not.toContain("updated-secret");
  const detail = await f.browser.request(`/services/${id}`);
  expect(detail.status).toBe(200);
  const detailBody = await detail.json();
  expect(detailBody.services.map((s: { id: string }) => s.id)).toEqual([id]);
  expect(
    detailBody.deployments.every(
      (d: { service_id: string }) => d.service_id === id,
    ),
  ).toBe(true);
  expect(JSON.stringify(detailBody)).not.toContain("updated-secret");
  expect(
    (await f.browser.request(`/services/${crypto.randomUUID()}`)).status,
  ).toBe(404);
  const history = await f.browser.request(`/services/${id}/metrics?range=24h`);
  expect(history.status).toBe(200);
  expect((await history.json()).points.length).toBeLessThanOrEqual(289);
  expect(
    (await f.browser.request(`/services/${id}/metrics?range=__proto__`)).status,
  ).toBe(400);
});

test("service metrics validate ownership and bounds, accept older workers, and protect history", async () => {
  const f = await setup();
  const metrics = {
    cpuPercent: 12.5,
    memoryBytes: 123456,
    memoryLimitBytes: 268435456,
    networkRxBytesPerSecond: 250,
    networkTxBytesPerSecond: null,
    uptimeSeconds: 75,
    processes: 4,
    restarts: 0,
  };
  const payload = {
    id: f.serviceId,
    status: "running",
    container: "ephor-example",
    logs: "hello",
    metrics,
  };
  expect((await agent(f.app, "runtime", f.worker, payload)).status).toBe(200);
  expect((await f.services.list())[0]?.runtime?.metrics).toEqual(metrics);
  expect((await f.services.list(undefined, true))[0]?.runtime?.logs).toBe("");
  expect((await f.sql.query("SELECT * FROM ephor_service_metric")).length).toBe(
    1,
  );
  for (const invalid of [
    { ...metrics, cpuPercent: 101 },
    { ...metrics, memoryBytes: -1 },
    { ...metrics, processes: 1.5 },
    { ...metrics, networkRxBytesPerSecond: "10" },
  ]) {
    expect(
      (
        await agent(f.app, "runtime", f.worker, {
          ...payload,
          metrics: invalid,
        })
      ).status,
    ).toBe(400);
  }
  const other = await f.machines.create("other-metrics");
  await f.machines.enroll(other.token, randomToken());
  await expect(f.services.runtime(other.id, payload)).rejects.toThrow();
  for (const path of [
    `/api/services/${f.serviceId}`,
    `/api/services/${f.serviceId}/metrics`,
  ])
    expect((await f.app.request(path)).status).toBe(401);
  await f.services.runtime(f.machineId, { ...payload, metrics: undefined });
  expect((await f.services.list())[0]?.runtime?.metrics).toBeNull();
});

test("metric history is bounded, survives reloads, prunes after 24h, and preserves missing samples", async () => {
  const { recordMetrics, metricsHistory, METRIC_RETENTION } = await import(
    "../src/services/metrics"
  );
  const f = await setup();
  const now = Math.floor(Date.now() / 300000) * 300000;
  const metric = {
    cpuPercent: 10,
    memoryBytes: 1000,
    memoryLimitBytes: 2000,
    networkRxBytesPerSecond: 4,
    networkTxBytesPerSecond: 8,
    uptimeSeconds: 60,
    processes: 2,
    restarts: 0,
  };
  await recordMetrics(
    f.sql,
    f.serviceId,
    metric,
    now - METRIC_RETENTION - 60000,
  );
  await recordMetrics(f.sql, f.serviceId, metric, now - 120000);
  await recordMetrics(
    f.sql,
    f.serviceId,
    { ...metric, cpuPercent: 20 },
    now - 119000,
  );
  await recordMetrics(f.sql, f.serviceId, metric, now);
  const rows = await f.sql.query("SELECT * FROM ephor_service_metric");
  expect(rows.length).toBe(2);
  const history = await metricsHistory(f.sql, f.serviceId, "15m", now);
  expect(
    history.points.find((p) => p.timestamp === now - 120000)?.cpuPercent,
  ).toBe(20);
  expect(
    history.points.find((p) => p.timestamp === now - 60000)?.cpuPercent,
  ).toBeNull();
  expect(history.points.at(-1)?.memoryBytes).toBe(1000);
  expect(
    (await metricsHistory(f.sql, f.serviceId, "24h", now)).points.length,
  ).toBeLessThanOrEqual(289);
  for (const range of ["forever", "__proto__", "constructor"])
    await expect(
      metricsHistory(f.sql, f.serviceId, range, now),
    ).rejects.toThrow();
  await metricsHistory(f.sql, f.serviceId, "24h", now + METRIC_RETENTION + 1);
  expect((await f.sql.query("SELECT * FROM ephor_service_metric")).length).toBe(
    0,
  );
});

test("machine enrollment bootstraps an independent worker only after the machine connects", async () => {
  const f = await fixture();
  const machines = new MachineStore(f.sql);
  const services = new Services(f.sql, f.env.secret);
  const ticket = await machines.create("Combined enrollment");
  const monitor = randomToken(),
    worker = randomToken();
  await expect(services.enroll(ticket.workerToken, worker)).rejects.toThrow(
    "INVALID_WORKER_ENROLLMENT",
  );
  await machines.enroll(ticket.token, monitor);
  await expect(services.enroll(ticket.token, worker)).rejects.toThrow(
    "INVALID_WORKER_ENROLLMENT",
  );
  await expect(services.enroll(monitor, worker)).rejects.toThrow(
    "INVALID_WORKER_ENROLLMENT",
  );
  expect(await services.enroll(ticket.workerToken, worker)).toEqual({
    id: ticket.id,
  });
  expect(await services.enroll(ticket.workerToken, worker)).toEqual({
    id: ticket.id,
  });
  await expect(
    services.enroll(ticket.workerToken, randomToken()),
  ).rejects.toThrow("INVALID_WORKER_ENROLLMENT");
  await expect(machines.identity(worker)).rejects.toThrow(
    "INVALID_MACHINE_CREDENTIAL",
  );
  await expect(services.identity(monitor)).rejects.toThrow(
    "INVALID_WORKER_CREDENTIAL",
  );
  await services.heartbeat(ticket.id, 4);
  expect((await machines.get(ticket.id)).deploymentWorker?.version).toBe(4);
  await machines.revoke(ticket.id);
  await expect(services.identity(worker)).rejects.toThrow(
    "INVALID_WORKER_CREDENTIAL",
  );
});

test("regenerated, cancelled and expired machine enrollment invalidates the deployment grant", async () => {
  const f = await fixture();
  const machines = new MachineStore(f.sql);
  const services = new Services(f.sql, f.env.secret);
  const stale = await machines.create("Regenerated");
  const ticket = await machines.regenerateEnrollment(stale.id);
  await machines.enroll(ticket.token, randomToken());
  await expect(
    services.enroll(stale.workerToken, randomToken()),
  ).rejects.toThrow("INVALID_WORKER_ENROLLMENT");
  expect(await services.enroll(ticket.workerToken, randomToken())).toEqual({
    id: ticket.id,
  });
  const cancelled = await machines.create("Cancelled");
  await machines.cancelEnrollment(cancelled.id);
  await expect(
    services.enroll(cancelled.workerToken, randomToken()),
  ).rejects.toThrow("INVALID_WORKER_ENROLLMENT");
  const expired = await machines.create("Expired");
  await machines.enroll(expired.token, randomToken());
  await f.sql.query(
    "UPDATE ephor_machine SET enrollment_expires=0 WHERE id=$1",
    [expired.id],
  );
  await expect(
    services.enroll(expired.workerToken, randomToken()),
  ).rejects.toThrow("INVALID_WORKER_ENROLLMENT");
});

test("owner repair supersedes the initial deployment enrollment grant", async () => {
  const f = await fixture();
  const machines = new MachineStore(f.sql);
  const services = new Services(f.sql, f.env.secret);
  const ticket = await machines.create("Repair");
  await machines.enroll(ticket.token, randomToken());
  const repair = await services.issueWorker(ticket.id);
  await expect(
    services.enroll(ticket.workerToken, randomToken()),
  ).rejects.toThrow("INVALID_WORKER_ENROLLMENT");
  const worker = randomToken();
  expect(await services.enroll(repair, worker)).toEqual({ id: ticket.id });
});

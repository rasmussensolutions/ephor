import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { deployment, saveDeployment } from "../src/security/deployment";
import { Browser, enrolled, fixture, timestamp } from "./helpers";

const details = {
  provider: "Hetzner",
  ingress: "cloudflare-tunnel",
  frontend: "separate",
  machineId: null,
  revision: 0,
};
test("deployment runtime comes from the host adapter, not a hostname or proxy declaration", async () => {
  const f = await fixture();
  expect((await deployment(f.env)).runtime).toBe("unknown");
  f.env.deployment = { runtime: "node", frontend: "unknown" };
  const saved = await saveDeployment(f.env, details, "Owner");
  expect(saved.runtime).toBe("node");
  expect(saved.configured.ingress).toBe("cloudflare-tunnel");
  expect(saved.database).toBe("PostgreSQL");
  f.env.deployment = { runtime: "cloudflare-worker", frontend: "same-runtime" };
  const worker = await deployment(f.env);
  expect(worker.runtime).toBe("cloudflare-worker");
  expect(worker.database).toBe("D1");
  expect(worker.frontendDetected).toBe("same-runtime");
  expect(JSON.stringify(worker)).not.toContain(f.env.secret);
  await expect(
    saveDeployment(
      f.env,
      { ...details, runtime: "node", revision: 1 },
      "Owner",
    ),
  ).rejects.toThrow("INVALID_DEPLOYMENT_METADATA");
  await expect(
    saveDeployment(
      f.env,
      { ...details, machineId: crypto.randomUUID(), revision: 1 },
      "Owner",
    ),
  ).rejects.toThrow("WORKER_HAS_NO_HOST_MACHINE");
});
test("metadata validates active host links, rejects stale edits and records an audit event", async () => {
  const f = await fixture(),
    store = new MachineStore(f.sql);
  const m = await store.create("Panel host");
  await store.enroll(m.token, randomToken());
  const result = await saveDeployment(
    f.env,
    { ...details, machineId: m.id },
    "Owner",
  );
  expect(result.revision).toBe(1);
  expect(result.configured.machineId).toBe(m.id);
  await expect(saveDeployment(f.env, details, "Owner")).rejects.toThrow(
    "DEPLOYMENT_METADATA_CHANGED",
  );
  await expect(
    saveDeployment(
      f.env,
      { ...details, revision: 1, machineId: crypto.randomUUID() },
      "Owner",
    ),
  ).rejects.toThrow("DEPLOYMENT_METADATA_CHANGED");
  await expect(
    saveDeployment(
      f.env,
      {
        ...details,
        revision: 1,
        provider: "https://user:password@example.com",
      },
      "Owner",
    ),
  ).rejects.toThrow("INVALID_DEPLOYMENT_METADATA");
  expect(
    (
      await f.sql.query(
        "SELECT actor FROM ephor_security_event WHERE action='security.deployment.updated'",
      )
    )[0]?.actor,
  ).toBe("Owner");
});
test("deployment metadata requires authenticated reads and fresh passkey writes with CSRF protection", async () => {
  const f = await enrolled();
  expect(
    (await new Browser(f.app).request("/security/deployment")).status,
  ).toBe(401);
  expect((await f.browser.request("/security/deployment")).status).toBe(200);
  expect(
    (
      await f.browser.request("/security/deployment", details, {
        origin: "https://evil.invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.browser.request("/security/deployment", details)).status,
  ).toBe(200);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - 600000),
  ]);
  expect(
    (
      await f.browser.request("/security/deployment", {
        ...details,
        revision: 1,
      })
    ).status,
  ).toBe(403);
});

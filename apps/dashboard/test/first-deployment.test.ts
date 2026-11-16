import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  firstDeploymentProgress,
  needsFirstDeployment,
} from "../src/lib/first-deployment";
import type { Deployment, Service, ServiceList } from "../src/lib/services";

function fixture() {
  const service: Service = {
    id: "app",
    machineId: "machine",
    name: "App",
    domain: null,
    spec: {
      image: "nginx",
      port: 80,
      healthPath: "/",
      memoryMb: 256,
      cpus: 1,
      environment: [],
      registry: null,
    },
    source: { type: "image" },
    autoDeploy: false,
    currentDeployment: null,
    runtime: null,
    runtimeAt: 0,
  };
  const data: ServiceList = {
    services: [service],
    builds: [],
    deployments: [],
    workers: [],
  };
  return { service, data };
}
function deployment(
  status: string,
  overrides: Partial<Deployment> = {},
): Deployment {
  return {
    id: "attempt",
    service_id: "app",
    action: "deploy",
    status,
    created_at: 2000,
    updated_at: 3000,
    error: null,
    digest: null,
    source_ref: null,
    ...overrides,
  };
}
function build(
  status: string,
  phase = "building",
): ServiceList["builds"][number] {
  return {
    id: "attempt",
    service_id: "app",
    status,
    phase,
    logs: "Build output",
    error: null,
    created_at: 1000,
    updated_at: 2000,
  };
}

test("new and failed services get first deployment; established services do not", () => {
  const { service, data } = fixture();
  assert.equal(needsFirstDeployment(service, data), true);
  service.runtime = {
    status: "running",
    container: "app",
    logs: "",
    metrics: null,
  };
  assert.equal(
    needsFirstDeployment(service, data),
    true,
    "startup telemetry is not a successful deployment receipt",
  );
  data.deployments = [deployment("failed")];
  assert.equal(needsFirstDeployment(service, data), true);
  data.deployments.push(deployment("succeeded", { service_id: "other" }));
  assert.equal(needsFirstDeployment(service, data), true);
  data.deployments.push(deployment("succeeded", { id: "earlier" }));
  assert.equal(needsFirstDeployment(service, data), false);
  data.deployments = [];
  service.currentDeployment = "older-than-retained-history";
  assert.equal(needsFirstDeployment(service, data), false);
});

test("repository promotion is starting, not successful, and retains build output", () => {
  const { service, data } = fixture();
  data.builds = [build("running", "fetching")];
  assert.equal(firstDeploymentProgress(service, data).stage, 0);
  data.builds = [build("running")];
  assert.equal(firstDeploymentProgress(service, data).stage, 1);
  data.builds = [build("deployed", "ready")];
  data.deployments = [deployment("queued")];
  const starting = firstDeploymentProgress(service, data);
  assert.equal(starting.stage, 2);
  assert.equal(starting.succeeded, false);
  assert.equal(starting.active, true);
  assert.equal(starting.build?.logs, "Build output");
  assert.equal(starting.startedAt, 1000);
  data.deployments = [deployment("succeeded")];
  const ready = firstDeploymentProgress(service, data);
  assert.equal(ready.stage, 3);
  assert.equal(ready.succeeded, true);
  assert.equal(ready.active, false);
  assert.equal(ready.finishedAt, 3000);
});

test("a retry does not inherit a previous attempt's failure or logs", () => {
  const { service, data } = fixture();
  data.builds = [{ ...build("failed"), error: "BUILD_FAILED" }];
  assert.equal(firstDeploymentProgress(service, data).failed, true);
  data.builds.push({
    ...build("queued", "queued"),
    id: "retry",
    created_at: 4000,
    logs: "",
  });
  data.deployments = [deployment("failed", { error: "DEPLOYMENT_FAILED" })];
  const retry = firstDeploymentProgress(service, data);
  assert.equal(retry.id, "retry");
  assert.equal(retry.failed, false);
  assert.equal(retry.error, null);
  assert.equal(retry.deployment, undefined);
  assert.equal(retry.build?.logs, "");
  assert.equal(retry.active, true);
});

test("image deployments, missing jobs, and cancellations have truthful states", () => {
  const { service, data } = fixture();
  assert.equal(firstDeploymentProgress(service, data).active, false);
  data.deployments = [deployment("queued")];
  assert.equal(firstDeploymentProgress(service, data).stage, 0);
  data.deployments = [deployment("running")];
  assert.equal(firstDeploymentProgress(service, data).stage, 2);
  data.deployments = [deployment("failed", { error: "HEALTH_CHECK_FAILED" })];
  assert.equal(
    firstDeploymentProgress(service, data).error,
    "HEALTH_CHECK_FAILED",
  );
  data.deployments = [];
  for (const status of ["cancelled", "superseded"]) {
    data.builds = [build(status)];
    const stopped = firstDeploymentProgress(service, data);
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.active, false);
    assert.equal(stopped.succeeded, false);
  }
});

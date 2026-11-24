import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type Service,
  type ServiceList,
  serviceStatus,
} from "../src/lib/services";

function fixture(status: string, elapsed = 5000, runtimeOffset = -1000) {
  const completedAt = Date.now() - elapsed;
  const service: Service = {
    id: "app",
    machineId: "machine",
    name: "Uptime Kuma",
    domain: null,
    spec: {
      image: "example",
      port: 3001,
      healthPath: "/",
      memoryMb: 384,
      cpus: 1,
      environment: [],
      registry: null,
    },
    source: { type: "catalog", template: "uptime-kuma" },
    autoDeploy: false,
    currentDeployment: null,
    runtimeAt: completedAt + runtimeOffset,
    runtime: {
      status: "stopped",
      container: "app-web",
      logs: "",
      metrics: null,
      catalog: {
        components: [],
        volumes: [],
        backups: [],
        port: 3001,
        recoveryRequired: true,
      },
    },
  };
  const data: ServiceList = {
    services: [service],
    workers: [],
    builds: [],
    deployments: [
      {
        id: "operation",
        service_id: service.id,
        status,
        action: "deploy",
        created_at: completedAt - 30000,
        updated_at: completedAt,
        digest: null,
        source_ref: null,
        error: status === "failed" ? "DEPLOYMENT_FAILED" : null,
      },
    ],
  };
  return { service, data };
}

test("a normal in-progress recovery marker is a deployment, not a failure", () => {
  for (const status of ["queued", "running"]) {
    const { service, data } = fixture(status);
    assert.equal(serviceStatus(service, data), "Deploying");
  }
});
test("success waits for telemetry, including an in-flight startup snapshot", () => {
  for (const offset of [-1000, 1000]) {
    const { service, data } = fixture("succeeded", 5000, offset);
    assert.equal(serviceStatus(service, data), "Updating status");
    assert.ok(service.runtime?.catalog);
    service.runtime.catalog.recoveryRequired = false;
    service.runtime.status = "running";
    assert.equal(serviceStatus(service, data), "Running");
  }
});
test("genuine failure and persistent recovery markers still need recovery", () => {
  for (const [status, elapsed] of [
    ["failed", 5000],
    ["succeeded", 90000],
  ] as const) {
    const { service, data } = fixture(status, elapsed, 1000);
    assert.equal(serviceStatus(service, data), "Recovery required");
  }
});
test("stale reports show unavailable and another service cannot hide recovery", () => {
  const { service, data } = fixture("failed", 180000);
  assert.equal(serviceStatus(service, data), "Unavailable");
  service.runtimeAt = Date.now();
  const failed = data.deployments[0];
  assert.ok(failed);
  data.deployments.unshift({
    ...failed,
    id: "other",
    service_id: "other",
    status: "succeeded",
    updated_at: Date.now(),
  });
  assert.equal(serviceStatus(service, data), "Recovery required");
});

test("a cached healthy report stays healthy while the resumed tab refreshes", () => {
  const { service, data } = fixture("succeeded", 300000, 1000);
  assert.ok(service.runtime);
  service.runtime.status = "running";
  delete service.runtime.catalog;
  service.observedAt = service.runtimeAt + 5000;
  assert.equal(serviceStatus(service, data), "Running");
  service.observedAt = Date.now();
  assert.equal(serviceStatus(service, data), "Unavailable");
});

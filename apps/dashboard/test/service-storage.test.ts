import { expect, test } from "bun:test";
import {
  componentHeight,
  componentLayout,
  mapLayout,
  serviceCardHeight,
} from "../src/lib/service-map";
import { mapConnector } from "../src/lib/service-map-connector";
import {
  serviceStorage,
  storageFooterHeight,
} from "../src/lib/service-storage";
import type { Service } from "../src/lib/services";

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
const now = Date.now();
const generation = "bb9c5a44-4157-4ea7-abcd-3ab6a43bd552";
const service: Service = {
  id: "app",
  machineId: "machine",
  name: "App",
  domain: null,
  source: { type: "image" },
  autoDeploy: false,
  currentDeployment: "deployment",
  spec: {
    image: "app",
    port: 3000,
    healthPath: "/",
    memoryMb: 512,
    cpus: 1,
    environment: [],
    registry: null,
    volumes: [{ name: "data", mountPath: "/data" }],
  },
  runtimeAt: now,
  runtime: {
    status: "running",
    container: "app",
    logs: "",
    metrics: null,
    catalog: {
      components: [{ name: "web", status: "running", image: "app" }],
      volumes: [
        {
          component: "web",
          target: "/data",
          name: `ephor-data-app-${generation}-data`,
        },
      ],
      backups: [],
      port: 3000,
      recoveryRequired: false,
    },
  },
};

test("configured named storage matches restored generations and never reports a renamed volume as mounted", () => {
  expect(serviceStorage(service, undefined, now)[0]).toMatchObject({
    name: "data",
    target: "/data",
    status: "Mounted",
  });
  const renamed = {
    ...service,
    spec: {
      ...service.spec,
      volumes: [{ name: "new-data", mountPath: "/data" }],
    },
  };
  expect(serviceStorage(renamed, undefined, now)[0]?.status).toBe(
    "Needs deployment",
  );
  const suffix = structuredClone(service);
  if (suffix.runtime?.catalog)
    required(suffix.runtime.catalog.volumes[0]).name =
      `ephor-data-app-${generation}-other-data`;
  expect(serviceStorage(suffix, undefined, now)[0]?.status).toBe(
    "Needs deployment",
  );
  expect(
    serviceStorage({ ...service, spec: { ...service.spec, volumes: [] } }),
  ).toEqual([]);
});

test("new, stale, missing, and stopped reports keep storage status honest", () => {
  expect(
    serviceStorage({ ...service, currentDeployment: null }, undefined, now)[0]
      ?.status,
  ).toBe("Needs deployment");
  expect(serviceStorage(service, undefined, now + 120001)[0]?.status).toBe(
    "Awaiting report",
  );
  expect(
    serviceStorage({ ...service, runtime: null }, undefined, now)[0]?.status,
  ).toBe("Awaiting report");
  const stopped = structuredClone(service);
  if (stopped.runtime?.catalog)
    required(stopped.runtime.catalog.components[0]).status = "stopped";
  expect(serviceStorage(stopped, undefined, now)[0]?.status).toBe("Attached");
});

const template: Service = {
  ...service,
  spec: { ...service.spec, volumes: undefined },
  topology: {
    primary: "web",
    web: true,
    dependencies: [],
    components: ["web", "database", "cache", "worker"].map((name) => ({
      name,
      image: name,
      port: 3000,
      internal: name !== "web",
      memoryMb: 256,
      cpus: 0.5,
      volumes: name === "database" ? ["/data", "/archive"] : [],
    })),
  },
};

test("template storage stays on the owning component even when siblings share mount paths", () => {
  const volumes = serviceStorage(template, "database", now);
  expect(volumes).toHaveLength(2);
  expect(volumes.every((v) => v.status === "Needs deployment")).toBe(true);
  expect(serviceStorage(template, "web", now)).toEqual([]);
  const reported = structuredClone(template);
  if (reported.runtime?.catalog) {
    reported.runtime.catalog.components.push({
      name: "database",
      image: "postgres",
      status: "running",
    });
    reported.runtime.catalog.volumes.push({
      component: "database",
      target: "/data",
      name: `ephor-data-app-${generation}-database`,
    });
  }
  expect(serviceStorage(reported, "database", now)[0]).toMatchObject({
    name: "database",
    status: "Mounted",
  });
});

test("storage footers fit bounds, row spacing, and connector endpoints with stable multi-volume heights", () => {
  const plain = { ...service, spec: { ...service.spec, volumes: [] } };
  expect(
    required(mapLayout([service]).nodes[0]).height -
      required(mapLayout([plain]).nodes[0]).height,
  ).toBe(40);
  const multiple = {
    ...service,
    spec: {
      ...service.spec,
      volumes: [
        ...required(service.spec.volumes),
        { name: "archive", mountPath: "/archive" },
      ],
    },
  };
  expect(required(mapLayout([multiple]).nodes[0]).height).toBe(
    required(mapLayout([service]).nodes[0]).height,
  );
  const layout = componentLayout(template);
  const group = required(mapLayout([template]).nodes[0]);
  const leftPadding = 25 + layout.leftInset;
  const rightPadding = group.width - (25 + layout.width);
  expect(rightPadding).toBe(leftPadding);
  const databaseHeight = serviceCardHeight + storageFooterHeight;
  expect(componentHeight(template, "database")).toBe(databaseHeight);
  expect(componentHeight(template, "web")).toBe(serviceCardHeight);
  expect(required(layout.positions.cache).y).toBeGreaterThan(
    required(layout.positions.database).y + databaseHeight,
  );
  for (const c of layout.components)
    expect(
      required(layout.positions[c.name]).y + componentHeight(template, c.name),
    ).toBeLessThanOrEqual(layout.height);
  const from = {
    ...required(layout.positions.database),
    height: componentHeight(template, "database"),
  };
  expect(mapConnector(from, { x: from.x, y: from.y + 400 })?.path).toStartWith(
    `M ${from.x + 132} ${from.y + databaseHeight}`,
  );
  const nodes = mapLayout([
    template,
    service,
    multiple,
    plain,
    template,
    service,
  ]).nodes;
  for (const a of nodes)
    for (const b of nodes) {
      if (a === b) continue;
      expect(
        a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y,
      ).toBe(false);
    }
});

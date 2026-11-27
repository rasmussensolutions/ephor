import { expect, test } from "bun:test";
import {
  groupGridOffset,
  mapGridSize,
  snapMapPoint,
} from "../src/lib/map-grid";
import {
  componentLabel,
  componentMetrics,
  componentStatus,
  mapLayout,
  primaryComponent,
  primaryHasDomains,
  projectMapLayout,
} from "../src/lib/service-map";
import type { Service } from "../src/lib/services";

const now = Date.now();
const service: Service = {
  id: "app",
  name: "Analytics",
  machineId: "machine",
  domain: null,
  spec: {
    image: "umami",
    port: 3000,
    healthPath: "/",
    memoryMb: 512,
    cpus: 1,
    environment: [],
    registry: null,
  },
  source: { type: "catalog", template: "umami" },
  autoDeploy: false,
  currentDeployment: null,
  runtimeAt: now,
  topology: {
    primary: "web",
    web: true,
    components: ["database", "web"].map((name) => ({
      name,
      image: name,
      port: 3000,
      internal: name === "database",
      memoryMb: 256,
      cpus: 0.5,
      volumes: [],
    })),
    dependencies: [
      { from: "web", to: "database", variables: ["DATABASE_URL"] },
    ],
  },
  runtime: {
    status: "running",
    container: "app",
    logs: "",
    metrics: null,
    catalog: {
      components: [
        {
          name: "web",
          image: "umami",
          status: "running",
          metrics: {
            cpuPercent: 5,
            memoryBytes: 1024,
            memoryLimitBytes: 2048,
            networkRxBytesPerSecond: null,
            networkTxBytesPerSecond: null,
            uptimeSeconds: 20,
            processes: 2,
            restarts: 0,
          },
        },
        { name: "database", image: "postgres", status: "stopped" },
      ],
      volumes: [],
      backups: [],
      port: 3000,
      recoveryRequired: false,
    },
  },
};
test("component health and metrics never fall back to app totals or a sibling", () => {
  expect(componentStatus(service, "web", now)).toBe("Running");
  expect(componentStatus(service, "database", now)).toBe("Stopped");
  expect(componentStatus(service, "missing", now)).toBe("Awaiting report");
  expect(componentMetrics(service, "web", now)?.memoryBytes).toBe(1024);
  expect(componentMetrics(service, "database", now)).toBeNull();
  expect(componentStatus(service, "web", now + 120001)).toBe("Unavailable");
  expect(componentMetrics(service, "web", now + 120001)).toBeNull();
});
test("mixed app groups and ordinary services stay within map bounds without overlap", () => {
  const services = Array.from({ length: 13 }, (_, i) => ({
    ...service,
    id: String(i),
    topology: i % 3 ? service.topology : undefined,
  }));
  {
    const layout = mapLayout(services);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
      for (const other of layout.nodes) {
        if (node === other) continue;
        const overlap =
          node.x < other.x + other.width &&
          node.x + node.width > other.x &&
          node.y < other.y + other.height &&
          node.y + node.height > other.y;
        expect(overlap).toBe(false);
      }
    }
  }
  const standalone = {
    ...service,
    topology: service.topology && {
      ...service.topology,
      components: service.topology.components.slice(-1),
      dependencies: [],
    },
  };
  const node = mapLayout([standalone]).nodes[0];
  expect(node?.grouped).toBe(false);
  expect(node?.width).toBe(264);
  expect(mapLayout([service]).nodes[0]?.grouped).toBe(true);
});

test("the declared primary wins over display order and domains belong only to web apps", () => {
  const topology = service.topology;
  if (!topology) throw new Error("Missing fixture topology");
  const reordered = {
    ...service,
    topology: { ...topology, components: [...topology.components].reverse() },
  };
  expect(primaryComponent(reordered)?.name).toBe("web");
  expect(primaryHasDomains(reordered)).toBe(true);
  const database = {
    ...service,
    topology: { ...topology, primary: "database", web: false },
  };
  expect(primaryComponent(database)?.name).toBe("database");
  expect(primaryHasDomains(database)).toBe(false);
  expect(
    componentLabel({
      name: "database",
      image: "docker.io/library/postgres:17",
    }),
  ).toBe("PostgreSQL");
  expect(
    componentLabel({ name: "database", image: "docker.io/library/mariadb:11" }),
  ).toBe("MariaDB");
  expect(
    componentLabel({ name: "queue", image: "example/custom:latest" }),
  ).toBe("queue");
  expect(primaryComponent({ ...service, topology: undefined })).toBeUndefined();
});

test("saved root and child positions grow map bounds without moving unrelated cards", () => {
  const original = mapLayout([service, { ...service, id: "other" }]);
  const moved = {
    ...service,
    presentation: {
      groupName: "Analytics",
      groupColor: "neutral" as const,
      componentNames: {},
      positions: {
        "": { x: 1000, y: 800 },
        web: { x: 400, y: 500 },
        database: { x: 0, y: 0 },
      },
    },
  };
  const layout = mapLayout([moved, { ...service, id: "other" }]);
  expect(layout.nodes[0]?.x).toBe(1008);
  expect(layout.nodes[0]?.y).toBe(792);
  expect(layout.nodes[0]?.width).toBe(744);
  expect(layout.nodes[0]?.height).toBe(747);
  expect(layout.width).toBeGreaterThanOrEqual(1712);
  expect(layout.height).toBeGreaterThanOrEqual(1603);
  expect(layout.nodes[1]?.x).toBe(original.nodes[1]?.x);
  expect(layout.nodes[1]?.y).toBe(original.nodes[1]?.y);
});

test("root and grouped card origins snap to the same shared grid within bounds", () => {
  for (const offset of [{ x: 0, y: 0 }, groupGridOffset]) {
    for (const value of [-100, 0, 11, 12, 64, 344, 1000, 20000, 30000]) {
      const point = snapMapPoint(value, value, offset);
      expect((point.x + offset.x) % mapGridSize).toBe(0);
      expect((point.y + offset.y) % mapGridSize).toBe(0);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(20000);
      expect(point.y).toBeLessThanOrEqual(20000);
      expect(snapMapPoint(point.x, point.y, offset)).toEqual(point);
    }
  }
});

test("project canvas separates machines while retaining local coordinates and grid alignment", () => {
  const services = [
    service,
    { ...service, id: "second", machineId: "second-machine" },
  ];
  const layout = projectMapLayout(services, [
    { id: "machine", name: "First" },
    { id: "empty", name: "Empty" },
    { id: "second-machine", name: "Second" },
  ]);
  expect(layout.groups).toHaveLength(2);
  const [first, second] = layout.groups;
  if (!first || !second) throw new Error("Expected two machine groups");
  expect(second.x).toBeGreaterThan(first.x + first.width);
  for (const node of layout.nodes) {
    const group = layout.groups.find((g) => g.id === node.service.machineId);
    const local = mapLayout([node.service]).nodes[0];
    if (!group || !local)
      throw new Error("Expected machine group and local node");
    expect(node.x - group.x).toBe(local.x);
    expect(node.y - 48).toBe(local.y);
    expect(node.x % mapGridSize).toBe(0);
    expect(node.y % mapGridSize).toBe(0);
    expect(node.x + node.width).toBeLessThanOrEqual(group.x + group.width);
    expect(node.y + node.height).toBeLessThanOrEqual(group.height);
  }
});

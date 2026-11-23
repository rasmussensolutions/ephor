import { expect, test } from "bun:test";
import { mapGridSize } from "../src/lib/map-grid";
import type { PositionEdit } from "../src/lib/map-position-state";
import type { Project } from "../src/lib/projects";
import { mapLayout } from "../src/lib/service-map";
import { autoLayoutServices } from "../src/lib/service-map-auto-layout";
import type { Service } from "../src/lib/services";

function service(
  id: string,
  componentCount = 0,
  overrides: Partial<Service> = {},
): Service {
  return {
    id,
    name: id,
    machineId: "machine",
    domain: null,
    spec: {
      image: "app",
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
    runtime: null,
    runtimeAt: 0,
    topology: componentCount
      ? {
          primary: "component-0",
          web: true,
          dependencies: [],
          components: Array.from({ length: componentCount }, (_, index) => ({
            name: `component-${index}`,
            image: "app",
            port: 3000,
            internal: index > 0,
            memoryMb: 256,
            cpus: 0.5,
            volumes: [],
          })),
        }
      : undefined,
    ...overrides,
  };
}

function positioned(
  item: Service,
  positions: NonNullable<Service["presentation"]>["positions"],
): Service {
  return {
    ...item,
    presentation: {
      groupName: item.name,
      groupColor: "neutral",
      componentNames: {},
      ...item.presentation,
      positions,
    },
  };
}

function applyEdits(services: Service[], edits: PositionEdit[]) {
  return services.map((item) => {
    const edit = edits.find((edit) => edit.id === item.id);
    if (!edit) throw new Error(`Missing edit for ${item.id}`);
    return positioned(item, {
      ...item.presentation?.positions,
      "": edit.point,
    });
  });
}

type Rectangle = { x: number; y: number; width: number; height: number };

function expectSeparated(rectangles: Rectangle[], gap: number) {
  for (const [index, a] of rectangles.entries()) {
    for (const b of rectangles.slice(index + 1)) {
      expect(
        a.x + a.width + gap <= b.x ||
          b.x + b.width + gap <= a.x ||
          a.y + a.height + gap <= b.y ||
          b.y + b.height + gap <= a.y,
      ).toBe(true);
    }
  }
}

function bounds(rectangles: Rectangle[]): Rectangle {
  expect(rectangles.length).toBeGreaterThan(0);
  const x = Math.min(...rectangles.map((item) => item.x));
  const y = Math.min(...rectangles.map((item) => item.y));
  return {
    x,
    y,
    width: Math.max(...rectangles.map((item) => item.x + item.width)) - x,
    height: Math.max(...rectangles.map((item) => item.y + item.height)) - y,
  };
}

function layout(services: Service[], projects: Project[] = []) {
  const edits = autoLayoutServices(services, projects);
  expect(edits).toHaveLength(services.length);
  expect(new Set(edits.map((edit) => edit.id)).size).toBe(services.length);
  expect(edits.map((edit) => edit.id).sort()).toEqual(
    services.map((item) => item.id).sort(),
  );
  for (const edit of edits) {
    expect(edit.component).toBe("");
    for (const coordinate of [edit.point.x, edit.point.y]) {
      expect(Number.isFinite(coordinate)).toBe(true);
      expect(coordinate).toBeGreaterThanOrEqual(0);
      expect(coordinate).toBeLessThanOrEqual(20000);
      expect(coordinate % mapGridSize).toBe(0);
    }
  }
  return mapLayout(applyEdits(services, edits)).nodes;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("empty input and single ordinary, component, and grouped services", () => {
  expect(autoLayoutServices([])).toEqual([]);
  expect(
    autoLayoutServices([], [{ id: "empty", name: "Empty", serviceIds: [] }]),
  ).toEqual([]);
  for (const count of [0, 1, 4]) {
    const item = service("single", count);
    expect(autoLayoutServices([item])).toEqual([
      { id: "single", component: "", point: { x: 48, y: 48 } },
    ]);
    layout([item]);
  }
});

test("mixed cards use actual root dimensions and leave at least 72px between services", () => {
  const services = [
    positioned(service("a-stretched", 4), {
      "": { x: 18000, y: 19000 },
      "component-1": { x: 8400, y: 7200 },
      "component-2": { x: 240, y: 1700 },
    }),
    ...Array.from({ length: 17 }, (_, index) =>
      service(`service-${index}`, [0, 1, 2, 5][index % 4]),
    ),
  ];
  const nodes = layout(services);
  const stretched = nodes.find((node) => node.service.id === "a-stretched");
  expect(stretched?.width).toBeGreaterThan(8400);
  expect(stretched?.height).toBeGreaterThan(7200);
  expect(stretched?.width).toBeGreaterThan(stretched?.baseWidth ?? 0);
  expect(stretched?.height).toBeGreaterThan(stretched?.baseHeight ?? 0);
  expect(nodes.find((node) => node.service.id === "service-0")?.width).toBe(
    288,
  );
  expect(nodes.find((node) => node.service.id === "service-1")?.width).toBe(
    264,
  );
  expectSeparated(nodes, 72);
});

test("project bounding rectangles, including the unassigned block, have larger gaps", () => {
  const services = Array.from({ length: 25 }, (_, index) =>
    service(`service-${index}`, index % 5),
  );
  const projects: Project[] = [
    {
      id: "z",
      name: "Zulu",
      serviceIds: services.slice(0, 9).map((item) => item.id),
    },
    { id: "empty", name: "Empty", serviceIds: ["missing-service"] },
    {
      id: "a",
      name: "Alpha",
      serviceIds: services.slice(9, 16).map((item) => item.id),
    },
    {
      id: "b",
      name: "Beta",
      serviceIds: services.slice(16, 20).map((item) => item.id),
    },
  ];
  const nodes = layout(services, projects);
  const assigned = new Set(projects.flatMap((project) => project.serviceIds));
  const blocks = projects
    .filter((project) => project.id !== "empty")
    .map((project) =>
      bounds(
        nodes.filter((node) => project.serviceIds.includes(node.service.id)),
      ),
    );
  blocks.push(bounds(nodes.filter((node) => !assigned.has(node.service.id))));
  expect(blocks).toHaveLength(4);
  expectSeparated(nodes, 72);
  expectSeparated(blocks, 168);
  expect(autoLayoutServices(services, projects)).toEqual(
    autoLayoutServices(
      services,
      projects.filter((project) => project.id !== "empty"),
    ),
  );
});

test("huge moved children can extend beyond the origin bounds without overlapping other blocks", () => {
  const services = [
    positioned(service("a-huge", 2), {
      "component-1": { x: 20000, y: 20000, revision: 8 },
    }),
    service("b-peer"),
    service("c-other-project", 1),
    service("d-unassigned"),
  ];
  const projects: Project[] = [
    { id: "a", name: "Alpha", serviceIds: ["a-huge", "b-peer"] },
    { id: "b", name: "Beta", serviceIds: ["c-other-project"] },
  ];
  const nodes = layout(services, projects);
  const huge = nodes.find((node) => node.service.id === "a-huge");
  if (!huge) throw new Error("Missing huge group");
  expect(huge.width).toBeGreaterThan(20000);
  expect(huge.height).toBeGreaterThan(20000);
  expect(huge.x + huge.width).toBeGreaterThan(20000);
  expect(huge.y + huge.height).toBeGreaterThan(20000);
  expectSeparated(nodes, 72);
  expectSeparated(
    [
      bounds(
        nodes.filter((node) => ["a-huge", "b-peer"].includes(node.service.id)),
      ),
      bounds(nodes.filter((node) => node.service.id === "c-other-project")),
      bounds(nodes.filter((node) => node.service.id === "d-unassigned")),
    ],
    168,
  );
});

test("saved roots are ignored and services, children, presentations, and projects are not mutated", () => {
  const services = deepFreeze([
    positioned(service("group", 3), {
      "": { x: 19992, y: 18888, revision: 15 },
      "component-0": { x: 1500, y: 400, revision: 3 },
      "component-2": { x: 2500, y: 2200, revision: 7 },
    }),
    positioned(service("ordinary"), { "": { x: 8000, y: 9000 } }),
    service("standalone", 1),
  ]);
  const projects = deepFreeze([
    { id: "project", name: "Project", serviceIds: ["ordinary", "group"] },
  ]);
  const before = structuredClone({ services, projects });
  const edits = autoLayoutServices(services, projects);
  const changedRoots = services.map((item, index) =>
    positioned(item, {
      ...item.presentation?.positions,
      "": { x: index * 1234, y: index * 4321, revision: 900 },
    }),
  );
  expect(autoLayoutServices(changedRoots, projects)).toEqual(edits);
  expect({ services, projects }).toEqual(before);
  expect(edits.every((edit) => edit.component === "")).toBe(true);
});

test("project name/id and service name/id determine a canonical order independent of input order", () => {
  const services = [
    service("s-2", 2, { name: "Same" }),
    service("u-b", 0, { name: "Unassigned" }),
    service("s-3", 1, { name: "Zulu" }),
    service("s-1", 0, { name: "Same" }),
    service("s-5", 0, { name: "Alpha" }),
    service("u-a", 1, { name: "Unassigned" }),
    service("s-4", 2, { name: "Alpha" }),
  ];
  const projects: Project[] = [
    { id: "b", name: "Alpha", serviceIds: ["s-2", "s-1"] },
    { id: "c", name: "Zulu", serviceIds: ["s-5"] },
    { id: "a", name: "Alpha", serviceIds: ["s-3", "s-4"] },
  ];
  const expected = autoLayoutServices(services, projects);
  expect(expected.map((edit) => edit.id)).toEqual([
    "s-4",
    "s-3",
    "s-1",
    "s-2",
    "s-5",
    "u-a",
    "u-b",
  ]);
  for (let offset = 0; offset < services.length; offset++) {
    expect(
      autoLayoutServices(
        [...services.slice(offset), ...services.slice(0, offset)].reverse(),
        [...projects].reverse().map((project) => ({
          ...project,
          serviceIds: [...project.serviceIds].reverse(),
        })),
      ),
    ).toEqual(expected);
  }
});

test("conflicting project memberships are resolved deterministically without duplicate edits", () => {
  const services = [service("shared"), service("peer"), service("unassigned")];
  const projects: Project[] = [
    { id: "z", name: "Zulu", serviceIds: ["shared", "shared"] },
    { id: "a", name: "Alpha", serviceIds: ["shared", "peer"] },
  ];
  expect(autoLayoutServices(services, projects)).toEqual(
    autoLayoutServices([...services].reverse(), [...projects].reverse()),
  );
  expectSeparated(layout(services, projects), 72);
});

test("applying root edits is idempotent and preserves all component positions and dimensions", () => {
  const services = [
    positioned(service("group", 3), {
      "": { x: 17000, y: 13000, revision: 10 },
      "component-1": { x: 1900, y: 2400, revision: 5 },
    }),
    service("ordinary"),
    service("component", 1),
  ];
  const projects = [{ id: "project", name: "Project", serviceIds: ["group"] }];
  const first = autoLayoutServices(services, projects);
  const applied = applyEdits(services, first);
  expect(autoLayoutServices(applied, projects)).toEqual(first);
  expect(autoLayoutServices(applyEdits(applied, first), projects)).toEqual(
    first,
  );
  expect(applied[0]?.presentation?.positions?.["component-1"]).toEqual(
    services[0]?.presentation?.positions?.["component-1"],
  );
  expect(
    mapLayout(applied).nodes.map(({ width, height }) => ({ width, height })),
  ).toEqual(
    mapLayout(services).nodes.map(({ width, height }) => ({ width, height })),
  );
});

test("machines are independently laid out in local coordinates, even for shared projects", () => {
  const services = [
    service("z-unassigned", 0, { machineId: "z-machine" }),
    service("a-project", 2, { machineId: "a-machine" }),
    service("z-project", 1, { machineId: "z-machine" }),
    service("a-unassigned", 0, { machineId: "a-machine" }),
    service("z-peer", 0, { machineId: "z-machine" }),
  ];
  const projects: Project[] = [
    {
      id: "project",
      name: "Shared project",
      serviceIds: ["a-project", "z-project", "z-peer"],
    },
  ];
  const edits = autoLayoutServices(services, projects);
  const independent: PositionEdit[] = [];
  for (const machineId of ["a-machine", "z-machine"]) {
    const members = services.filter((item) => item.machineId === machineId);
    const local = autoLayoutServices(members, projects);
    expect(local[0]?.point).toEqual({ x: 48, y: 48 });
    expectSeparated(layout(members, projects), 72);
    independent.push(...local);
  }
  expect(edits).toEqual(independent);
  expect(autoLayoutServices([...services].reverse(), projects)).toEqual(edits);
});

test("ordinary cards form a compact near-square or landscape layout", () => {
  const services = Array.from({ length: 36 }, (_, index) =>
    service(`${index}`),
  );
  const rectangle = bounds(layout(services));
  expectSeparated(layout(services), 72);
  expect(rectangle.width / rectangle.height).toBeGreaterThanOrEqual(0.75);
  expect(rectangle.width / rectangle.height).toBeLessThanOrEqual(2);
});

test("large groups can use legal origins even when the overall extent exceeds 20000", () => {
  const services = Array.from({ length: 4 }, (_, index) =>
    positioned(service(`large-${index}`, 2), {
      "component-1": { x: 11000, y: 11000 },
    }),
  );
  const nodes = layout(services);
  expectSeparated(nodes, 72);
  const rectangle = bounds(nodes);
  expect(rectangle.width).toBeGreaterThan(20000);
  expect(rectangle.height).toBeGreaterThan(20000);
});

test("impossible group sizes throw a descriptive error instead of clamping into overlaps", () => {
  const services = ["first", "second"].map((id) =>
    positioned(service(id, 2), {
      "component-1": { x: 20000, y: 20000 },
    }),
  );
  expect(() => autoLayoutServices(services)).toThrow(
    /Cannot auto-layout.*machine.*0\.\.20000.*without overlaps/,
  );
  expect(() =>
    autoLayoutServices(services, [
      { id: "one", name: "One", serviceIds: ["first"] },
      { id: "two", name: "Two", serviceIds: ["second"] },
    ]),
  ).toThrow(/0\.\.20000/);
  expect(autoLayoutServices([services[0] as Service])).toHaveLength(1);
});

test("excess group volume is rejected without returning out-of-range origins", () => {
  const services = Array.from({ length: 9 }, (_, index) =>
    positioned(service(`large-${index}`, 2), {
      "component-1": { x: 11000, y: 11000 },
    }),
  );
  expect(() => autoLayoutServices(services)).toThrow(/no safe shelf layout/);
});

test("non-finite child geometry throws rather than emitting non-finite root coordinates", () => {
  const invalid = positioned(service("invalid-child", 2), {
    "component-1": { x: Number.NaN, y: 0 },
  });
  expect(() => autoLayoutServices([invalid])).toThrow(
    /invalid-child.*invalid root dimensions/,
  );
  // Root geometry does not participate in sizing or placement.
  layout([
    positioned(service("ignored-root", 2), {
      "": { x: Number.NaN, y: Number.POSITIVE_INFINITY },
    }),
  ]);
});

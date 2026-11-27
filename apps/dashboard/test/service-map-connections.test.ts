import { expect, test } from "bun:test";
import { mapLayout } from "../src/lib/service-map";
import {
  mapConnector,
  serviceMapConnections,
} from "../src/lib/service-map-connector";
import type { Service } from "../src/lib/services";

const app = {
  id: "app",
  machineId: "machine",
  name: "Next app",
  variableConnections: [{ serviceId: "database", variables: ["DATABASE_URL"] }],
  variablesPending: true,
} as Service;
const database = {
  id: "database",
  machineId: "machine",
  name: "Postgres",
} as Service;

test("saved references draw directed edges before deployment, using current names and positions", () => {
  const nodes = mapLayout([app, database]).nodes;
  const first = serviceMapConnections(nodes);
  expect(first).toHaveLength(1);
  expect(first[0]?.label).toBe(
    "Next app → Postgres · DATABASE_URL · Needs deployment",
  );
  const source = nodes[0],
    destination = nodes[1];
  if (!source || !destination) throw new Error("Missing nodes");
  expect(first[0]?.path).toStartWith(
    `M ${source.x + source.width} ${source.y + source.height / 2}`,
  );
  expect(first[0]?.arrow).toStartWith(
    `M ${destination.x} ${destination.y + destination.height / 2}`,
  );
  destination.y += 400;
  destination.service = { ...destination.service, name: "Renamed database" };
  const moved = serviceMapConnections(nodes);
  expect(moved[0]?.path).not.toBe(first[0]?.path);
  expect(moved[0]?.label).toContain("Renamed database");
  source.service = { ...source.service, variablesPending: false };
  expect(serviceMapConnections(nodes)[0]?.label).not.toContain(
    "Needs deployment",
  );
});

test("absent, removed, cross-machine and self links never create misleading map edges", () => {
  expect(serviceMapConnections(mapLayout([app]).nodes)).toEqual([]);
  expect(
    serviceMapConnections(
      mapLayout([{ ...app, variableConnections: [] }, database]).nodes,
    ),
  ).toEqual([]);
  expect(
    serviceMapConnections(
      mapLayout([app, { ...database, machineId: "other" }]).nodes,
    ),
  ).toEqual([]);
  expect(
    serviceMapConnections(
      mapLayout([
        {
          ...app,
          variableConnections: [{ serviceId: "app", variables: ["URL"] }],
        },
      ]).nodes,
    ),
  ).toEqual([]);
});

test("connectors meet differently sized card boundaries and omit overlapping cards", () => {
  const from = { x: 0, y: 0, width: 288, height: 210 };
  const to = { x: 400, y: 0, width: 264, height: 192 };
  expect(mapConnector(from, to)?.path).toStartWith("M 288 105");
  expect(mapConnector(from, to)?.arrow).toStartWith("M 400 96");
  expect(mapConnector(from, { ...to, x: 0, y: 400 })?.path).toStartWith(
    "M 144 210",
  );
  expect(mapConnector(from, { ...to, x: 0, y: 400 })?.arrow).toStartWith(
    "M 132 400",
  );
  expect(mapConnector(from, { ...to, x: 100, y: 10 })).toBeNull();
  // Default component connectors meet the midpoint of the compact card.
  expect(mapConnector({ x: 0, y: 0 }, { x: 344, y: 0 })?.path).toStartWith(
    "M 264 84",
  );
});

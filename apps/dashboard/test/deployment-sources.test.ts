import { expect, test } from "bun:test";
import {
  deploymentSearch,
  deploymentSources,
} from "../src/lib/deployment-sources";

test("deployment links retain their supported source, machine and project context", () => {
  for (const { mode } of deploymentSources) {
    expect(
      deploymentSearch({ source: mode, machineId: "m1", projectId: "p1" }),
    ).toEqual({ source: mode, machineId: "m1", projectId: "p1" });
  }
});

test("malformed deployment search parameters fall back to the default source", () => {
  expect(
    deploymentSearch({ source: "unknown", machineId: 42, projectId: "" }),
  ).toEqual({ source: undefined, machineId: undefined, projectId: undefined });
});

// Older bookmarks should still open templates with their deployment context.
test("database links resolve to templates without a separate source category", () => {
  expect(
    deploymentSearch({ source: "database", machineId: "m1", projectId: "p1" }),
  ).toEqual({ source: "catalog", machineId: "m1", projectId: "p1" });
  expect(deploymentSources.map(({ mode }) => mode)).toEqual([
    "github",
    "catalog",
    "image",
  ]);
});

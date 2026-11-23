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

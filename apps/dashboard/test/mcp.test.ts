import { expect, test } from "bun:test";
import { authorizationId, connectionName, readPolicy } from "../src/lib/mcp";

test("OAuth consent names the requesting client and starts with scoped read access", () => {
  expect(connectionName("ChatGPT")).toBe("ChatGPT");
  expect(connectionName("  Codex\n")).toBe("Codex");
  expect(connectionName("\u0000")).toBe("AI client");
  expect(connectionName("x".repeat(81))).toHaveLength(80);
  expect(readPolicy(["project"], ["machine"])).toEqual({
    projectIds: ["project"],
    machineIds: ["machine"],
    allProjects: false,
    allMachines: false,
    manage: false,
    logs: false,
    repositories: false,
    execution: "direct",
  });
});

test("login continuation accepts only opaque authorization IDs, never redirect URLs", () => {
  const id = "97c65b0f-f326-47d5-951e-1f00624a0e3d";
  expect(authorizationId(id)).toBe(id);
  for (const input of [
    undefined,
    [id],
    "https://evil.example",
    "//evil.example",
    `${id}&redirect=https://evil.example`,
    "../settings",
  ])
    expect(authorizationId(input)).toBeUndefined();
});

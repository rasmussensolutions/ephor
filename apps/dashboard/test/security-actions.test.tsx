import { expect, test } from "bun:test";
import type { SecurityAction } from "@ephor/api/security";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ActionSummary,
  actionNextStep,
  actionTitle,
} from "../src/components/security/security-actions";

const demo: SecurityAction = {
  target: "service:demo",
  machineId: "host",
  machineName: "Server",
  serviceId: "demo",
  serviceName: "Demo",
  stopped: false,
  count: 335,
  advisoryCount: 139,
  imageCount: 1,
  counts: { critical: 0, high: 61, medium: 149, low: 102, info: 23 },
  layers: { os: 313, language: 22, other: 0 },
  fixesAvailable: 85,
  noFixReported: 250,
  configurationCount: 0,
  lastSeen: 1,
  sampleFindingId: "finding",
};
test("maintenance summaries preserve instance counts, unique advisories and package attribution without claiming application ownership", () => {
  const html = renderToStaticMarkup(<ActionSummary action={demo} />);
  for (const value of [
    "335",
    "139",
    "313",
    "22",
    "85",
    "250",
    "OS package findings",
    "language package findings",
  ])
    expect(html).toContain(value);
  expect(html).not.toContain("application dependencies");
  expect(actionTitle(demo)).toBe("Review image updates");
  expect(actionNextStep(demo)).toContain("redeploy, then scan again");
});
test("unfixed advisories remain reviewable rather than being dismissed or advertised as patchable", () => {
  const unfixed = { ...demo, fixesAvailable: 0 };
  expect(actionTitle(unfixed)).toBe("Review package advisories");
  expect(actionNextStep(unfixed)).toContain(
    "No fixed package version was reported",
  );
  expect(actionNextStep(unfixed)).toContain(
    "exploitability has not been assessed",
  );
});

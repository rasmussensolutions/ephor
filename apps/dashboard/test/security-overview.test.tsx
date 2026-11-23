import { expect, test } from "bun:test";
import type { SecurityCheck, SecurityOverview } from "@ephor/api/security";
import { renderToStaticMarkup } from "react-dom/server";
import { SecurityOverviewContent } from "../src/components/security/security-overview";
import { overviewCoverage } from "../src/components/security/security-overview-model";

const now = Date.now();
const automatic: SecurityCheck = {
  key: "maintenance.automatic-updates",
  title: "Automatic package updates",
  category: "maintenance",
  status: "pass",
  severity: "medium",
  component: "",
  evidence: "Enabled",
  remediation: "Review policy",
};
export const overview: SecurityOverview = {
  machines: [
    {
      id: "host",
      name: "Production",
      state: "active",
      lastSeen: now,
      enabled: true,
      version: "0.1.0",
    },
  ],
  services: [
    {
      id: "app",
      name: "SaaS",
      machineId: "host",
      domain: "app.example.com",
      currentDeployment: "v1",
    },
  ],
  scans: [],
  counts: { critical: 0, high: 2, medium: 1, low: 0, info: 0 },
  maintenance: [
    {
      machineId: "host",
      observedAt: now,
      status: "completed",
      checks: [automatic],
    },
  ],
  retentionDays: 90,
  installerAvailable: true,
};
test("coverage does not count old or missing update checks as configured", () => {
  expect(overviewCoverage(overview, now).updatesConfigured).toBe(1);
  expect(
    overviewCoverage({ ...overview, maintenance: [] }, now).updatesUnknown,
  ).toBe(1);
  expect(overviewCoverage(overview, now + 3 * 3600000).updatesConfigured).toBe(
    0,
  );
  expect(
    overviewCoverage(
      {
        ...overview,
        maintenance: overview.maintenance.map((scan) => ({
          ...scan,
          status: "failed",
        })),
      },
      now,
    ).updatesConfigured,
  ).toBe(0);
  expect(
    overviewCoverage(
      {
        ...overview,
        machines: overview.machines.map((machine) => ({
          ...machine,
          enabled: false,
        })),
      },
      now,
    ).updatesConfigured,
  ).toBe(0);
});
test("overview distinguishes connection direction, unknown hosting and configured public exposure", () => {
  const html = renderToStaticMarkup(
    <SecurityOverviewContent
      data={overview}
      deployment={null}
      findings={{ items: [], nextCursor: null }}
      protections={{ machines: [], installerAvailable: true }}
      activity={{ items: [], nextCursor: null }}
      refreshDeployment={() => {}}
      onSection={() => {}}
      onFinding={() => {}}
    />,
  );
  for (const text of [
    "Security architecture",
    "Outbound HTTPS",
    "Jobs in response",
    "Login",
    "Public HTTPS",
    "Hosting unknown",
    "Automatic update recommendations",
    "bg-blue-500",
    "rounded-lg bg-card",
    "Tailscale is optional",
    "No active findings reported",
  ])
    expect(html).toContain(text);
  expect(html).toContain("Managed protections");
  expect(html).toContain("Install CrowdSec");
  expect(html).not.toContain("Trusted administrator IP addresses");
});
test("no configured domain means no assumed public traffic path", () => {
  const html = renderToStaticMarkup(
    <SecurityOverviewContent
      data={{ ...overview, services: [] }}
      deployment={null}
      findings={null}
      protections={null}
      activity={null}
      refreshDeployment={() => {}}
      onSection={() => {}}
      onFinding={() => {}}
    />,
  );
  expect(html).not.toContain("Public HTTPS*");
  expect(html).toContain("Status unavailable");
});

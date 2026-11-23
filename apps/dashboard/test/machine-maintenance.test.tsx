import { expect, test } from "bun:test";
import type { Machine, MachineList } from "@ephor/api/machines";
import { renderToStaticMarkup } from "react-dom/server";
import { MachineMaintenance } from "../src/components/machines/machine-maintenance";

const machine: Machine = {
  id: "host",
  name: "Production",
  providerOverride: null,
  deploymentWorker: null,
  status: "online",
  updaterKey: "a".repeat(64),
  updaterSeen: Date.now(),
  createdAt: 1,
  enrolledAt: 1,
  lastSeen: Date.now(),
  telemetry: {
    version: 1,
    hostname: "host",
    os: "Linux",
    arch: "x86_64",
    agentVersion: "0.1.0",
    cpuCount: 1,
    cpuPercent: 0,
    memoryTotal: 1024,
    memoryUsed: 1,
    uptime: 1,
    disks: [],
  },
  maintenance: {
    protocol: 3,
    components: (
      [
        "monitoring",
        "deployments",
        "security",
        "protections",
        "updater",
      ] as const
    ).map((id) => ({
      id,
      installed: id !== "protections",
      active: id !== "protections",
      version: id !== "protections" ? "0.1.0" : null,
      buildId: null,
    })),
  },
};
const releaseInfo: NonNullable<MachineList["releaseInfo"]> = {
  configured: true,
  checkedAt: Date.now(),
  error: null,
  publicKey: machine.updaterKey ?? undefined,
  maintenanceAvailable: true,
  release: {
    schema: 1,
    version: "0.2.0",
    buildId: "b".repeat(64),
    protocol: 1,
    updaterProtocol: 3,
    channel: "stable",
    expiresAt: Date.now() + 3600000,
    artifacts: {
      x86_64: {
        url: "https://example.com/ephord",
        sha256: "c".repeat(64),
        size: 100,
      },
    },
  },
};
function render(m = machine, r = releaseInfo) {
  return renderToStaticMarkup(
    <MachineMaintenance
      machine={m}
      releaseInfo={r}
      job={undefined}
      refresh={async () => {}}
    />,
  );
}
function button(html: string, label: string) {
  const b = html
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((b) => b.includes(label));
  if (!b) throw new Error("Missing button");
  return b;
}
test("one maintenance view shows every component, one update and explicit protection opt-in", () => {
  const html = render();
  for (const label of [
    "Monitoring",
    "Deployments &amp; backups",
    "Security collection",
    "Protection management",
    "Updater",
  ])
    expect(html).toContain(label);
  expect(html).toContain("Not installed");
  expect(button(html, "Update Ephor on this machine")).not.toContain(
    'disabled=""',
  );
  expect(html).toContain("Get setup or repair command");
  expect(html).not.toContain('checked=""');
});
test("legacy, offline, stale and downgrade states never expose an enabled whole-machine update", () => {
  for (const changed of [
    { ...machine, maintenance: { protocol: 1, components: [] } },
    { ...machine, status: "offline" as const },
    { ...machine, updaterSeen: 1 },
    {
      ...machine,
      maintenance: {
        protocol: 3,
        components:
          machine.maintenance?.components.map((c) => ({
            ...c,
            version: c.installed ? "1.0.0" : null,
          })) ?? [],
      },
    },
  ])
    expect(button(render(changed), "Update Ephor on this machine")).toContain(
      'disabled=""',
    );
  expect(
    button(
      render(machine, {
        ...releaseInfo,
        release: releaseInfo.release
          ? { ...releaseInfo.release, updaterProtocol: 1 }
          : undefined,
      }),
      "Update Ephor on this machine",
    ),
  ).toContain('disabled=""');
});

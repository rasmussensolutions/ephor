import { expect, test } from "bun:test";
import type { ProtectionMachine } from "@ephor/api/protections";
import { renderToStaticMarkup } from "react-dom/server";
import { MachineProtection } from "../src/components/security/security-protections";

const machine: ProtectionMachine = {
  id: "host",
  name: "Production",
  enabled: true,
  lastSeen: Date.now(),
  jobs: [],
  snapshot: {
    ownership: "managed",
    supported: true,
    version: "1.8.2",
    engineRunning: true,
    acquisitionReady: true,
    blocking: "enabled",
    confirmBefore: null,
    sshPorts: [22],
    trustedIPs: ["8.8.8.8"],
    revision: "a".repeat(64),
    detail: "",
    bans: [],
  },
};
const managedSnapshot = machine.snapshot;
if (!managedSnapshot) throw new Error("Missing test snapshot");
function render(m: ProtectionMachine) {
  return renderToStaticMarkup(
    <MachineProtection
      machine={m}
      installerAvailable={true}
      refresh={() => {}}
    />,
  );
}
test("stale management never presents cached enforcement as verified", () => {
  const html = render({ ...machine, lastSeen: Date.now() - 120000 });
  expect(html).toContain("Management offline");
  expect(html).toContain("Not currently verified");
  expect(html).not.toContain("Enabled · temporary entries");
  expect(html).not.toContain("Disable blocking</button>");
});
test("external CrowdSec has no takeover, install or firewall controls", () => {
  const html = render({
    ...machine,
    snapshot: { ...managedSnapshot, ownership: "external", blocking: "off" },
  });
  expect(html).toContain("Externally managed");
  expect(html).not.toContain("Review CrowdSec installation</button>");
  expect(html).not.toContain("Review SSH blocking trial</button>");
  expect(html).not.toContain("Uninstall</button>");
});
test("observation enrollment does not silently enable privileged management", () => {
  const html = render({
    ...machine,
    enabled: false,
    lastSeen: null,
    snapshot: null,
  });
  expect(html).toContain("Manage Ephor on this machine");
  expect(html).toContain("/machines/host#maintenance");
  expect(html).toContain("separate privileged management helper");
  expect(html).not.toContain("Review CrowdSec installation</button>");
});
test("blocking trial makes independent SSH confirmation and rollback deadline visible", () => {
  const html = render({
    ...machine,
    snapshot: {
      ...managedSnapshot,
      blocking: "pending",
      confirmBefore: Date.now() + 120000,
    },
  });
  expect(html).toContain("Open a new SSH connection now");
  expect(html).toContain("blocking automatically turns off");
  expect(html).toContain("Review confirmation");
});

test("managed protection card exposes focused install/manage dialogs without full controls", async () => {
  const { ManagedProtectionsCard } = await import(
    "../src/components/security/managed-protections"
  );
  const html = renderToStaticMarkup(
    <ManagedProtectionsCard
      data={{ machines: [machine], installerAvailable: true }}
      open={null}
      onOpen={() => {}}
    />,
  );
  expect(html).toContain("Managed protections");
  expect(html).toContain("Manage CrowdSec");
  expect(html).toContain("Install Automatic updates");
  expect(html).not.toContain("Trusted administrator IP addresses");
});
test("update UI distinguishes installed from managed, defaults reboots off, and disables offline changes", async () => {
  const { UpdateManagement } = await import(
    "../src/components/security/managed-protections"
  );
  const updates = {
    scheduleVersion: 2 as const,
    supported: true,
    installed: true,
    managed: false,
    enabled: false,
    healthy: false,
    busy: false,
    rebootRequired: false,
    policy: null,
    detail: "",
    lastRunAt: null,
    lastRebootRequestAt: null,
  };
  const m = { ...machine, snapshot: { ...managedSnapshot, updates } };
  const html = renderToStaticMarkup(
    <UpdateManagement machine={m} installerAvailable refresh={() => {}} />,
  );
  expect(html).toContain("Installed · not managed by Ephor");
  expect(html).toContain("Review and manage");
  expect(html).toContain("Days · UTC");
  expect(html).toContain("Check for updates at");
  expect(html).not.toContain("Window length");
  expect(html).not.toContain("Maintenance window");
  expect(html).not.toContain('type="checkbox" checked');
  const offline = renderToStaticMarkup(
    <UpdateManagement
      machine={{ ...m, lastSeen: Date.now() - 120000 }}
      installerAvailable
      refresh={() => {}}
    />,
  );
  expect(offline).toContain("Management offline");
  expect(offline).toContain("<fieldset disabled");
});

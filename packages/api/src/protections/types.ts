export const protectionActions = [
  "updates.install",
  "updates.configure",
  "updates.disable",
  "updates.remove",
  "install",
  "repair",
  "update",
  "enable",
  "confirm",
  "disable",
  "unblock",
  "uninstall",
] as const;
export type ProtectionAction = (typeof protectionActions)[number];
export interface UpdatePolicy {
  days: number[]; // ISO weekdays: Monday=1, Sunday=7, UTC
  startMinute: number;
  /** Read-only compatibility with previously saved schedules. */
  windowMinutes?: number;
  automaticReboot: boolean;
  rebootMinute: number;
}
export interface UpdateProtection {
  scheduleVersion?: 2;
  lastRunAt: number | null;
  lastRebootRequestAt: number | null;
  supported: boolean;
  installed: boolean;
  managed: boolean;
  enabled: boolean;
  healthy: boolean;
  busy: boolean;
  rebootRequired: boolean;
  policy: UpdatePolicy | null;
  detail: string;
}
export interface ProtectionParameters {
  trustedIPs?: string[];
  ip?: string;
  policy?: UpdatePolicy;
}
export interface ProtectionSnapshot {
  updates?: UpdateProtection;

  ownership: "absent" | "managed" | "external";
  supported: boolean;
  version: string;
  engineRunning: boolean;
  acquisitionReady: boolean;
  blocking: "off" | "pending" | "enabled";
  confirmBefore: number | null;
  sshPorts: number[];
  trustedIPs: string[];
  revision: string;
  detail: string;
  bans: { ip: string; reason: string; remainingSeconds: number }[];
}
export interface ProtectionJob {
  id: string;
  machineId: string;
  action: ProtectionAction;
  parameters: ProtectionParameters;
  revision: string;
  status: string;
  createdAt: number;
  expiresAt: number;
  result: string | null;
}
export interface ProtectionMachine {
  id: string;
  name: string;
  enabled: boolean;
  lastSeen: number | null;
  snapshot: ProtectionSnapshot | null;
  jobs: ProtectionJob[];
}
export interface ProtectionOverview {
  machines: ProtectionMachine[];
  installerAvailable: boolean;
}
export const CROWDSEC_VERSION = "1.8.2";
export function protectionPlan(action: ProtectionAction): string[] {
  if (action.startsWith("updates."))
    return [
      ...(action === "updates.remove"
        ? [
            "Remove only unchanged Ephor-owned policy and timer overrides, restoring the underlying APT policy. Leave unattended-upgrades installed. Earlier settings may resume automatic updates or reboots.",
          ]
        : action === "updates.disable"
          ? [
              "Pause Ephor automatic updates and reboots. Keep the package and managed policy installed. An in-progress package operation is allowed to finish.",
            ]
          : [
              "Install unattended-upgrades from the machine's authenticated APT repositories if needed. Take over scheduling using separate Ephor-owned overrides; preserve underlying configuration.",
              "Allow only the distribution's security origins. Check at the selected UTC time on the selected days; skip missed checks and starts without fresh panel contact.",
              "Package installation and security updates can restart services. In-progress package transactions are allowed to finish safely.",
              "Automatic reboots are off unless explicitly enabled. If enabled, reboot only at its independently selected UTC time on the same selected days, when required, with fresh panel contact, no logged-in users and no active package operation. Respect shutdown inhibitors.",
            ]),
      "No immediate upgrade or reboot is requested. Custom schedulers and manual package operations remain outside Ephor's control.",
      "Changes are bound to this machine and reviewed revision, expire, and are recorded in the audit log. Configuration conflicts require local review.",
    ];
  const common = [
    "Only Ephor-owned CrowdSec files and SSH blocking rules may be changed.",
    "Public web ports, Docker forwarding, SSH configuration and Tailscale are unchanged.",
  ];
  const steps: Record<
    Exclude<ProtectionAction, `updates.${string}`>,
    string[]
  > = {
    install: [
      "Download checksum-pinned CrowdSec 1.8.2 into its own private directory.",
      "Install the official SSH collection and read the SSH journal. Run a local-only API; community reporting is disabled.",
      "Start detection with blocking disabled.",
    ],
    repair: [
      "Stop SSH blocking and restore Ephor's pinned CrowdSec binaries and configuration. Preserve the local decisions database.",
    ],
    update: [
      "Stop SSH blocking and install the CrowdSec version pinned in this helper. Refresh the official SSH collection. Review the version after completion.",
    ],
    enable: [
      "Start a two-minute trial of SSH-only blocking for local CrowdSec SSH decisions.",
      "Exclude trusted administrator addresses and private networks. Existing connections remain usable.",
      "Open a NEW SSH connection, then confirm in the panel before the deadline. Otherwise blocking is disabled locally.",
    ],
    confirm: [
      "Confirm that you tested a NEW SSH connection. Keep SSH blocking enabled while the helper can authenticate to Ephor.",
      "Individual firewall entries expire within 60 seconds without refresh; panel connectivity loss stops refresh after 90 seconds.",
    ],
    disable: [
      "Disable Ephor SSH blocking and remove its dedicated firewall table. Detection continues.",
    ],
    unblock: [
      "Temporarily exempt this IP for one hour and remove it from Ephor's SSH block set. The CrowdSec decision stays visible to its engine.",
    ],
    uninstall: [
      "Disable blocking, stop Ephor's CrowdSec service and remove Ephor-owned runtime files. Preserve the private database, job receipts and management helper for recovery.",
    ],
  };
  return [...steps[action as keyof typeof steps], ...common];
}

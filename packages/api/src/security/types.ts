export const severities = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const;
export type Severity = (typeof severities)[number];
export const findingStatuses = [
  "open",
  "acknowledged",
  "accepted",
  "resolved",
] as const;
export type FindingStatus = (typeof findingStatuses)[number];
export type CheckStatus = "pass" | "fail" | "unsupported" | "error";
export interface SecurityCheck {
  key: string;
  title: string;
  status: CheckStatus;
  category: "ssh" | "network" | "maintenance" | "container" | "coverage";
  severity: Severity;
  component: string;
  evidence: string;
  remediation: string;
}
export interface Vulnerability {
  advisory: string;
  package: string;
  installedVersion: string;
  fixedVersion: string;
  severity: Severity;
  component: string;
  digest: string;
  target: string;
}
export interface SecurityInventory {
  os: string;
  ports: { protocol: string; address: string; port: number; process: string }[];
  firewalls: { name: string; status: string; rules: string }[];
  protections: { name: string; status: string; detail: string }[];
  containers: {
    id: string;
    component: string;
    digest: string;
    user: string;
    privileged: boolean;
    readonlyRootfs: boolean;
    capabilities: string[];
    mounts: string[];
    ports: string[];
    networks: string[];
  }[];
}
export interface ScanResult {
  checks: SecurityCheck[];
  vulnerabilities: Vulnerability[];
  vulnerabilitiesComplete: boolean;
  inventory: SecurityInventory;
  scanner: { version: string; databaseUpdatedAt: number | null } | null;
}
export interface SecurityScan {
  id: string;
  machineId: string;
  serviceId: string | null;
  target: string;
  revision: string | null;
  status:
    | "queued"
    | "running"
    | "completed"
    | "partial"
    | "failed"
    | "superseded";
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  result: ScanResult | null;
}
export interface SecurityFinding {
  id: string;
  machineId: string;
  machineName: string;
  serviceId: string | null;
  serviceName: string | null;
  rule: string;
  category: string;
  component: string;
  severity: Severity;
  title: string;
  evidence: string;
  remediation: string;
  detail: Vulnerability | null;
  status: FindingStatus;
  reason: string | null;
  acceptedUntil: number | null;
  firstSeen: number;
  lastSeen: number;
  resolvedAt: number | null;
  scanId: string;
}
export interface SecurityEvent {
  id: string;
  machineId: string | null;
  serviceId: string | null;
  findingId: string | null;
  occurredAt: number;
  receivedAt: number;
  kind: string;
  actor: string;
  action: string;
  outcome: string;
  detail: string;
}
export interface SecurityOverview {
  machines: {
    id: string;
    name: string;
    state: string;
    lastSeen: number | null;
    enabled: boolean;
    version: string | null;
  }[];
  services: {
    id: string;
    name: string;
    machineId: string;
    domain: string | null;
    currentDeployment: string | null;
  }[];
  scans: SecurityScan[];
  counts: Record<Severity, number>;
  actionCounts?: { active: number; stopped: number };
  maintenance: {
    machineId: string;
    observedAt: number | null;
    status: string;
    checks: SecurityCheck[];
  }[];
  retentionDays: number;
  installerAvailable: boolean;
}
export interface FindingList {
  items: SecurityFinding[];
  nextCursor: string | null;
}
export interface SecurityAction {
  target: string;
  machineId: string;
  machineName: string;
  serviceId: string | null;
  serviceName: string | null;
  stopped: boolean;
  count: number;
  advisoryCount: number;
  imageCount: number;
  counts: Record<Severity, number>;
  layers: { os: number; language: number; other: number };
  fixesAvailable: number;
  noFixReported: number;
  configurationCount: number;
  lastSeen: number;
  sampleFindingId: string;
}
export interface SecurityActionList {
  items: SecurityAction[];
  nextCursor: string | null;
}
export interface SecurityEventList {
  items: SecurityEvent[];
  nextCursor: string | null;
}

export interface SecurityDeployment {
  runtime: "cloudflare-worker" | "node" | "bun" | "unknown";
  origin: string;
  database: "D1" | "PostgreSQL" | "unknown";
  frontendDetected: "same-runtime" | "unknown";
  configured: {
    provider: string;
    ingress:
      | "unknown"
      | "direct"
      | "reverse-proxy"
      | "cloudflare-proxy"
      | "cloudflare-tunnel"
      | "private";
    frontend: "unknown" | "same-runtime" | "separate";
    machineId: string | null;
  };
  updatedAt: number | null;
  revision: number;
}

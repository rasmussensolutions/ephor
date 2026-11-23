export type PanelHost = "cloudflare" | "railway" | "vps" | "other";
export interface PanelConfig {
  installationId: string;
  repositoryId: string;
  repository: string;
  branch: string;
  host: PanelHost;
  deployment: "git" | "manual";
}
export interface PanelJob {
  id: string;
  target: string;
  base: string;
  createdAt: number;
  head?: string;
  pull?: number;
  merged?: string;
  mergedAt?: number;
}
export interface PanelState {
  config?: PanelConfig;
  latest?: string;
  checkedAt?: number;
  repositoryVersion?: string;
  job?: PanelJob;
}
export interface PanelFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
export interface PanelProgress {
  stage:
    | "preparing"
    | "prepared"
    | "checking"
    | "ready"
    | "blocked"
    | "deploying"
    | "manual"
    | "updated";
  message: string;
  runUrl?: string;
  pullUrl?: string;
  head?: string;
  files?: PanelFile[];
}
export interface PanelStatus extends PanelState {
  running: string;
  detectedHost: PanelHost;
  progress?: PanelProgress;
}

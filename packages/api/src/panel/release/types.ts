import type { SignedRelease } from "./manifest";
export type ReleaseHost = "docker" | "railway" | "cloudflare";
export type Hosting =
  | { host: "docker" }
  | { host: "railway"; token: string; serviceId: string; environmentId: string }
  | {
      host: "cloudflare";
      token: string;
      accountId: string;
      worker: string;
      databaseId: string;
    };
export interface ReleaseJob {
  id: string;
  version: string;
  sequence: number;
  envelope: SignedRelease;
  stage:
    | "queued"
    | "assets"
    | "migrating"
    | "deploying"
    | "verifying"
    | "complete"
    | "failed";
  createdAt: number;
  updatedAt: number;
  message: string;
  recovery?: string;
  deploymentId?: string;
  upload?: { jwt: string; hashes: string[]; expires: number };
  migration?: number;
}
export interface ReleaseState {
  hosting?: Hosting;
  latest?: SignedRelease;
  checkedAt?: number;
  highestSequence?: number;
  job?: ReleaseJob;
  updaterSeen?: number;
}
export interface ReleaseStatus {
  running: string;
  detectedHost: ReleaseHost | "unknown";
  hosting?: {
    host: ReleaseHost;
    accountId?: string;
    worker?: string;
    databaseId?: string;
    serviceId?: string;
    environmentId?: string;
  };
  latest?: {
    version: string;
    sequence: number;
    notes: string;
    compatible: boolean;
  };
  checkedAt?: number;
  updaterSeen?: number;
  job?: Pick<
    ReleaseJob,
    | "id"
    | "version"
    | "stage"
    | "createdAt"
    | "updatedAt"
    | "message"
    | "recovery"
  >;
}

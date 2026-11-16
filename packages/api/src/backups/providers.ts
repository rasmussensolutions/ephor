import { AuthError } from "../auth/store";
import { object } from "../services/spec";

export const providers = [
  { id: "r2", name: "Cloudflare R2", region: "auto" },
  { id: "b2", name: "Backblaze B2", region: "us-west-004" },
  { id: "s3", name: "Amazon S3", region: "eu-west-1" },
  { id: "spaces", name: "DigitalOcean Spaces", region: "fra1" },
  { id: "wasabi", name: "Wasabi", region: "eu-central-1" },
  { id: "hetzner", name: "Hetzner Object Storage", region: "fsn1" },
] as const;
export interface DestinationConfig {
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}
export function destinationConfig(value: unknown): DestinationConfig {
  const b = object(value);
  const provider = String(b.provider);
  const region = provider === "r2" ? "auto" : String(b.region ?? "").trim();
  if (
    !providers.some((p) => p.id === provider) ||
    !/^[a-z0-9-]{2,32}$/.test(region)
  )
    throw new AuthError("INVALID_BACKUP_DESTINATION");
  let host: string;
  switch (provider) {
    case "r2": {
      const account = String(b.accountId ?? "").trim();
      if (!/^[a-f0-9]{32}$/.test(account))
        throw new AuthError("INVALID_BACKUP_DESTINATION");
      const jurisdiction = String(b.jurisdiction ?? "default");
      if (!["default", "eu", "us", "fedramp"].includes(jurisdiction))
        throw new AuthError("INVALID_BACKUP_DESTINATION");
      host = `${account}${jurisdiction === "default" ? "" : `.${jurisdiction}`}.r2.cloudflarestorage.com`;
      break;
    }
    case "b2":
      host = `s3.${region}.backblazeb2.com`;
      break;
    case "s3":
      host = `s3.${region}.amazonaws.com`;
      break;
    case "spaces":
      host = `${region}.digitaloceanspaces.com`;
      break;
    case "wasabi":
      host = `s3.${region}.wasabisys.com`;
      break;
    case "hetzner":
      host = `${region}.your-objectstorage.com`;
      break;
    default:
      throw new AuthError("INVALID_BACKUP_DESTINATION");
  }
  const bucket = String(b.bucket ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
    throw new AuthError("INVALID_BACKUP_DESTINATION");
  for (const key of ["accessKey", "secretKey"])
    if (typeof b[key] !== "string" || !/^[\x21-\x7e]{8,256}$/.test(b[key]))
      throw new AuthError("INVALID_BACKUP_DESTINATION");
  return {
    provider,
    endpoint: `https://${host}`,
    region,
    bucket,
    accessKey: String(b.accessKey),
    secretKey: String(b.secretKey),
  };
}
export function schedule(value: unknown) {
  const b = object(value);
  const frequency = String(b.frequency ?? "daily");
  const hour = Number(b.hour ?? 2);
  if (
    !["manual", "daily", "weekly"].includes(frequency) ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23
  )
    throw new AuthError("INVALID_BACKUP_SCHEDULE");
  return { frequency, hour };
}
export function nextRun(frequency: string, hour: number, now = Date.now()) {
  if (frequency === "manual") return 0;
  const date = new Date(now);
  date.setUTCHours(hour, 0, 0, 0);
  if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 1);
  if (frequency === "weekly")
    while (date.getUTCDay() !== 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}

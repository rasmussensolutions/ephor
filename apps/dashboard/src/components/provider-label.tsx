import { CloudIcon } from "@phosphor-icons/react/dist/csr/Cloud";
import { cn } from "cn";
import type { CSSProperties } from "react";
import {
  siAkamai,
  siContabo,
  siDigitalocean,
  siGooglecloud,
  siHetzner,
  siHostinger,
  siIonos,
  siNetcup,
  siOvh,
  siScaleway,
  siUpcloud,
  siVultr,
} from "simple-icons";
import aws from "@/assets/providers/aws.svg";
import azure from "@/assets/providers/azure.svg";
import oracle from "@/assets/providers/oracle.svg";

type Brand = { path: string; hex: string } | { image: string };
// Exact, case-insensitive aliases avoid branding unrelated custom provider names.
const brands: Record<string, Brand> = {
  hetzner: siHetzner,
  hetznercloud: siHetzner,
  aws: { image: aws },
  amazonwebservices: { image: aws },
  azure: { image: azure },
  microsoftazure: { image: azure },
  googlecloud: siGooglecloud,
  gcp: siGooglecloud,
  digitalocean: siDigitalocean,
  linode: siAkamai,
  akamai: siAkamai,
  akamaicloud: siAkamai,
  netcup: siNetcup,
  ovh: siOvh,
  ovhcloud: siOvh,
  vultr: siVultr,
  scaleway: siScaleway,
  upcloud: siUpcloud,
  contabo: siContabo,
  ionos: siIonos,
  hostinger: siHostinger,
  oracle: { image: oracle },
  oraclecloud: { image: oracle },
  oci: { image: oracle },
};

export function ProviderIcon({
  name,
  className,
}: {
  name?: string | null;
  className?: string;
}) {
  const key = (name?.trim() || "").toLowerCase().replace(/[\s_-]+/g, "");
  const brand = Object.hasOwn(brands, key) ? brands[key] : undefined;
  if (!brand)
    return (
      <CloudIcon
        aria-hidden="true"
        className={cn("size-4 shrink-0 text-muted-foreground", className)}
      />
    );
  if ("image" in brand)
    return (
      <img
        src={brand.image}
        alt=""
        aria-hidden="true"
        width={18}
        height={18}
        className={cn(
          "size-[18px] shrink-0 object-contain dark:brightness-0 dark:invert",
          className,
        )}
      />
    );
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={cn(
        "size-4 shrink-0 fill-current text-[var(--provider-color)] dark:text-foreground",
        className,
      )}
      style={{ "--provider-color": `#${brand.hex}` } as CSSProperties}
    >
      <path d={brand.path} />
    </svg>
  );
}

export function ProviderLabel({
  name,
  className,
}: {
  name?: string | null;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <ProviderIcon name={name} />
      <span className="truncate">{name?.trim() || "Unknown"}</span>
    </span>
  );
}

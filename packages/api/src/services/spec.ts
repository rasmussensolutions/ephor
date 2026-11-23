import { AuthError } from "../auth/store";
import { type CatalogSpec, validateCatalog } from "./catalog";
import type { ServiceTechnology } from "./technology";

export type { CatalogItem, CatalogRuntime } from "./catalog";
export type { ServicePresentation } from "./presentation";
export { imageTechnology, type ServiceTechnology } from "./technology";
export type { ServiceTopology } from "./topology";
export interface ServiceSpec {
  /** Managed named volumes. Persistent services always use stop/start deployment. */
  volumes?: { name: string; mountPath: string }[];
  /** Deployment-only network grants, derived from validated variable references. */
  connections?: {
    serviceId: string;
    template: "postgres" | "redis" | "qdrant";
  }[];
  catalog?: CatalogSpec;
  image: string;
  port: number;
  healthPath: string;
  memoryMb: number;
  cpus: number;
  environment: Record<string, string>;
  registry: { server: string; username: string; password: string } | null;
}
export interface ServiceSource {
  type: "image" | "github" | "catalog";
  template?: string;
  technology?: ServiceTechnology | null;
  installationId?: string;
  buildMachineId?: string;
  buildType?: "auto" | "dockerfile" | "railpack";
  buildMemoryMb?: number;
  buildCpus?: number;
  repository?: string;
  repositoryId?: string;
  ownerId?: string;
  branch?: string;
  dockerfile?: string;
  context?: string;
  architecture?: "x86_64" | "aarch64";
}
export const IMAGE =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AuthError("INVALID_SERVICE");
  return value as Record<string, unknown>;
}
export function serviceId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
    throw new AuthError("INVALID_ID");
  return value;
}
export function domainName(value: unknown): string | null {
  if (!value) return null;
  if (typeof value !== "string") throw new AuthError("INVALID_DOMAIN");
  const name = value.trim().toLowerCase();
  if (
    name.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name) ||
    /\.(localhost|local|internal|test|invalid|example)$/.test(name)
  )
    throw new AuthError("INVALID_DOMAIN");
  return name;
}
export function spec(value: unknown): ServiceSpec {
  const v = object(value);
  if (
    typeof v.image !== "string" ||
    v.image.length > 255 ||
    !IMAGE.test(v.image)
  )
    throw new AuthError("INVALID_IMAGE");
  const port = Number(v.port ?? 3000),
    memoryMb = Number(v.memoryMb ?? 256),
    cpus = Number(v.cpus ?? 0.5);
  const healthPath = v.healthPath ?? "/";
  if (
    !Number.isInteger(port) ||
    port < (v.catalog ? 1 : 1024) ||
    port > 65535 ||
    !Number.isInteger(memoryMb) ||
    memoryMb < 64 ||
    memoryMb > 65536 ||
    !Number.isFinite(cpus) ||
    cpus < 0.1 ||
    cpus > 32 ||
    typeof healthPath !== "string" ||
    !/^\/[A-Za-z0-9/_.~-]*$/.test(healthPath) ||
    healthPath.length > 200
  )
    throw new AuthError("INVALID_SERVICE_LIMITS");
  const environment = object(v.environment ?? {});
  if (
    Object.keys(environment).length > 64 ||
    JSON.stringify(environment).length > 12000
  )
    throw new AuthError("INVALID_ENVIRONMENT");
  for (const [name, val] of Object.entries(environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ||
      typeof val !== "string" ||
      val.includes("\0") ||
      val.length > 4096
    )
      throw new AuthError("INVALID_ENVIRONMENT");
  }
  let registry: ServiceSpec["registry"] = null;
  if (v.registry) {
    const r = object(v.registry);
    if (
      r.server !== v.image.split("/")[0] ||
      typeof r.username !== "string" ||
      !r.username ||
      r.username.length > 200 ||
      typeof r.password !== "string" ||
      !r.password ||
      r.password.length > 4096
    )
      throw new AuthError("INVALID_REGISTRY");
    registry = {
      server: String(r.server),
      username: r.username,
      password: r.password,
    };
  }
  const volumes = v.volumes === undefined ? [] : persistentVolumes(v.volumes);
  const result: ServiceSpec = {
    ...(volumes.length ? { volumes } : {}),
    ...(v.catalog ? { catalog: v.catalog as CatalogSpec } : {}),
    image: v.image,
    port,
    healthPath,
    memoryMb,
    cpus,
    environment: environment as Record<string, string>,
    registry,
  };
  validateCatalog(result);
  if (result.catalog && result.volumes?.length)
    throw new AuthError("INVALID_VOLUMES");
  return result;
}
export function persistentVolumes(
  value: unknown,
): NonNullable<ServiceSpec["volumes"]> {
  if (!Array.isArray(value) || value.length > 4)
    throw new AuthError("INVALID_VOLUMES");
  const names = new Set<string>();
  const paths: string[] = [];
  return value
    .map((entry) => {
      const v = object(entry);
      if (
        Object.keys(v).some((key) => !["name", "mountPath"].includes(key)) ||
        typeof v.name !== "string" ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(v.name) ||
        names.has(v.name) ||
        typeof v.mountPath !== "string" ||
        v.mountPath.length > 150 ||
        !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(v.mountPath) ||
        /^\/(?:proc|sys|dev|etc|bin|sbin|lib|lib64|usr|run|tmp)(?:\/|$)/.test(
          v.mountPath,
        ) ||
        /^\/var\/(?:run|lib\/docker)(?:\/|$)/.test(v.mountPath) ||
        paths.some(
          (p) =>
            p === v.mountPath ||
            p.startsWith(`${v.mountPath}/`) ||
            String(v.mountPath).startsWith(`${p}/`),
        )
      )
        throw new AuthError("INVALID_VOLUMES");
      names.add(v.name);
      paths.push(v.mountPath);
      return { name: v.name, mountPath: v.mountPath };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function isStateful(config: Pick<ServiceSpec, "catalog" | "volumes">) {
  return !!config.catalog || !!config.volumes?.length;
}
export function requiredProtocol(
  config: ServiceSpec,
  includeSavedReferences = false,
) {
  return config.volumes?.length ||
    config.catalog?.resources ||
    config.catalog?.template === "qdrant" ||
    config.connections?.some((c) => c.template === "qdrant") ||
    (includeSavedReferences &&
      Object.values(config.environment).some((v) =>
        /^\$\{\{[a-f0-9-]{36}\.QDRANT_(URL|GRPC_URL|API_KEY)\}\}$/.test(v),
      ))
    ? 6
    : config.connections?.length ||
        (includeSavedReferences &&
          Object.values(config.environment).some((v) =>
            /^\$\{\{[a-f0-9-]{36}\.(DATABASE_URL|REDIS_URL)\}\}$/.test(v),
          ))
      ? 5
      : config.catalog
        ? 3
        : 2;
}
export function publicSpec(value: ServiceSpec) {
  return {
    ...value,
    environment: Object.keys(value.environment),
    registry: value.registry
      ? { server: value.registry.server, username: value.registry.username }
      : null,
  };
}

export function buildSettings(b: Record<string, unknown>) {
  const dockerfile = String(b.dockerfile ?? "Dockerfile"),
    context = String(b.context ?? ".");
  for (const path of [dockerfile, context])
    if (
      !/^(\.|[A-Za-z0-9_][A-Za-z0-9_./-]{0,149})$/.test(path) ||
      path.split("/").some((p) => p === ".." || p === ".git")
    )
      throw new AuthError("INVALID_BUILD_PATH");
  const buildType = b.buildType ?? "auto",
    buildMemoryMb = Number(b.buildMemoryMb ?? 1024),
    buildCpus = Number(b.buildCpus ?? 1);
  if (
    !["auto", "dockerfile", "railpack"].includes(String(buildType)) ||
    !Number.isInteger(buildMemoryMb) ||
    buildMemoryMb < 512 ||
    buildMemoryMb > 32768 ||
    !Number.isFinite(buildCpus) ||
    buildCpus < 0.25 ||
    buildCpus > 16
  )
    throw new AuthError("INVALID_BUILD_SETTINGS");
  return {
    dockerfile,
    context,
    buildType: buildType as "auto" | "dockerfile" | "railpack",
    buildMemoryMb,
    buildCpus,
    ...(b.buildMachineId
      ? { buildMachineId: serviceId(b.buildMachineId) }
      : {}),
  };
}
export interface ServiceDomains {
  primary: string | null;
  aliases: string[];
  redirect: boolean;
}
export function serviceDomains(value: unknown): ServiceDomains {
  const b = object(value),
    primary = domainName(b.primary),
    aliases = b.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 9)
    throw new AuthError("INVALID_DOMAIN");
  const names = aliases.map(domainName);
  if (
    names.some((n) => !n) ||
    (!primary && names.length) ||
    new Set([primary, ...names]).size !== names.length + 1
  )
    throw new AuthError("INVALID_DOMAIN");
  return { primary, aliases: names as string[], redirect: b.redirect === true };
}

export type { MetricsHistory, ServiceMetrics, ServiceRuntime } from "./metrics";

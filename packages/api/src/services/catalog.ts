import { AuthError, randomToken } from "../auth/store";
import definitions from "./catalog/templates.json";
import { readMetrics, type ServiceMetrics } from "./metrics";
import type { ServiceSource, ServiceSpec } from "./spec";
import type { ServiceTechnology } from "./technology";

export interface CatalogSpec {
  template: string;
  version: number;
  protected: boolean;
  resources?: { memoryMb: number; cpus: number; redisMaxmemoryMb?: number };
}
export interface CatalogRuntime {
  components: {
    name: string;
    status: string;
    image: string;
    logs?: string;
    metrics?: ServiceMetrics | null;
  }[];
  volumes: { name: string; target: string; component: string }[];
  backups: { id: string; createdAt: number; volumes: string[] }[];
  port: number;
  recoveryRequired: boolean;
}
export function template(id: unknown, version?: number) {
  const value = definitions.templates
    .filter(
      (t) => t.id === id && (version === undefined || t.version === version),
    )
    .sort((a, b) => b.version - a.version)[0];
  if (!value) throw new AuthError("CATALOG_APP_NOT_FOUND", 404);
  return value;
}
export function catalog() {
  return [...new Set(definitions.templates.map((t) => t.id))]
    .map((id) => template(id))
    .map((t) => ({
      id: t.id,
      version: t.version,
      name: t.name,
      category: t.category,
      description: t.description,
      technology: t.technology,
      web: t.web,
      notes: t.notes,
      memoryMb: t.components.reduce((sum, c) => sum + c.memoryMb, 0),
      components: t.components.map((c) => ({
        name: c.id,
        image: c.image,
        port: c.port,
      })),
      volumes: t.components.flatMap((c) =>
        c.volumes.map((v) => ({ component: c.id, target: v.target })),
      ),
    }));
}
export type CatalogItem = ReturnType<typeof catalog>[number];
export function catalogConfig(id: unknown): {
  config: ServiceSpec;
  source: ServiceSource;
} {
  const t = template(id),
    main = t.components.at(-1);
  if (!main) throw new AuthError("INVALID_CATALOG_TEMPLATE");
  return {
    source: {
      type: "catalog",
      technology: t.technology as ServiceTechnology | null,
      template: t.id,
    },
    config: {
      image: main.image,
      port: main.port,
      healthPath: "/",
      memoryMb: t.components.reduce((sum, c) => sum + c.memoryMb, 0),
      cpus: 1,
      environment: Object.fromEntries(
        t.secrets.map((key) => [key, randomToken()]),
      ),
      registry: null,
      catalog: { template: t.id, version: t.version, protected: t.web },
    },
  };
}
export function validateCatalog(config: ServiceSpec) {
  if (!config.catalog) return;
  const c = config.catalog,
    t = template(c.template, c.version),
    main = t.components.at(-1);
  if (!main) throw new AuthError("INVALID_CATALOG_TEMPLATE");
  if (c.resources !== undefined) {
    const r = c.resources;
    if (
      !r ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      !["postgres", "redis", "qdrant"].includes(c.template) ||
      Object.keys(r).some(
        (k) => !["memoryMb", "cpus", "redisMaxmemoryMb"].includes(k),
      ) ||
      !Number.isInteger(r.memoryMb) ||
      r.memoryMb < 128 ||
      r.memoryMb > 65536 ||
      !Number.isFinite(r.cpus) ||
      r.cpus < 0.1 ||
      r.cpus > 32 ||
      (c.template === "redis"
        ? !Number.isInteger(r.redisMaxmemoryMb) ||
          (r.redisMaxmemoryMb ?? 0) < 16 ||
          (r.redisMaxmemoryMb ?? 0) > Math.floor(r.memoryMb * 0.75)
        : r.redisMaxmemoryMb !== undefined)
    )
      throw new AuthError("INVALID_DATABASE_RESOURCES");
    config.memoryMb = r.memoryMb;
    config.cpus = r.cpus;
  }
  if (
    c.version !== t.version ||
    typeof c.protected !== "boolean" ||
    config.image !== main.image ||
    config.registry ||
    Object.keys(config.environment).length !== t.secrets.length ||
    !t.secrets.every((k) => /^[a-f0-9]{64}$/.test(config.environment[k] ?? ""))
  )
    throw new AuthError("INVALID_CATALOG_CONFIG");
}
export function readCatalogRuntime(value: unknown): CatalogRuntime | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value as CatalogRuntime;
  const safe = (s: unknown) =>
    typeof s === "string" && /^[a-z0-9-]{1,160}$/.test(s);
  if (
    !v ||
    !Array.isArray(v.components) ||
    v.components.length > 8 ||
    !v.components.every(
      (c) =>
        !!c &&
        safe(c.name) &&
        ["running", "unhealthy", "stopped", "missing"].includes(c.status) &&
        typeof c.image === "string" &&
        c.image.length < 256 &&
        (c.logs === undefined ||
          (typeof c.logs === "string" && c.logs.length <= 6000)),
    ) ||
    !Array.isArray(v.volumes) ||
    v.volumes.length > 16 ||
    !v.volumes.every(
      (x) =>
        !!x &&
        safe(x.name) &&
        safe(x.component) &&
        typeof x.target === "string" &&
        x.target.length < 150,
    ) ||
    !Array.isArray(v.backups) ||
    v.backups.length > 20 ||
    !v.backups.every(
      (b) =>
        !!b &&
        safe(b.id) &&
        Number.isSafeInteger(b.createdAt) &&
        b.createdAt > 0 &&
        Array.isArray(b.volumes) &&
        b.volumes.length <= 16 &&
        b.volumes.every(safe),
    ) ||
    !Number.isInteger(v.port) ||
    v.port < 0 ||
    v.port > 65535 ||
    typeof v.recoveryRequired !== "boolean"
  )
    throw new AuthError("INVALID_CATALOG_REPORT");
  return {
    components: v.components.map(({ name, status, image, logs, metrics }) => ({
      name,
      status,
      image,
      ...(logs !== undefined ? { logs } : {}),
      ...(metrics !== undefined ? { metrics: readMetrics(metrics) } : {}),
    })),
    volumes: v.volumes.map(({ name, target, component }) => ({
      name,
      target,
      component,
    })),
    backups: v.backups.map(({ id, createdAt, volumes }) => ({
      id,
      createdAt,
      volumes,
    })),
    port: v.port,
    recoveryRequired: v.recoveryRequired,
  };
}

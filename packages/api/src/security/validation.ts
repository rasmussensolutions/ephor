import { AuthError } from "../auth/store";
import { object } from "../services/spec";
import {
  type ScanResult,
  type SecurityCheck,
  type Severity,
  severities,
} from "./types";

export function text(value: unknown, max = 256, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    [...value].some((c) => {
      const n = c.charCodeAt(0);
      return (n < 32 && n !== 9 && n !== 10) || n === 127;
    })
  )
    throw new AuthError("INVALID_SECURITY_REPORT");
  return value;
}
export function id(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9-]{36}$/.test(result))
    throw new AuthError("INVALID_SECURITY_ID");
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new AuthError("INVALID_SECURITY_REPORT");
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new AuthError("INVALID_SECURITY_REPORT");
  return value;
}
export function severity(value: unknown): Severity {
  if (!severities.includes(value as Severity))
    throw new AuthError("INVALID_SECURITY_REPORT");
  return value as Severity;
}
function strings(value: unknown, max = 64) {
  return list(value, max).map((v) => text(v, 256));
}
export function scanResult(value: unknown): ScanResult {
  const b = object(value),
    inventory = object(b.inventory);
  const checks = list(b.checks, 512).map((v): SecurityCheck => {
    const c = object(v);
    if (
      !["pass", "fail", "unsupported", "error"].includes(String(c.status)) ||
      !["ssh", "network", "maintenance", "container", "coverage"].includes(
        String(c.category),
      )
    )
      throw new AuthError("INVALID_SECURITY_REPORT");
    return {
      key: text(c.key, 100),
      title: text(c.title, 180),
      status: c.status as SecurityCheck["status"],
      category: c.category as SecurityCheck["category"],
      severity: severity(c.severity),
      component: text(c.component, 128, true),
      evidence: text(c.evidence, 2000, true),
      remediation: text(c.remediation, 1000, true),
    };
  });
  if (
    new Set(checks.map((c) => JSON.stringify([c.key, c.component]))).size !==
    checks.length
  )
    throw new AuthError("DUPLICATE_SECURITY_CHECK");
  const vulnerabilities = list(b.vulnerabilities, 1000).map((v) => {
    const c = object(v),
      digest = text(c.digest, 80);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest))
      throw new AuthError("INVALID_SECURITY_REPORT");
    return {
      advisory: text(c.advisory, 100),
      package: text(c.package, 256),
      installedVersion: text(c.installedVersion, 128),
      fixedVersion: text(c.fixedVersion, 256, true),
      severity: severity(c.severity),
      component: text(c.component, 128),
      digest,
      target: text(c.target, 256, true),
    };
  });
  let scanner: ScanResult["scanner"] = null;
  if (b.scanner !== null) {
    const s = object(b.scanner),
      time = s.databaseUpdatedAt;
    if (
      time !== null &&
      (typeof time !== "number" ||
        !Number.isSafeInteger(time) ||
        time < 0 ||
        time > Date.now() + 300000)
    )
      throw new AuthError("INVALID_SECURITY_REPORT");
    scanner = {
      version: text(s.version, 80),
      databaseUpdatedAt: time as number | null,
    };
  }
  return {
    checks,
    vulnerabilities,
    vulnerabilitiesComplete: flag(b.vulnerabilitiesComplete),
    scanner,
    inventory: {
      os: text(inventory.os, 256, true),
      ports: list(inventory.ports, 256).map((v) => {
        const p = object(v);
        if (
          !["tcp", "udp"].includes(String(p.protocol)) ||
          !Number.isInteger(p.port) ||
          Number(p.port) < 1 ||
          Number(p.port) > 65535
        )
          throw new AuthError("INVALID_SECURITY_REPORT");
        return {
          protocol: String(p.protocol),
          address: text(p.address, 128),
          port: Number(p.port),
          process: text(p.process, 128, true),
        };
      }),
      firewalls: list(inventory.firewalls, 8).map((v) => {
        const p = object(v);
        return {
          name: text(p.name, 64),
          status: text(p.status, 64),
          rules: text(p.rules, 16000, true),
        };
      }),
      protections: list(inventory.protections, 8).map((v) => {
        const p = object(v);
        return {
          name: text(p.name, 64),
          status: text(p.status, 64),
          detail: text(p.detail, 256, true),
        };
      }),
      containers: list(inventory.containers, 32).map((v) => {
        const p = object(v),
          digest = text(p.digest, 80);
        if (!/^sha256:[a-f0-9]{64}$/.test(digest))
          throw new AuthError("INVALID_SECURITY_REPORT");
        return {
          id: text(p.id, 64),
          component: text(p.component, 128),
          digest,
          user: text(p.user, 128, true),
          privileged: flag(p.privileged),
          readonlyRootfs: flag(p.readonlyRootfs),
          capabilities: strings(p.capabilities),
          mounts: strings(p.mounts),
          ports: strings(p.ports),
          networks: strings(p.networks),
        };
      }),
    },
  };
}

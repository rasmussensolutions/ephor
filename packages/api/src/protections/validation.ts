import { AuthError } from "../auth/store";
import { text } from "../security/validation";
import { object } from "../services/spec";
import {
  type ProtectionAction,
  type ProtectionSnapshot,
  protectionActions,
  type UpdatePolicy,
  type UpdateProtection,
} from "./types";
export function ip(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 45 ||
    !/^[a-fA-F0-9:.]+$/.test(value)
  )
    throw new AuthError("INVALID_PROTECTION_IP");
  if (value.includes(":")) {
    try {
      const url = new URL(`http://[${value}]/`);
      return url.hostname.slice(1, -1);
    } catch {
      throw new AuthError("INVALID_PROTECTION_IP");
    }
  }
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || +p > 255)
  )
    throw new AuthError("INVALID_PROTECTION_IP");
  return value;
}
export function action(value: unknown): ProtectionAction {
  if (!protectionActions.includes(value as ProtectionAction))
    throw new AuthError("INVALID_PROTECTION_ACTION");
  return value as ProtectionAction;
}
export function parameters(a: ProtectionAction, value: unknown) {
  const b = object(value);
  if (a.startsWith("updates.")) {
    const configuring = a === "updates.install" || a === "updates.configure";
    if (Object.keys(b).some((k) => !configuring || k !== "policy"))
      throw new AuthError("INVALID_PROTECTION_PARAMETERS");
    return configuring ? { policy: updatePolicy(b.policy) } : {};
  }
  const keys = a === "enable" ? ["trustedIPs"] : a === "unblock" ? ["ip"] : [];
  if (Object.keys(b).some((k) => !keys.includes(k)))
    throw new AuthError("INVALID_PROTECTION_PARAMETERS");
  if (a === "enable") {
    if (
      !Array.isArray(b.trustedIPs) ||
      !b.trustedIPs.length ||
      b.trustedIPs.length > 16
    )
      throw new AuthError("TRUSTED_IP_REQUIRED");
    return { trustedIPs: [...new Set(b.trustedIPs.map(ip))].sort() };
  }
  return a === "unblock" ? { ip: ip(b.ip) } : {};
}
export function snapshot(value: unknown): ProtectionSnapshot {
  const b = object(value);
  if (
    !["absent", "managed", "external"].includes(String(b.ownership)) ||
    !["off", "pending", "enabled"].includes(String(b.blocking)) ||
    !/^[a-f0-9]{64}$/.test(String(b.revision)) ||
    [b.supported, b.engineRunning, b.acquisitionReady].some(
      (v) => typeof v !== "boolean",
    ) ||
    !Array.isArray(b.sshPorts) ||
    b.sshPorts.length > 8 ||
    b.sshPorts.some((v) => !Number.isInteger(v) || v < 1 || v > 65535) ||
    !Array.isArray(b.trustedIPs) ||
    b.trustedIPs.length > 32 ||
    !Array.isArray(b.bans) ||
    b.bans.length > 100 ||
    !(b.confirmBefore === null || Number.isSafeInteger(b.confirmBefore))
  )
    throw new AuthError("INVALID_PROTECTION_SNAPSHOT");
  return {
    ...(b.updates === undefined ? {} : { updates: updateSnapshot(b.updates) }),
    ownership: b.ownership as ProtectionSnapshot["ownership"],
    blocking: b.blocking as ProtectionSnapshot["blocking"],
    supported: b.supported as boolean,
    engineRunning: b.engineRunning as boolean,
    acquisitionReady: b.acquisitionReady as boolean,
    version: text(b.version, 80, true),
    revision: String(b.revision),
    detail: text(b.detail, 600, true),
    sshPorts: b.sshPorts as number[],
    trustedIPs: b.trustedIPs.map(ip),
    confirmBefore: b.confirmBefore as number | null,
    bans: b.bans.map((v) => {
      const x = object(v);
      if (
        !Number.isInteger(x.remainingSeconds) ||
        Number(x.remainingSeconds) < 0 ||
        Number(x.remainingSeconds) > 14400
      )
        throw new AuthError("INVALID_PROTECTION_SNAPSHOT");
      return {
        ip: ip(x.ip),
        reason: text(x.reason, 160),
        remainingSeconds: Number(x.remainingSeconds),
      };
    }),
  };
}

export function updatePolicy(
  value: unknown,
  legacySnapshot = false,
): UpdatePolicy {
  const p = object(value);
  if (
    Object.keys(p).some(
      (k) =>
        ![
          "days",
          "startMinute",
          ...(legacySnapshot ? ["windowMinutes"] : []),
          "automaticReboot",
          "rebootMinute",
        ].includes(k),
    ) ||
    !Array.isArray(p.days) ||
    !p.days.length ||
    p.days.length > 7 ||
    p.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) ||
    !Number.isInteger(p.startMinute) ||
    Number(p.startMinute) < 0 ||
    Number(p.startMinute) > 1439 ||
    typeof p.automaticReboot !== "boolean" ||
    !Number.isInteger(p.rebootMinute) ||
    Number(p.rebootMinute) < 0 ||
    Number(p.rebootMinute) > 1439
  )
    throw new AuthError("INVALID_UPDATE_POLICY");
  if (
    p.windowMinutes !== undefined &&
    (!Number.isInteger(p.windowMinutes) ||
      Number(p.windowMinutes) < 60 ||
      Number(p.windowMinutes) > 360 ||
      Number(p.startMinute) + Number(p.windowMinutes) > 1440 ||
      Number(p.rebootMinute) < Number(p.startMinute) ||
      Number(p.rebootMinute) >= Number(p.startMinute) + Number(p.windowMinutes))
  )
    throw new AuthError("INVALID_UPDATE_POLICY");
  return {
    ...(p.windowMinutes === undefined
      ? {}
      : { windowMinutes: Number(p.windowMinutes) }),
    days: [...new Set(p.days as number[])].sort(),
    startMinute: Number(p.startMinute),
    automaticReboot: p.automaticReboot,
    rebootMinute: Number(p.rebootMinute),
  };
}
function updateSnapshot(value: unknown): UpdateProtection {
  const p = object(value);
  for (const k of [
    "supported",
    "installed",
    "managed",
    "enabled",
    "healthy",
    "busy",
    "rebootRequired",
  ])
    if (typeof p[k] !== "boolean")
      throw new AuthError("INVALID_PROTECTION_SNAPSHOT");
  for (const k of ["lastRunAt", "lastRebootRequestAt"])
    if (p[k] !== null && (!Number.isSafeInteger(p[k]) || Number(p[k]) < 0))
      throw new AuthError("INVALID_PROTECTION_SNAPSHOT");
  return {
    ...(p.scheduleVersion === 2 ? { scheduleVersion: 2 as const } : {}),
    lastRunAt: p.lastRunAt as number | null,
    lastRebootRequestAt: p.lastRebootRequestAt as number | null,
    supported: p.supported as boolean,
    installed: p.installed as boolean,
    managed: p.managed as boolean,
    enabled: p.enabled as boolean,
    healthy: p.healthy as boolean,
    busy: p.busy as boolean,
    rebootRequired: p.rebootRequired as boolean,
    policy: p.policy === null ? null : updatePolicy(p.policy, true),
    detail: text(p.detail, 600, true),
  };
}

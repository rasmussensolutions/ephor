import type { Machine } from "@ephor/api/machines";

export function currentMachineMetrics(machine: Machine, now = Date.now()) {
  return machine.status === "online" &&
    machine.lastSeen !== null &&
    now - machine.lastSeen < 60_000
    ? machine.telemetry
    : null;
}

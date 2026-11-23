import type { SecurityOverview } from "@ephor/api/security";
export function overviewCoverage(data: SecurityOverview, now = Date.now()) {
  const machines = data.machines.filter((m) => m.state === "active");
  const active = new Set(machines.map((m) => m.id));
  const reporting = machines.filter(
    (m) =>
      m.enabled &&
      m.lastSeen &&
      now - m.lastSeen >= 0 &&
      now - m.lastSeen < 30 * 60000,
  );
  const reportingIds = new Set(reporting.map((m) => m.id));
  const services = data.services.filter(
    (s) => active.has(s.machineId) && s.currentDeployment,
  );
  const scanned = services.filter((s) =>
    data.scans.some(
      (scan) =>
        scan.serviceId === s.id &&
        scan.revision === s.currentDeployment &&
        scan.status === "completed" &&
        scan.finishedAt &&
        now - scan.finishedAt >= 0 &&
        now - scan.finishedAt < 26 * 3600000,
    ),
  );
  const maintenance = new Map(
    (data.maintenance ?? []).map((m) => [m.machineId, m]),
  );
  const updateState = machines.map((m) => {
    const scan = maintenance.get(m.id);
    const fresh =
      reportingIds.has(m.id) &&
      scan?.observedAt &&
      now - scan.observedAt >= 0 &&
      now - scan.observedAt < 2 * 3600000 &&
      ["completed", "partial"].includes(scan.status);
    const check = fresh
      ? scan.checks.find((c) => c.key === "maintenance.automatic-updates")
      : undefined;
    const run = fresh
      ? scan.checks.find((c) => c.key === "maintenance.automatic-updates-run")
      : undefined;
    return {
      machine: m,
      check,
      run,
      observedAt: scan?.observedAt ?? null,
      state:
        check?.status === "pass"
          ? "configured"
          : check?.status === "fail"
            ? "attention"
            : "unknown",
    };
  });
  return {
    machines,
    reporting,
    services,
    scanned,
    updateState,
    updatesConfigured: updateState.filter((m) => m.state === "configured")
      .length,
    updatesUnknown: updateState.filter((m) => m.state === "unknown").length,
    findings: Object.values(data.counts).reduce((a, b) => a + b, 0),
    urgent: data.counts.critical + data.counts.high,
  };
}

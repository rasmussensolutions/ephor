import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { MemoryIcon } from "@phosphor-icons/react/dist/csr/Memory";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { SummaryCards } from "@/components/summary-cards";
import {
  bytes,
  type currentMetrics,
  type Service,
  serviceNeedsAttention,
} from "@/lib/services";

export function ServiceSummaryCards({
  rows,
  machines,
  problemsFiltered,
  onToggleProblems,
}: {
  rows: {
    service: Service;
    status: string;
    metrics: ReturnType<typeof currentMetrics>;
  }[];
  machines: { id: string; name: string }[];
  problemsFiltered: boolean;
  onToggleProblems: () => void;
}) {
  const running = rows.filter((row) => row.status === "Running").length;
  const problems = rows.filter((row) => serviceNeedsAttention(row.status));
  const problemCounts = new Map<string, number>();
  for (const { status } of problems)
    problemCounts.set(status, (problemCounts.get(status) ?? 0) + 1);

  let busiest: { service: Service; percent: number } | undefined;
  let memoryReports = 0;
  let memoryUsed = 0;
  let memoryLimit = 0;
  let allLimitsReported = true;
  for (const { service, metrics } of rows) {
    if (!metrics) continue;
    if (
      metrics.cpuPercent != null &&
      (!busiest || metrics.cpuPercent > busiest.percent)
    )
      busiest = { service, percent: metrics.cpuPercent };
    memoryReports++;
    memoryUsed += metrics.memoryBytes;
    if (metrics.memoryLimitBytes > 0) memoryLimit += metrics.memoryLimitBytes;
    else allLimitsReported = false;
  }
  const busiestMachine = machines.find(
    (machine) => machine.id === busiest?.service.machineId,
  );

  return (
    <SummaryCards
      label="Service summary"
      cards={[
        {
          label: "Services running",
          icon: CubeIcon,
          value: `${running} / ${rows.length}`,
          segments: { filled: running, total: rows.length },
          detail: rows.length
            ? running === rows.length
              ? "All services running"
              : `${rows.length - running} not running`
            : "No services yet",
        },
        {
          label: "Needs attention",
          icon: WarningCircleIcon,
          value: String(problems.length),
          detail: problems.length
            ? Array.from(
                problemCounts,
                ([status, count]) => `${count} ${status.toLowerCase()}`,
              ).join(" · ")
            : "No service problems",
          warning: problems.length > 0,
          action: {
            label: "Filter services needing attention",
            pressed: problemsFiltered,
            onClick: onToggleProblems,
          },
        },
        {
          label: "Highest service CPU",
          icon: CpuIcon,
          percent: busiest?.percent,
          detail: busiest
            ? `${busiest.service.name} · ${busiestMachine?.name ?? "Unknown machine"}`
            : "No live CPU reports",
        },
        {
          label: "Total service memory",
          icon: MemoryIcon,
          value: memoryReports ? bytes(memoryUsed) : "—",
          percent:
            allLimitsReported && memoryLimit > 0
              ? Math.min(100, (memoryUsed / memoryLimit) * 100)
              : null,
          detail: memoryReports
            ? `${memoryReports} ${memoryReports === 1 ? "service" : "services"} reporting${allLimitsReported ? ` · ${bytes(memoryLimit)} limit` : ""}`
            : "No live memory reports",
        },
      ]}
    />
  );
}

import { Usage } from "@/components/usage-meter";
import { bytes } from "@/lib/services";

export function ServiceCardUsage({
  metrics,
}: {
  metrics: {
    cpuPercent: number | null;
    memoryBytes: number;
    memoryLimitBytes: number;
  } | null;
}) {
  if (!metrics) return null;
  const cpu = metrics.cpuPercent;
  const memory =
    metrics.memoryLimitBytes > 0
      ? Math.min(100, (metrics.memoryBytes / metrics.memoryLimitBytes) * 100)
      : null;
  if (cpu === null && memory === null) return null;
  return (
    <div
      className={`relative mt-auto grid shrink-0 gap-3 border-t bg-muted/20 px-3 py-2 text-muted-foreground ${cpu !== null && memory !== null ? "grid-cols-2" : "grid-cols-1"}`}
    >
      {cpu !== null && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[11px]">CPU</span>
          <Usage
            compact
            label="CPU"
            percent={cpu}
            detail="Share of whole machine"
          />
        </div>
      )}
      {memory !== null && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[11px]">Memory</span>
          <Usage
            compact
            label="Memory"
            percent={memory}
            detail={`${bytes(metrics.memoryBytes)} / ${bytes(metrics.memoryLimitBytes)} container limit`}
          />
        </div>
      )}
    </div>
  );
}

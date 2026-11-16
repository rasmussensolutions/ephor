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
  return (
    <div className="relative mt-auto grid grid-cols-2 gap-4 border-t bg-muted/20 px-4 py-3 text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px]">CPU</span>
        <Usage
          compact
          label="CPU"
          percent={metrics?.cpuPercent ?? null}
          detail="Share of whole machine"
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px]">Memory</span>
        <Usage
          compact
          label="Memory"
          percent={
            metrics && metrics.memoryLimitBytes > 0
              ? Math.min(
                  100,
                  (metrics.memoryBytes / metrics.memoryLimitBytes) * 100,
                )
              : null
          }
          detail={
            metrics
              ? `${bytes(metrics.memoryBytes)} / ${bytes(metrics.memoryLimitBytes)} container limit`
              : "Unavailable"
          }
        />
      </div>
    </div>
  );
}

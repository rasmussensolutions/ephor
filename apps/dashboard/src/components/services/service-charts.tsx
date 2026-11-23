import type { MetricsHistory } from "@ephor/api/services";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { MemoryIcon } from "@phosphor-icons/react/dist/csr/Memory";
import { NetworkIcon } from "@phosphor-icons/react/dist/csr/Network";
import { useEffect, useState } from "react";
import { MetricChart } from "@/components/metric-chart";
import type { ChartConfig } from "@/components/ui/chart";
import { api } from "@/lib/auth";
import { bytes } from "@/lib/services";

const config = {
  cpuPercent: { label: "CPU", color: "var(--chart-1)" },
  memoryBytes: { label: "Memory", color: "var(--chart-2)" },
  networkRxBytesPerSecond: { label: "Incoming", color: "var(--chart-3)" },
  networkTxBytesPerSecond: { label: "Outgoing", color: "var(--chart-4)" },
} satisfies ChartConfig;
export function ServiceCharts({
  id,
  component,
}: {
  id: string;
  component?: string;
}) {
  const [range, setRange] = useState("1h"),
    [history, setHistory] = useState<MetricsHistory | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setHistory(null);
    setError("");
    const load = async () => {
      if (!document.hidden)
        try {
          const data = await api<MetricsHistory>(
            `/services/${id}${component ? `/components/${encodeURIComponent(component)}` : ""}/metrics?range=${range}`,
          );
          if (active) {
            setHistory(data);
            setError("");
          }
        } catch {
          if (active)
            setError("Could not load metric history. Retrying shortly.");
        }
      if (active) timer = setTimeout(load, 30000);
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, range, component]);
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-medium">Usage</h2>
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {["15m", "1h", "6h", "24h"].map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1 text-xs ${range === r ? "bg-card" : "text-muted-foreground"}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <MetricChart
          layered
          config={config}
          title="CPU"
          icon={CpuIcon}
          fields={["cpuPercent"]}
          history={history}
          format={(v) => `${v.toFixed(1)}%`}
        />
        <MetricChart
          layered
          config={config}
          title="Memory"
          icon={MemoryIcon}
          fields={["memoryBytes"]}
          history={history}
          format={bytes}
        />
        <div className="xl:col-span-2">
          <MetricChart
            layered
            config={config}
            title="Network"
            icon={NetworkIcon}
            fields={["networkRxBytesPerSecond", "networkTxBytesPerSecond"]}
            history={history}
            format={(v) => `${bytes(v)}/s`}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        24-hour rolling history, sampled once per minute. Longer ranges average
        samples. Missing reports appear as gaps.
      </p>
    </section>
  );
}

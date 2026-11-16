import type { MachineMetricsHistory } from "@ephor/api/machines";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { HardDriveIcon } from "@phosphor-icons/react/dist/csr/HardDrive";
import { MemoryIcon } from "@phosphor-icons/react/dist/csr/Memory";
import { useEffect, useState } from "react";
import { MetricChart } from "@/components/metric-chart";
import { api } from "@/lib/auth";
import { bytes } from "@/lib/services";

const config = {
  cpuPercent: { label: "CPU", color: "var(--chart-1)" },
  memoryBytes: { label: "Memory", color: "var(--chart-2)" },
  diskPercent: { label: "Root disk", color: "var(--chart-3)" },
};
const percent = (value: number) => `${value.toFixed(1)}%`;
export function MachineCharts({ id }: { id: string }) {
  const [range, setRange] = useState("24h");
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Resource history</h2>
        <fieldset
          aria-label="Metric time range"
          className="flex gap-1 rounded-lg bg-muted p-1"
        >
          {["15m", "1h", "6h", "24h"].map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={range === value}
              onClick={() => setRange(value)}
              className={`rounded-md px-3 py-1 text-xs ${range === value ? "bg-card" : "text-muted-foreground"}`}
            >
              {value}
            </button>
          ))}
        </fieldset>
      </div>
      <History key={`${id}-${range}`} id={id} range={range} />
    </section>
  );
}
function History({ id, range }: { id: string; range: string }) {
  const [history, setHistory] = useState<MachineMetricsHistory | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (!document.hidden) {
        try {
          const next = await api<MachineMetricsHistory>(
            `/machines/${id}/metrics?range=${range}`,
          );
          if (active) {
            setHistory(next);
            setError("");
          }
        } catch {
          if (active)
            setError(
              "Could not refresh metric history. Values may be out of date. Retrying automatically.",
            );
        }
      }
      if (active) timer = setTimeout(load, 30000);
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, range]);
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <MetricChart
          layered
          title="CPU"
          icon={CpuIcon}
          config={config}
          fields={["cpuPercent"]}
          history={history}
          format={percent}
          emptyMessage="No CPU samples in this period. Waiting for machine reports."
        />
        <MetricChart
          layered
          title="Memory"
          icon={MemoryIcon}
          config={config}
          fields={["memoryBytes"]}
          history={history}
          format={bytes}
          emptyMessage="No memory samples in this period. Waiting for machine reports."
        />
        <div className="xl:col-span-2">
          <MetricChart
            layered
            title="Root disk /"
            icon={HardDriveIcon}
            config={config}
            fields={["diskPercent"]}
            history={history}
            format={percent}
            emptyMessage="No root filesystem samples in this period."
          />
        </div>
      </div>
    </>
  );
}

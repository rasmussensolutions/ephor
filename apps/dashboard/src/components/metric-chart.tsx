import type { Icon } from "@phosphor-icons/react";
import { useId } from "react";
import { Area, AreaChart, XAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

const time = (value: number) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

export function MetricChart<K extends string>({
  title,
  icon: TitleIcon,
  config,
  emptyMessage = "No samples in this period. Metrics appear after the worker reports.",
  fields,
  history,
  format,
  layered = false,
}: {
  title: string;
  icon?: Icon;
  fields: K[];
  config: ChartConfig;
  emptyMessage?: string;
  history: {
    from: number;
    to: number;
    points: ({ timestamp: number } & Record<K, number | null>)[];
  } | null;
  format: (v: number) => string;
  layered?: boolean;
}) {
  const uid = useId().replaceAll(":", "");
  const hasData = history?.points.some((p) =>
    fields.some((f) => p[f] !== null),
  );
  const latest = history?.points.at(-1);
  return (
    <div
      className={
        layered
          ? "flex min-w-0 flex-col overflow-hidden rounded-lg bg-transparent ring-1 ring-border"
          : "min-w-0 rounded-xl border bg-card p-5"
      }
    >
      <div
        className={`flex flex-wrap items-center justify-between gap-3 ${layered ? "px-4 py-2" : "mb-6"}`}
      >
        <h3
          className={`flex items-center gap-2 text-sm font-medium ${layered ? "text-muted-foreground" : ""}`}
        >
          {TitleIcon && (
            <TitleIcon aria-hidden="true" className="size-4 shrink-0" />
          )}
          {title}
        </h3>
        <div className="flex gap-4 text-xs">
          {fields.map((f) => (
            <span
              key={f}
              className="flex items-center gap-1.5 text-muted-foreground"
            >
              <span
                className="size-2 rounded-full"
                style={{ background: config[f]?.color }}
              />
              {fields.length > 1 && config[f]?.label}{" "}
              <span className="font-mono text-foreground">
                {latest?.[f] != null ? format(latest[f]) : "—"}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div
        className={
          layered
            ? "relative min-w-0 rounded-lg bg-card ring-1 ring-border"
            : undefined
        }
      >
        {hasData && history ? (
          <ChartContainer
            dottedGrid
            config={config}
            className="aspect-auto h-60 w-full"
          >
            <AreaChart
              accessibilityLayer
              data={history.points}
              margin={{ left: 0, right: 0, top: 8, bottom: 0 }}
            >
              <defs>
                {fields.map((f) => (
                  <linearGradient
                    key={f}
                    id={`${uid}-${f}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      stopColor={`var(--color-${f})`}
                      stopOpacity={0.25}
                    />
                    <stop
                      offset="100%"
                      stopColor={`var(--color-${f})`}
                      stopOpacity={0.01}
                    />
                  </linearGradient>
                ))}
              </defs>
              <XAxis
                hide
                dataKey="timestamp"
                type="number"
                domain={["dataMin", "dataMax"]}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_label, payload) => {
                      const timestamp = payload[0]?.payload?.timestamp;
                      return typeof timestamp === "number" &&
                        Number.isFinite(timestamp)
                        ? time(timestamp)
                        : "—";
                    }}
                    formatter={(value, name) => (
                      <div className="flex w-full justify-between gap-6">
                        <span className="text-muted-foreground">
                          {config[name as K]?.label}
                        </span>
                        <span className="font-mono">
                          {typeof value === "number" ? format(value) : "—"}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              {fields.map((f) => (
                <Area
                  key={f}
                  dataKey={f}
                  type="linear"
                  stroke={`var(--color-${f})`}
                  fill={`url(#${uid}-${f})`}
                  strokeWidth={1.75}
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={
                    history.points.filter((p) => p[f] !== null).length === 1
                      ? { r: 3 }
                      : false
                  }
                />
              ))}
            </AreaChart>
          </ChartContainer>
        ) : (
          <div className="flex h-60 items-center justify-center text-center text-sm text-muted-foreground">
            {!history ? "Loading metrics…" : emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}

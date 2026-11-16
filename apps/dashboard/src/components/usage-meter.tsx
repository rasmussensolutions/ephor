const usageSegmentPositions = Array.from(
  { length: 20 },
  (_, index) => index * 6,
);
const smallUsageSegmentPositions = Array.from(
  { length: 12 },
  (_, index) => index * 5,
);

export function Usage({
  label,
  percent,
  detail,
  compact = false,
  size = "default",
}: {
  label: string;
  percent: number | null;
  detail: string;
  compact?: boolean;
  size?: "default" | "sm";
}) {
  if (percent === null)
    return (
      <span className="text-muted-foreground" title={`${label} unavailable`}>
        —
      </span>
    );
  const segmentPositions =
    size === "sm" ? smallUsageSegmentPositions : usageSegmentPositions;
  const barWidth = size === "sm" ? 59 : 118;
  const filledSegments = Math.ceil((percent / 100) * segmentPositions.length);
  const fillColor =
    percent >= 90
      ? "text-destructive"
      : percent >= 60
        ? "text-amber-500"
        : "text-blue-500";

  return (
    <div
      className={`flex items-center whitespace-nowrap ${size === "sm" ? "gap-2" : "gap-3"} ${compact ? "min-w-0 flex-1" : size === "sm" ? "min-w-28" : "min-w-44"}`}
      title={`${label}: ${percent.toFixed(1)}% · ${detail}`}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        width={barWidth}
        height={12}
        viewBox={`0 0 ${barWidth} 12`}
        preserveAspectRatio={compact || size === "sm" ? "none" : undefined}
        className={`${compact || size === "sm" ? "min-w-0 flex-1" : "shrink-0"} ${fillColor}`}
      >
        {segmentPositions.map((x, index) => {
          const filled = index < filledSegments;
          const nearTip = index >= filledSegments - 3;
          return (
            <rect
              key={x}
              x={x}
              width={4}
              height={12}
              rx={0.5}
              fill={filled ? "currentColor" : "var(--foreground)"}
              opacity={filled ? (nearTip ? 1 : 0.45) : 0.12}
            />
          );
        })}
      </svg>
      <span
        className={
          compact
            ? "sr-only"
            : "ml-auto min-w-[6ch] shrink-0 text-right font-mono text-xs tabular-nums"
        }
      >
        <span className="sr-only">{label}: </span>
        {percent.toFixed(1)}%
      </span>
    </div>
  );
}

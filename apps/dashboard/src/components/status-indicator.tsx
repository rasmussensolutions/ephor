import { cn } from "cn";

const colors = {
  healthy: "text-emerald-700 dark:text-emerald-400",
  busy: "text-blue-500",
  error: "text-destructive",
  neutral: "text-muted-foreground",
};
export function StatusIndicator({
  status,
  tone,
  badge = false,
}: {
  status: string;
  tone: keyof typeof colors;
  badge?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap text-xs",
        colors[tone],
        badge && "rounded-full border px-3 py-1.5",
      )}
      style={
        badge
          ? {
              backgroundColor:
                "color-mix(in srgb, currentColor 10%, transparent)",
              borderColor: "color-mix(in srgb, currentColor 20%, transparent)",
            }
          : undefined
      }
    >
      <span
        aria-hidden
        className="relative inline-flex size-3.5 shrink-0 items-center justify-center"
      >
        <span className="absolute inset-0 rounded-full border-2 border-current opacity-20" />
        <span className="size-1.5 rounded-full bg-current" />
      </span>
      {status}
    </span>
  );
}

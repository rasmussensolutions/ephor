import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
export function SecurityLayer({
  title,
  icon: Icon,
  action,
  children,
  className = "",
}: {
  title: string;
  icon: Icon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={`min-w-0 overflow-hidden rounded-lg ring-1 ring-border ${className}`}
    >
      <header className="flex min-h-10 items-center justify-between gap-3 px-4 py-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon aria-hidden className="size-4 shrink-0" />
          {title}
        </h2>
        {action}
      </header>
      <div className="rounded-lg bg-card ring-1 ring-border">{children}</div>
    </section>
  );
}
export function BlueIndicator({
  filled,
  total,
}: {
  filled: number;
  total: number;
}) {
  const count = 40;
  const lit =
    total > 0
      ? filled > 0
        ? Math.max(1, Math.round((Math.min(filled, total) / total) * count))
        : 0
      : 0;
  return (
    <div aria-hidden="true" className="flex h-3 gap-1">
      {Array.from({ length: count }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: These fixed-position visual ticks never hold state or reorder.
          key={`tick-${i}`}
          className={`min-w-0 flex-1 rounded-[1px] ${i < lit ? "bg-blue-500 dark:bg-blue-400" : "bg-foreground/10"}`}
        />
      ))}
    </div>
  );
}

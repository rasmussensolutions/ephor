import type { Icon } from "@phosphor-icons/react";
import { Usage } from "@/components/usage-meter";

export interface SummaryCard {
  label: string;
  icon: Icon;
  value?: string;
  percent?: number | null;
  detail: string;
  warning?: boolean;
  segments?: { filled: number; total: number };
  action?: { label: string; pressed?: boolean; onClick: () => void };
}

export function SummaryCards({
  label,
  cards,
}: {
  label: string;
  cards: SummaryCard[];
}) {
  return (
    <section
      aria-label={label}
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      {cards.map(({ icon: Icon, ...card }) => (
        <div
          key={card.label}
          className="relative flex min-w-0 flex-col overflow-hidden rounded-lg bg-transparent ring-1 ring-border"
        >
          <h2 className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground">
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            {card.label}
          </h2>
          <div className="flex flex-1 flex-col gap-3 rounded-lg bg-card p-4 ring-1 ring-border">
            <p className="text-3xl font-medium tracking-tight tabular-nums">
              {card.value ??
                (card.percent == null ? "—" : `${card.percent.toFixed(1)}%`)}
            </p>
            <div className="flex h-3 items-center" aria-hidden="true">
              {card.segments ? (
                <div
                  className="flex h-3 min-w-0 flex-1"
                  style={{
                    gap: `min(4px, ${20 / Math.max(1, card.segments.total)}%)`,
                  }}
                >
                  {Array.from(
                    { length: Math.max(1, card.segments.total) },
                    (_, index) => index,
                  ).map((index) => (
                    <span
                      key={`segment-${index}`}
                      className={`h-full min-w-0 flex-1 rounded-[0.5px] ${index < (card.segments?.filled ?? 0) ? "bg-emerald-700 dark:bg-emerald-400" : "bg-foreground/12"}`}
                    />
                  ))}
                </div>
              ) : (
                card.percent != null && (
                  <Usage
                    label={card.label}
                    percent={card.percent}
                    detail={card.detail}
                    compact
                  />
                )
              )}
            </div>
            <p
              className={`truncate text-xs ${card.warning ? "text-amber-500" : "text-muted-foreground"}`}
              title={card.detail}
            >
              {card.detail}
            </p>
          </div>
          {card.action && (
            <button
              type="button"
              aria-label={card.action.label}
              aria-pressed={card.action.pressed}
              title={card.detail}
              onClick={card.action.onClick}
              className="absolute inset-0 cursor-pointer rounded-lg outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-ring"
            />
          )}
        </div>
      ))}
    </section>
  );
}

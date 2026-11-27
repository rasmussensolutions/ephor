import type { ReactNode } from "react";

export const serviceCardActionClass =
  "cursor-grab rounded-lg outline-none transition-colors hover:bg-muted/20 active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export function ServiceCardFrame({
  name,
  icon,
  action,
  renderMain,
  footer,
  children,
}: {
  name: string;
  icon: ReactNode;
  action?: ReactNode;
  renderMain?: (content: ReactNode) => ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const content = (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-sm font-semibold">
        <span className="flex shrink-0 items-center" aria-hidden="true">
          {icon}
        </span>
        <h3 className="truncate" title={name}>
          {name}
        </h3>
      </div>
      {children}
    </>
  );
  return (
    <div className="relative isolate flex size-full min-w-0 flex-col overflow-hidden rounded-lg bg-muted text-card-foreground ring-1 ring-border before:pointer-events-none before:absolute before:inset-x-0 before:top-9 before:bottom-0 before:-z-10 before:rounded-lg before:bg-card before:ring-1 before:ring-border dark:bg-background">
      {action}
      {renderMain ? (
        renderMain(content)
      ) : (
        <div className="pointer-events-none relative flex min-h-0 flex-1 flex-col">
          {content}
        </div>
      )}
      {footer}
    </div>
  );
}

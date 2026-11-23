import type { ActivityList } from "@ephor/api/activity";
import type { Machine } from "@ephor/api/machines";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { MachineStatus } from "@/components/machines/machine-status";
import { StatusIndicator } from "@/components/status-indicator";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Usage } from "@/components/usage-meter";
import {
  type AttentionItem,
  activityHref,
  currentMachineStatus,
} from "@/lib/home-overview";
import type { ServiceList } from "@/lib/services";

const textLink =
  "inline-flex shrink-0 items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function HomeAttention({ items }: { items: AttentionItem[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  return (
    <section
      aria-labelledby="attention-title"
      className="overflow-hidden rounded-lg ring-1 ring-border"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-2">
        <h2
          id="attention-title"
          className="flex items-center gap-2 text-sm font-medium"
        >
          <WarningCircleIcon aria-hidden className="size-4 text-amber-500" />
          Needs attention
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </header>
      <ul className="divide-y rounded-lg bg-card ring-1 ring-border">
        {(expanded ? items : items.slice(0, 5)).map((item) => (
          <li key={item.id}>
            <Link
              to={item.href}
              className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-muted/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <WarningCircleIcon
                aria-hidden
                className={`size-5 shrink-0 ${item.severity === "error" ? "text-destructive" : "text-amber-500"}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {item.detail}
                </p>
              </div>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {item.action}
              </span>
              <ArrowRightIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
            </Link>
          </li>
        ))}
      </ul>
      {items.length > 5 && (
        <div className="bg-card px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {expanded ? "Show fewer" : `Show all ${items.length} items`}
          </Button>
        </div>
      )}
    </section>
  );
}

export function HomeMachines({
  machines,
  now,
  available,
}: {
  machines: Machine[];
  now: number;
  available: boolean;
}) {
  return (
    <section
      aria-labelledby="home-machines-title"
      className="min-w-0 overflow-hidden rounded-lg bg-transparent ring-1 ring-border"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-2">
        <h2
          id="home-machines-title"
          className="text-sm font-medium text-muted-foreground"
        >
          Machines at a glance
        </h2>
        <Link to="/machines" className={textLink}>
          View all machines
          <ArrowRightIcon aria-hidden className="size-3.5" />
        </Link>
      </header>
      <div className="rounded-lg bg-card ring-1 ring-border">
        {!machines.length ? (
          <div className="px-6 py-12 text-center">
            <HardDrivesIcon
              aria-hidden
              className="mx-auto mb-3 size-7 text-muted-foreground"
            />
            <p className="text-sm font-medium">
              {available
                ? "No machines connected"
                : "Machine status unavailable"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {available
                ? "Connect a machine to see its health and resource usage."
                : "Try refreshing to load your machines."}
            </p>
          </div>
        ) : (
          <Table aria-label="Machine health and resource usage">
            <TableHeader>
              <TableRow>
                <TableHead>Machine</TableHead>
                <TableHead>CPU</TableHead>
                <TableHead>Memory</TableHead>
                <TableHead>Disk</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {machines.slice(0, 6).map((machine) => {
                const status = currentMachineStatus(machine, now);
                const metrics = status === "online" ? machine.telemetry : null;
                const root = metrics?.disks.find((disk) => disk.mount === "/");
                return (
                  <TableRow key={machine.id}>
                    <TableCell className="min-w-40">
                      <Link
                        to="/machines/$machineId"
                        params={{ machineId: machine.id }}
                        className="block rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <p
                          className="max-w-48 truncate font-medium hover:underline"
                          title={machine.name}
                        >
                          {machine.name}
                        </p>
                        <div className="mt-1.5">
                          <MachineStatus status={status} />
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Usage
                        label="CPU"
                        percent={metrics?.cpuPercent ?? null}
                        detail={machine.name}
                        size="sm"
                      />
                    </TableCell>
                    <TableCell>
                      <Usage
                        label="Memory"
                        percent={
                          metrics && metrics.memoryTotal > 0
                            ? (metrics.memoryUsed / metrics.memoryTotal) * 100
                            : null
                        }
                        detail={machine.name}
                        size="sm"
                      />
                    </TableCell>
                    <TableCell>
                      <Usage
                        label="Root disk"
                        percent={
                          root && root.total > 0
                            ? (root.used / root.total) * 100
                            : null
                        }
                        detail="Root filesystem"
                        size="sm"
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {machines.length > 6 && (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            Showing 6 of {machines.length} machines. Machines needing attention
            appear first.
          </p>
        )}
      </div>
    </section>
  );
}

export function HomeActivity({
  activity,
  machines,
  services,
}: {
  activity: ActivityList | null;
  machines: Machine[];
  services: ServiceList | null;
}) {
  return (
    <section
      aria-labelledby="home-activity-title"
      className="min-w-0 overflow-hidden rounded-lg bg-transparent ring-1 ring-border"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-2">
        <h2
          id="home-activity-title"
          className="text-sm font-medium text-muted-foreground"
        >
          Recent activity
        </h2>
        <Link to="/activity" className={textLink}>
          View all activity
          <ArrowRightIcon aria-hidden className="size-3.5" />
        </Link>
      </header>
      <div className="rounded-lg bg-card ring-1 ring-border">
        {!activity?.items.length ? (
          <div className="px-6 py-12 text-center">
            <ClockCounterClockwiseIcon
              aria-hidden
              className="mx-auto mb-3 size-7 text-muted-foreground"
            />
            <p className="text-sm font-medium">
              {activity ? "No activity yet" : "Activity unavailable"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {activity
                ? "Your latest panel actions will appear here."
                : "Try refreshing to load recent activity."}
            </p>
          </div>
        ) : (
          <ul className="divide-y">
            {activity.items.slice(0, 5).map((item) => (
              <li key={item.id}>
                <Link
                  to={activityHref(item, machines, services)}
                  className="block px-4 py-4 transition-colors hover:bg-muted/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <p className="text-sm font-medium">
                    {item.action.includes(".")
                      ? item.action
                          .replace(/[._]/g, " ")
                          .replace(/^./, (letter) => letter.toUpperCase())
                      : item.action}
                  </p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {item.target.name ?? item.actor.name}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <StatusIndicator
                      status={
                        {
                          succeeded: "Request succeeded",
                          failed: "Request failed",
                          pending: "Unconfirmed",
                          unknown: "Historical",
                        }[item.outcome]
                      }
                      tone={
                        item.outcome === "succeeded"
                          ? "healthy"
                          : item.outcome === "failed"
                            ? "error"
                            : "neutral"
                      }
                    />
                    <time
                      className="text-xs text-muted-foreground"
                      dateTime={new Date(item.occurredAt).toISOString()}
                      title={new Date(item.occurredAt).toLocaleString()}
                    >
                      {new Date(item.occurredAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function HomeSetup({
  connected,
  deployed,
  configured,
}: {
  connected: boolean;
  deployed: boolean;
  configured: boolean;
}) {
  const steps = [
    {
      title: "Connect your first machine",
      detail: "Add a Linux server to start managing it.",
      complete: connected,
    },
    {
      title: "Deploy a service",
      detail: "Choose a repository, image, or template.",
      complete: deployed,
    },
    {
      title: "Configure backups",
      detail: "Protect a supported app with off-site copies.",
      complete: configured,
    },
  ];
  return (
    <section
      aria-labelledby="home-setup-title"
      className="overflow-hidden rounded-lg ring-1 ring-border"
    >
      <header className="px-4 py-2">
        <h2 id="home-setup-title" className="text-sm font-medium">
          Get started with Ephor
        </h2>
      </header>
      <div className="rounded-lg bg-card p-4 ring-1 ring-border">
        <ol className="grid gap-5 sm:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              {step.complete ? (
                <CheckCircleIcon
                  aria-label="Complete"
                  className="mt-0.5 size-5 shrink-0 text-emerald-700 dark:text-emerald-400"
                />
              ) : (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground">
                  {index + 1}
                </span>
              )}
              <div>
                <p className="text-sm font-medium">{step.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {step.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-5">
          {!connected ? (
            <Button
              nativeButton={false}
              variant="gradient"
              render={<Link to="/machines" search={{ connect: true }} />}
            >
              Connect machine
            </Button>
          ) : !deployed ? (
            <Button
              nativeButton={false}
              variant="gradient"
              render={<Link to="/services/new" />}
            >
              Deploy service
            </Button>
          ) : (
            <Button
              nativeButton={false}
              variant="gradient"
              render={<Link to="/settings/backups" />}
            >
              Configure backups
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

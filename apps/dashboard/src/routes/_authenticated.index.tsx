import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { RocketLaunchIcon } from "@phosphor-icons/react/dist/csr/RocketLaunch";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  HomeActivity,
  HomeAttention,
  HomeMachines,
  HomeSetup,
} from "@/components/home-sections";
import { StatusIndicator } from "@/components/status-indicator";
import { SummaryCards } from "@/components/summary-cards";
import { Button } from "@/components/ui/button";
import { loadHomeOverview, useHomeOverview } from "@/hooks/use-home-overview";
import { homeOverview } from "@/lib/home-overview";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({ meta: [{ title: "Home — Ephor" }] }),
  loader: loadHomeOverview,
  component: HomePage,
});

function HomePage() {
  const { data, now, refreshing, refresh } = useHomeOverview(
    Route.useLoaderData(),
  );
  const navigate = useNavigate();
  const machines = data.machines.data?.machines ?? [];
  const services = data.services.data;
  const backups = data.backups.data;
  const overview = homeOverview(machines, services, backups, now);
  const unavailable = Object.entries(data)
    .filter(
      ([, resource]) =>
        resource.error ||
        resource.updatedAt === null ||
        now - resource.updatedAt > 45_000,
    )
    .map(([key]) => key);
  const connected = overview.machines.some(
    (machine) => machine.enrolledAt !== null,
  );
  const deployed = Boolean(
    services?.services.some((service) => service.currentDeployment !== null),
  );
  const configured = Boolean(backups?.plans.length);
  const setup = !connected || !deployed || !configured;
  const waiting = overview.machines.some((m) =>
    ["pending", "connecting"].includes(m.status),
  );
  const unconfirmed =
    overview.unknownServices > 0 ||
    overview.pendingBackups > 0 ||
    overview.machines.some((m) => m.status === "online" && !m.telemetry) ||
    Boolean(
      backups?.destinations.some(
        (d) => d.status !== "ready" && d.status !== "failed",
      ),
    );
  const incomplete =
    unavailable.length > 0 || waiting || unconfirmed || !connected;
  const status = unavailable.length
    ? "Some status is unavailable"
    : overview.attention.length
      ? `${overview.attention.length} ${overview.attention.length === 1 ? "item needs" : "items need"} attention`
      : !connected
        ? "Connect a machine to get started"
        : waiting || unconfirmed
          ? "Waiting for status reports"
          : "All reported systems healthy";
  const timestamps = Object.values(data).flatMap((r) =>
    r.updatedAt === null ? [] : [r.updatedAt],
  );
  const checkedAt = timestamps.length ? Math.min(...timestamps) : null;
  const backupProblems = overview.attention.filter(
    (item) => item.id.startsWith("backup:") || item.id.startsWith("storage:"),
  ).length;

  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Home</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your infrastructure, its health, and what needs attention.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            nativeButton={false}
            variant="outline"
            size="action"
            render={<Link to="/machines" search={{ connect: true }} />}
          >
            Connect machine
          </Button>
          <Button
            nativeButton={false}
            variant="gradient"
            size="action"
            render={<Link to="/services" search={{ deploy: true }} />}
          >
            <PlusIcon
              aria-hidden
              data-icon="inline-start"
              className="size-[1em]"
            />
            Deploy service
          </Button>
        </div>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="status">
          <StatusIndicator
            status={status}
            tone={
              unavailable.length
                ? "neutral"
                : overview.attention.length
                  ? "error"
                  : incomplete
                    ? "neutral"
                    : "healthy"
            }
          />
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            {checkedAt ? (
              <>
                Last refreshed{" "}
                <time dateTime={new Date(checkedAt).toISOString()}>
                  {new Date(checkedAt).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
              </>
            ) : (
              "No reports received"
            )}
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh overview"
            disabled={refreshing}
            onClick={refresh}
          >
            <ArrowClockwiseIcon
              aria-hidden
              className={refreshing ? "animate-spin" : ""}
            />
          </Button>
        </div>
      </div>
      {unavailable.length > 0 && (
        <p
          role="alert"
          className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          Could not confirm the latest {unavailable.join(", ")} status.
          Available reports remain visible and may be out of date. Retrying
          automatically.
        </p>
      )}
      <SummaryCards
        label="Infrastructure summary"
        cards={[
          {
            label: "Machines online",
            icon: HardDrivesIcon,
            value: data.machines.data
              ? `${overview.online} / ${overview.machines.length}`
              : "—",
            segments: data.machines.data
              ? { filled: overview.online, total: overview.machines.length }
              : undefined,
            detail: data.machines.error
              ? "Latest status unavailable"
              : !overview.machines.length
                ? "No machines yet"
                : overview.online === overview.machines.length
                  ? "All machines online"
                  : `${overview.machines.length - overview.online} offline or awaiting connection`,
            action: {
              label: "View machines",
              onClick: () => void navigate({ to: "/machines" }),
            },
          },
          {
            label: "Services running",
            icon: StackIcon,
            value:
              services && data.machines.data
                ? `${overview.running} / ${services.services.length}`
                : "—",
            segments:
              services && data.machines.data
                ? { filled: overview.running, total: services.services.length }
                : undefined,
            detail:
              data.services.error || data.machines.error
                ? "Latest status unavailable"
                : !services?.services.length
                  ? "No services yet"
                  : overview.running === services.services.length
                    ? "All services running"
                    : `${services.services.length - overview.running} not confirmed running`,
            action: {
              label: "View services",
              onClick: () => void navigate({ to: "/services" }),
            },
          },
          {
            label: "Deployments in progress",
            icon: RocketLaunchIcon,
            value: services ? String(overview.deploying) : "—",
            detail: data.services.error
              ? "Latest status unavailable"
              : overview.deploying
                ? "Services building or deploying"
                : "No deployments in progress",
            action: {
              label: "View deployments in services",
              onClick: () => void navigate({ to: "/services" }),
            },
          },
          {
            label: "Backup health",
            icon: ArchiveIcon,
            value: backups
              ? backups.plans.length
                ? `${overview.verifiedBackups} / ${backups.plans.length}`
                : "Not set up"
              : "—",
            segments: backups?.plans.length
              ? {
                  filled: overview.verifiedBackups,
                  total: backups.plans.length,
                }
              : undefined,
            detail: data.backups.error
              ? "Latest status unavailable"
              : backupProblems
                ? `${backupProblems} backup ${backupProblems === 1 ? "issue" : "issues"} to review`
                : !backups?.plans.length
                  ? "Configure off-site backups"
                  : overview.pendingBackups
                    ? "Waiting for verified backups"
                    : "Plans with verified backups",
            warning: backupProblems > 0,
            action: {
              label: "View backup settings",
              onClick: () => void navigate({ to: "/settings/backups" }),
            },
          },
        ]}
      />
      {setup && data.machines.data && services && backups && (
        <HomeSetup
          connected={connected}
          deployed={deployed}
          configured={configured}
        />
      )}
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <HomeAttention items={overview.attention} incomplete={incomplete} />
          <HomeMachines
            machines={overview.machines}
            now={now}
            available={data.machines.data !== null}
          />
        </div>
        <HomeActivity
          activity={data.activity.data}
          machines={machines}
          services={services}
        />
      </div>
    </div>
  );
}

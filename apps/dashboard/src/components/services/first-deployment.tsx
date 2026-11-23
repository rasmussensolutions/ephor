import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { TerminalIcon } from "@phosphor-icons/react/dist/csr/Terminal";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { useEffect, useMemo, useRef, useState } from "react";
import { BuildDiagnose } from "@/components/services/build-diagnosis";
import { ServiceIcon } from "@/components/services/service-icon";
import { Button, buttonVariants } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth";
import { firstDeploymentProgress } from "@/lib/first-deployment";
import { formatLogLines, type LogTone } from "@/lib/log-format";
import { primaryComponent } from "@/lib/service-map";
import { type Service, type ServiceList, uptime } from "@/lib/services";

export function FirstDeployment({
  service,
  data,
  machineName,
  busy,
  canDeploy,
  error,
  notice,
  onDeploy,
  onOpen,
}: {
  service: Service;
  data: ServiceList;
  machineName: string;
  busy: boolean;
  canDeploy: boolean;
  error: string;
  notice: string;
  onDeploy: () => void;
  onOpen: (
    section: "Overview" | "Settings" | "Setup & data" | "Domains",
  ) => void;
}) {
  const progress = firstDeploymentProgress(service, data);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!progress.active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [progress.active]);
  const title = progress.succeeded
    ? `${service.name} is ready`
    : progress.failed
      ? "Deployment failed"
      : progress.cancelled
        ? "Build stopped"
        : progress.active
          ? `Deploying ${service.name}`
          : `Deploy ${service.name}`;
  const primary = primaryComponent(service);
  const startupLogs = service.runtime?.catalog?.components.length
    ? service.runtime.catalog.components
        .filter((component) => component.logs)
        .map((component) => `── ${component.name} ──\n${component.logs}`)
        .join("\n\n")
    : (service.runtime?.logs ?? "");
  const configuration = service.spec.catalog ? "Setup & data" : "Settings";
  const steps = [
    "Preparing",
    service.source.type === "github" ? "Building" : "Build skipped",
    "Starting",
    "Ready",
  ];
  const elapsed = progress.startedAt
    ? uptime(
        Math.max(0, ((progress.finishedAt ?? now) - progress.startedAt) / 1000),
      )
    : null;
  return (
    <div className="min-w-0 space-y-8">
      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => onOpen(configuration)}>
          Configuration
        </Button>
      </div>
      <header className="space-y-5">
        <div className="flex items-center gap-3">
          <ServiceIcon
            source={service.source}
            image={service.spec.image}
            size={24}
          />
          <div className="min-w-0">
            <p className="truncate font-medium">{service.name}</p>
            <p
              className="truncate text-sm text-muted-foreground"
              title={machineName}
            >
              {service.source.type === "github"
                ? `${service.source.repository} · ${service.source.branch}`
                : service.source.type === "catalog"
                  ? service.source.template
                  : "Container image"}
              {" · "}
              {machineName}
            </p>
          </div>
        </div>
        <div role="status" className="space-y-2">
          <h1 className="page-title break-words">{title}</h1>
          <p className="text-sm text-muted-foreground">{progress.detail}</p>
        </div>
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && progress.id === "pending" && (
        <p role="status" className="rounded-lg border bg-card p-4 text-sm">
          {notice}
        </p>
      )}
      <ol
        aria-label="Deployment progress"
        className="grid grid-cols-2 gap-4 rounded-xl border bg-card p-5 sm:grid-cols-4"
      >
        {steps.map((step, index) => {
          const complete = progress.succeeded || index < progress.stage;
          const current = index === progress.stage && !progress.succeeded;
          const stopped = current && (progress.failed || progress.cancelled);
          return (
            <li
              key={step}
              aria-current={current ? "step" : undefined}
              className="flex items-center gap-3"
            >
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-full ${complete ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : stopped ? "bg-destructive/10 text-destructive" : current ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
              >
                {complete ? (
                  <CheckIcon aria-hidden="true" size={16} weight="bold" />
                ) : stopped ? (
                  <XIcon aria-hidden="true" size={16} />
                ) : current && progress.active ? (
                  <CircleNotchIcon
                    aria-hidden="true"
                    size={16}
                    className="motion-safe:animate-spin"
                  />
                ) : (
                  <span className="text-xs">{index + 1}</span>
                )}
              </span>
              <div>
                <p
                  className={`text-sm ${current || complete ? "font-medium" : "text-muted-foreground"}`}
                >
                  {step}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {complete
                    ? "Complete"
                    : stopped
                      ? progress.failed
                        ? "Failed"
                        : "Stopped"
                      : current
                        ? progress.active
                          ? "In progress"
                          : "Waiting"
                        : "Pending"}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <DeploymentOutput
          key={progress.id}
          serviceId={service.id}
          failedBuildId={
            progress.build?.status === "failed" ? progress.build.id : undefined
          }
          buildLogs={progress.build?.logs ?? ""}
          startupLogs={
            progress.deployment &&
            service.runtimeAt >= progress.deployment.created_at
              ? startupLogs
              : ""
          }
          error={progress.error ? errorMessage(progress.error) : ""}
          elapsed={elapsed}
          active={progress.active}
          hasBuild={service.source.type === "github"}
        />
        <aside className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-3 border-b px-5 py-3">
            <div aria-hidden="true" className="flex gap-1.5">
              <span className="size-2 rounded-full bg-border" />
              <span className="size-2 rounded-full bg-border" />
              <span className="size-2 rounded-full bg-border" />
            </div>
            <span className="truncate text-xs text-muted-foreground">
              {service.domain ?? "Your service"}
            </span>
          </div>
          <div className="flex min-h-64 flex-col items-center justify-center gap-4 px-6 py-9 text-center">
            <div
              className={`flex size-16 items-center justify-center rounded-2xl border ${progress.succeeded ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted/50"}`}
            >
              {progress.succeeded ? (
                <CheckIcon size={28} />
              ) : (
                <ServiceIcon
                  source={service.source}
                  image={service.spec.image}
                  size={28}
                />
              )}
            </div>
            <div className="space-y-2">
              <h2 className="font-medium">
                {progress.succeeded
                  ? "Your service is ready"
                  : progress.failed
                    ? "Let’s get this running"
                    : "Your first launch"}
              </h2>
              <p className="max-w-64 text-sm leading-relaxed text-muted-foreground">
                {progress.succeeded
                  ? service.domain
                    ? "Deployment is complete. Open your app to see it in action."
                    : service.spec.catalog
                      ? "Open your service for access details, credentials, and next steps."
                      : "Add a domain to make your app accessible from the web."
                  : progress.failed
                    ? "The error and available output are shown alongside. Your configuration is saved."
                    : "Follow the progress here. You can leave this page and come back at any time."}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 border-t bg-muted/30 p-5">
            {progress.succeeded ? (
              <>
                {service.domain && (
                  <a
                    href={`https://${service.domain}`}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonVariants({
                      variant: "gradient",
                      size: "action",
                    })}
                  >
                    Visit app <ArrowSquareOutIcon />
                  </a>
                )}
                <Button
                  variant={service.domain ? "raised" : "gradient"}
                  size="action"
                  onClick={() =>
                    onOpen(service.spec.catalog ? "Setup & data" : "Overview")
                  }
                >
                  Open service
                </Button>
              </>
            ) : progress.active ? (
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <CircleNotchIcon className="motion-safe:animate-spin" />{" "}
                Updating automatically
              </span>
            ) : (
              <Button
                variant="gradient"
                size="action"
                disabled={!canDeploy}
                onClick={onDeploy}
              >
                {busy
                  ? "Queuing deployment…"
                  : progress.failed || progress.cancelled
                    ? "Retry deployment"
                    : "Deploy service"}
              </Button>
            )}
          </div>
          {!progress.active && !progress.succeeded && !canDeploy && !busy && (
            <p className="px-5 pb-5 text-center text-xs text-muted-foreground">
              A connected, compatible deployment worker is required. Check the
              machine’s deployment settings.
            </p>
          )}
        </aside>
      </div>
      <p className="text-xs text-muted-foreground">
        {primary
          ? `${service.topology?.components.length ?? 1} components · `
          : ""}
        Your service overview will be available when you’re ready to continue.
      </p>
    </div>
  );
}

const logColors: Record<LogTone, string> = {
  default: "text-foreground",
  heading: "font-medium text-violet-700 dark:text-violet-300",
  error: "text-red-700 dark:text-red-400",
  warning: "text-amber-700 dark:text-amber-300",
  success: "text-emerald-700 dark:text-emerald-400",
  info: "text-sky-700 dark:text-sky-300",
};

function DeploymentOutput({
  serviceId,
  failedBuildId,
  buildLogs,
  startupLogs,
  error,
  elapsed,
  active,
  hasBuild,
}: {
  serviceId: string;
  failedBuildId?: string;
  buildLogs: string;
  startupLogs: string;
  error: string;
  elapsed: string | null;
  active: boolean;
  hasBuild: boolean;
}) {
  const viewport = useRef<HTMLElement>(null);
  const [following, setFollowing] = useState(true);
  const [copyStatus, setCopyStatus] = useState("");
  const output = [
    buildLogs && `── Build output ──\n${buildLogs}`,
    startupLogs && `── Startup output ──\n${startupLogs}`,
    error && `── Error ──\n${error}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const lines = useMemo(() => formatLogLines(output), [output]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Follow new output only while the reader remains at the bottom.
  useEffect(() => {
    if (following && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [output, following]);
  return (
    <section
      className="min-w-0 overflow-hidden rounded-xl border bg-card"
      aria-label="Deployment output"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TerminalIcon size={17} /> Build & deploy logs
        </div>
        <div className="flex items-center gap-3">
          {failedBuildId && (
            <BuildDiagnose
              key={failedBuildId}
              serviceId={serviceId}
              buildId={failedBuildId}
            />
          )}
          {elapsed && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {elapsed}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy logs"
            disabled={!output}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(output);
                setCopyStatus("Logs copied");
              } catch {
                setCopyStatus(
                  "Could not copy. Select the output to copy it manually.",
                );
              }
            }}
          >
            <CopyIcon />
          </Button>
        </div>
      </div>
      <section
        ref={viewport}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll through output.
        tabIndex={0}
        aria-label="Build and startup output"
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollowing(
            element.scrollHeight - element.scrollTop - element.clientHeight <
              40,
          );
        }}
        className="h-96 overflow-auto overscroll-contain whitespace-pre-wrap break-words bg-muted/20 p-5 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <pre className="whitespace-pre-wrap break-words">
          {output ? (
            lines.map((line) => (
              <span key={line.key} className={logColors[line.tone]}>
                {line.text}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">
              {hasBuild
                ? "Build output will appear here."
                : "This service uses a prebuilt image. No build step is needed."}
            </span>
          )}
        </pre>
      </section>
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <span role="status">
          {copyStatus ||
            (active
              ? "Checking for new output every 2 seconds"
              : "Latest available output")}
        </span>
        {!following && (
          <Button variant="ghost" size="xs" onClick={() => setFollowing(true)}>
            Jump to latest ↓
          </Button>
        )}
      </div>
    </section>
  );
}

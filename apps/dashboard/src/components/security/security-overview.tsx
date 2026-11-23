import type { ProtectionOverview } from "@ephor/api/protections";
import type {
  SecurityActionList,
  SecurityDeployment,
  SecurityEventList,
  SecurityOverview,
} from "@ephor/api/security";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ManagedProtectionsCard,
  type ProtectionProduct,
} from "./managed-protections";
import { ActionSummary, actionNextStep, actionTitle } from "./security-actions";
import { SecurityArchitecture } from "./security-architecture";
import { label, useSecurityData, when } from "./security-data";
import { BlueIndicator, SecurityLayer } from "./security-layer";
import { overviewCoverage } from "./security-overview-model";
export function SecurityOverviewPanel({
  data,
  onSection,
  onFinding,
}: {
  data: SecurityOverview;
  onSection: (name: string) => void;
  onFinding: (id: string) => void;
}) {
  const deployment = useSecurityData<SecurityDeployment>(
      "/security/deployment",
    ),
    findings = useSecurityData<SecurityActionList>(
      "/security/actions?workload=active",
    ),
    protections = useSecurityData<ProtectionOverview>("/security/protections"),
    activity = useSecurityData<SecurityEventList>("/security/audit");
  return (
    <SecurityOverviewContent
      data={data}
      deployment={deployment.data}
      findings={findings.data}
      protections={protections.data}
      activity={activity.data}
      errors={[
        deployment.error,
        findings.error,
        protections.error,
        activity.error,
      ].filter(Boolean)}
      refreshDeployment={deployment.refresh}
      onSection={onSection}
      onFinding={onFinding}
    />
  );
}
export function SecurityOverviewContent({
  data,
  deployment,
  findings,
  protections,
  activity,
  errors = [],
  refreshDeployment,
  onSection,
}: {
  data: SecurityOverview;
  deployment: SecurityDeployment | null;
  findings: SecurityActionList | null;
  protections: ProtectionOverview | null;
  activity: SecurityEventList | null;
  errors?: string[];
  refreshDeployment: () => void;
  onSection: (name: string) => void;
  onFinding: (id: string) => void;
}) {
  const stats = overviewCoverage(data);
  const cards = [
    {
      title: "Machine visibility",
      icon: HardDrivesIcon,
      value: `${stats.reporting.length} / ${stats.machines.length}`,
      filled: stats.reporting.length,
      total: stats.machines.length,
      detail: "Collectors reporting within 30 minutes",
      section: "Coverage",
    },
    {
      title: "Service scans",
      icon: CubeIcon,
      value: `${stats.scanned.length} / ${stats.services.length}`,
      filled: stats.scanned.length,
      total: stats.services.length,
      detail: "Current deployments scanned within 26 hours",
      section: "Coverage",
    },
    {
      title: "Automatic updates",
      icon: ArrowClockwiseIcon,
      value: `${stats.updatesConfigured} / ${stats.machines.length}`,
      filled: stats.updatesConfigured,
      total: stats.machines.length,
      detail: `Configured on recent checks · ${stats.updatesUnknown} unassessed`,
      section: "Coverage",
    },
    {
      title: "Resources needing review",
      icon: WarningCircleIcon,
      value: data.actionCounts ? String(data.actionCounts.active) : "—",
      filled: data.actionCounts?.active ?? 0,
      total: data.actionCounts?.active ?? 0,
      detail: `Affected active resources · ${data.actionCounts?.stopped ?? 0} stopped / disconnected`,
      section: "Findings",
    },
  ];
  const [protection, setProtection] = useState<ProtectionProduct | null>(null);
  const updateRecommendations = stats.updateState.filter(
    (m) => m.state !== "configured" || m.run?.status !== "pass",
  );
  return (
    <div className="space-y-5">
      {!!errors.length && (
        <p role="alert" className="text-sm text-destructive">
          Some security details could not be refreshed. {errors[0]}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
          <SecurityLayer key={c.title} title={c.title} icon={c.icon}>
            <button
              type="button"
              onClick={() => onSection(c.section)}
              className="flex w-full flex-col gap-3 p-4 text-left outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={`${c.title}: ${c.value}. ${c.detail}`}
            >
              <span className="text-3xl font-medium tracking-tight tabular-nums">
                {c.value}
              </span>
              <BlueIndicator filled={c.filled} total={c.total} />
              <span className="text-xs text-muted-foreground">{c.detail}</span>
            </button>
          </SecurityLayer>
        ))}
      </div>
      <SecurityArchitecture
        overview={data}
        deployment={deployment}
        refreshDeployment={refreshDeployment}
        onSection={(name) =>
          name === "Protections" ? setProtection("crowdsec") : onSection(name)
        }
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,1fr)]">
        <div className="space-y-5">
          <SecurityLayer
            title="Recommended actions"
            icon={WarningCircleIcon}
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSection("Findings")}
              >
                All findings
              </Button>
            }
          >
            {!findings ? (
              <p className="p-4 text-sm text-muted-foreground">
                Recommendations have not loaded yet.
              </p>
            ) : findings.items.length ? (
              <ul className="divide-y">
                {findings.items.slice(0, 5).map((f) => (
                  <li key={f.target}>
                    <button
                      type="button"
                      onClick={() => onSection("Findings")}
                      className="flex w-full items-start gap-3 p-4 text-left outline-none hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span
                        className={`mt-1 size-2 shrink-0 rounded-full ${f.counts.critical > 0 || f.counts.high > 0 ? "bg-amber-500" : "bg-blue-500"}`}
                        aria-hidden
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{actionTitle(f)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {f.machineName}
                          {f.serviceName ? ` / ${f.serviceName}` : ""} ·{" "}
                          {f.counts.critical} critical · {f.counts.high} high
                          advisory instances
                        </p>
                        <ActionSummary action={f} />
                        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {actionNextStep(f)}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                No active findings reported. Missing or stale coverage can still
                hide issues.
              </p>
            )}
          </SecurityLayer>
          <SecurityLayer
            title="Automatic update recommendations"
            icon={ArrowClockwiseIcon}
          >
            <div className="space-y-2 border-b p-4">
              <p className="text-sm">
                Keep host packages updated with{" "}
                <code className="text-xs">unattended-upgrades</code>.
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                These are read-only checks for Debian and Ubuntu. Review
                approved repositories, maintenance windows and reboot policy
                before enabling updates. Container images still need rebuilding
                and redeployment.
              </p>
            </div>
            {stats.machines.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                Enroll a machine to assess automatic updates.
              </p>
            ) : updateRecommendations.length ? (
              <ul className="divide-y">
                {updateRecommendations.slice(0, 5).map((m) => (
                  <li key={m.machine.id} className="space-y-1 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-medium">{m.machine.name}</h3>
                      <span className="text-xs text-muted-foreground">
                        {m.state === "unknown"
                          ? "Needs verification"
                          : m.state === "attention"
                            ? "Configuration needs attention"
                            : "Verify recent execution"}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {m.state === "unknown"
                        ? "No recent automatic-update assessment. Update the Security helper if needed, then run a machine scan. Unsupported or custom schedulers need local review."
                        : m.check?.status === "fail"
                          ? m.check.evidence
                          : (m.run?.evidence ??
                            "Configuration is enabled, but recent successful execution has not been verified.")}
                    </p>
                    <a
                      className="inline-block pt-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
                      href={`/security?machine=${m.machine.id}`}
                    >
                      Review machine security
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                All active machines have recent configured-policy and
                successful-run evidence. Review pending updates and reboot
                findings separately.
              </p>
            )}
            {updateRecommendations.length > 5 && (
              <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                {updateRecommendations.length - 5} more machines need review in
                Coverage.
              </p>
            )}
          </SecurityLayer>
        </div>
        <div className="space-y-5">
          <ManagedProtectionsCard
            data={protections}
            open={protection}
            onOpen={setProtection}
          />
          <SecurityLayer
            title="Recent security activity"
            icon={ClockCounterClockwiseIcon}
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSection("Audit")}
              >
                Full audit
              </Button>
            }
          >
            {activity?.items.length ? (
              <ul className="divide-y">
                {activity.items.slice(0, 5).map((e) => (
                  <li key={e.id} className="p-4">
                    <p className="text-sm">{label(e.action)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {e.actor} · {label(e.outcome)}
                    </p>
                    <time
                      dateTime={new Date(e.occurredAt).toISOString()}
                      className="mt-2 block text-[11px] text-muted-foreground"
                    >
                      {when(e.occurredAt)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                {activity
                  ? "No security activity recorded yet."
                  : "Activity has not loaded yet."}
              </p>
            )}
          </SecurityLayer>
        </div>
      </div>
    </div>
  );
}

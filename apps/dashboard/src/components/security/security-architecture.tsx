import type { SecurityDeployment, SecurityOverview } from "@ephor/api/security";
import type { Icon } from "@phosphor-icons/react";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { CloudIcon } from "@phosphor-icons/react/dist/csr/Cloud";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DeploymentDetails, runtimeLabel } from "./security-deployment";
import { SecurityLayer } from "./security-layer";
export function SecurityArchitecture({
  overview,
  deployment,
  refreshDeployment,
  onSection,
}: {
  overview: SecurityOverview;
  deployment: SecurityDeployment | null;
  refreshDeployment: () => void;
  onSection: (name: string) => void;
}) {
  const [selected, setSelected] = useState("control"),
    marker = useId().replaceAll(":", "");
  const machines = overview.machines.filter((m) => m.state === "active"),
    services = overview.services.filter((s) =>
      machines.some((m) => m.id === s.machineId),
    ),
    published = services.filter((s) => s.domain && s.currentDeployment);
  const nodes: Record<
    string,
    { title: string; icon: Icon; detail: string; text: string; section: string }
  > = {
    admin: {
      title: "Administrator",
      icon: BrowserIcon,
      detail: "Passkey-authenticated session",
      text: "Your browser authenticates to Ephor. Account access and privileged job approval are checked by the control plane.",
      section: "Panel",
    },
    control: {
      title: "Ephor control plane",
      icon: CloudIcon,
      detail: runtimeLabel(deployment),
      text:
        deployment?.runtime === "cloudflare-worker"
          ? "Ephor runs on a Cloudflare Worker. Host OS maintenance belongs to the provider; application dependencies, account access and configuration still matter."
          : "Ephor’s API receives reports and returns authorized jobs. A Cloudflare proxy or tunnel does not mean the application itself runs on a Worker.",
      section: "Panel",
    },
    agent: {
      title: `${machines.length} ${machines.length === 1 ? "machine" : "machines"}`,
      icon: HardDrivesIcon,
      detail: "Separate enrolled agents",
      text: "Monitoring, security collection and privileged management use separate identities. Agents initiate outbound HTTPS; jobs return over that connection. No public agent listener is required.",
      section: "Coverage",
    },
    services: {
      title: `${services.length} ${services.length === 1 ? "service" : "services"}`,
      icon: CubeIcon,
      detail: `${published.length} with configured domains`,
      text: "Services run on managed machines. A configured public domain describes intended exposure; external reachability and all published ports have not been independently verified.",
      section: "Coverage",
    },
    users: {
      title: "Application users",
      icon: UsersIcon,
      detail: "Independent application access",
      text: "Application users reach your published services through their own domains and ingress. They do not pass through Ephor’s administrator login.",
      section: "Findings",
    },
  };
  function node(key: string, left: number, top: number, width = 220) {
    const n = nodes[key];
    if (!n) return null;
    const Icon = n.icon;
    return (
      <button
        type="button"
        onClick={() => setSelected(key)}
        aria-pressed={selected === key}
        className={`absolute z-10 flex h-[88px] flex-col justify-center gap-2 rounded-lg border bg-card px-4 text-left outline-none transition-colors hover:border-blue-400 focus-visible:ring-2 focus-visible:ring-ring ${selected === key ? "border-blue-500 ring-1 ring-blue-500/20" : "border-border"}`}
        style={{ left, top, width }}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-4 text-blue-500" aria-hidden />
          {n.title}
        </span>
        <span className="text-xs text-muted-foreground">{n.detail}</span>
      </button>
    );
  }
  const current = nodes[selected] ?? nodes.control;
  return (
    <SecurityLayer
      title="Security architecture"
      icon={CloudIcon}
      action={
        <span className="text-xs text-muted-foreground">
          Connections & trust boundaries
        </span>
      }
    >
      <section
        className="overflow-x-auto"
        aria-label="Architecture diagram. Select a node for details."
      >
        <div className="relative mx-auto h-[350px] w-[930px]">
          <div className="absolute left-[625px] top-4 h-[315px] w-[285px] rounded-xl border border-dashed border-border bg-muted/25">
            <span className="absolute -top-2.5 left-4 bg-card px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Managed infrastructure
            </span>
          </div>
          <svg
            aria-hidden="true"
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 930 350"
          >
            <defs>
              <marker
                id={marker}
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3.5"
                orient="auto"
              >
                <path d="M0 0 L7 3.5 L0 7" fill="currentColor" />
              </marker>
            </defs>
            <g
              className="text-blue-500"
              stroke="currentColor"
              fill="none"
              strokeWidth="1.5"
            >
              <path d="M220 81 H300" markerEnd={`url(#${marker})`} />
              <path d="M650 81 H520" markerEnd={`url(#${marker})`} />
              <path
                d="M520 113 H650"
                strokeDasharray="4 4"
                markerEnd={`url(#${marker})`}
              />
              {published.length > 0 && (
                <path
                  d="M520 275 H650"
                  strokeDasharray="4 4"
                  markerEnd={`url(#${marker})`}
                />
              )}
            </g>
            <g
              fill="currentColor"
              className="text-muted-foreground"
              fontSize="10"
              textAnchor="middle"
            >
              <text x="260" y="65">
                Login
              </text>
              <text x="585" y="63">
                Outbound HTTPS
              </text>
              <text x="585" y="138">
                Jobs in response
              </text>
              {published.length > 0 && (
                <text x="585" y="256">
                  Public HTTPS*
                </text>
              )}
            </g>
          </svg>
          {node("admin", 20, 40, 200)}
          {node("control", 300, 40)}
          {node("agent", 650, 40, 235)}
          <button
            type="button"
            onClick={() => onSection("Protections")}
            className="absolute left-[650px] top-[160px] flex h-11 w-[235px] items-center gap-2 rounded-md border bg-card px-3 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ShieldCheckIcon className="size-4 text-blue-500" aria-hidden />
            Host protections · view status
          </button>
          {node("users", 300, 230)}
          {node("services", 650, 230, 235)}
          <div className="absolute left-5 top-[180px] max-w-[230px] space-y-2 text-xs text-muted-foreground">
            <p>
              <span className="mr-2 inline-block h-px w-6 bg-blue-500 align-middle" />
              Connection initiation
            </p>
            <p>
              <span className="mr-2 inline-block w-6 border-t border-dashed border-blue-500 align-middle" />
              Response / configured path
            </p>
            <p className="pt-2 leading-relaxed">
              * Public domains are configuration evidence, not a reachability
              test.
            </p>
          </div>
        </div>
      </section>
      {current && (
        <div
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3"
        >
          <div className="max-w-3xl">
            <h3 className="text-sm font-medium">{current.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {current.text}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onSection(current.section)}
          >
            View {current.section.toLowerCase()}
          </Button>
        </div>
      )}
      {deployment ? (
        <DeploymentDetails
          key={deployment.revision}
          data={deployment}
          machines={overview.machines}
          changed={refreshDeployment}
        />
      ) : (
        <p className="border-t p-4 text-xs text-muted-foreground">
          Deployment information is unavailable. Hosting is shown as unknown.
        </p>
      )}
    </SecurityLayer>
  );
}

import {
  type ProtectionAction,
  type ProtectionMachine,
  protectionPlan,
} from "@ephor/api/protections";
import { useState } from "react";
import { MaintenanceLink } from "@/components/machines/maintenance-link";
import { Button } from "@/components/ui/button";
import { api, reauthenticate } from "@/lib/auth";
import { when } from "./security-data";

type Plan = {
  id: string;
  action: ProtectionAction;
  steps: string[];
  expiresAt: number;
  parameters: { trustedIPs?: string[]; ip?: string };
};
export function MachineProtection({
  machine,
  installerAvailable,
  refresh,
}: {
  machine: ProtectionMachine;
  installerAvailable: boolean;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null),
    [trusted, setTrusted] = useState(""),
    [tested, setTested] = useState(false);
  const state = machine.snapshot;
  const online =
    machine.enabled &&
    !!machine.lastSeen &&
    Date.now() - machine.lastSeen < 90_000;
  const pending = machine.jobs.some((j) =>
    ["queued", "running"].includes(j.status),
  );
  const managed = state?.ownership === "managed";
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Protection action failed.");
    } finally {
      setBusy(false);
    }
  }
  function review(action: ProtectionAction, parameters = {}) {
    void run(async () => {
      await reauthenticate();
      setTested(false);
      setPlan(
        await api<Plan>("/security/protections/plan", {
          machineId: machine.id,
          action,
          parameters,
        }),
      );
    });
  }
  return (
    <section
      className="space-y-4 rounded-lg border p-5"
      aria-label={`CrowdSec on ${machine.name}`}
    >
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h3 className="font-medium">{machine.name} · CrowdSec</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {state?.ownership === "external"
              ? "Externally managed — configuration preserved"
              : managed
                ? `Managed by Ephor · ${state.version || "installation incomplete"}`
                : "Not installed by Ephor"}
          </p>
        </div>
        <span className="text-sm text-muted-foreground">
          {online
            ? "Management connected"
            : machine.enabled
              ? "Management offline"
              : "Management not connected"}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Detection</dt>
          <dd>
            {!online
              ? "Not currently verified"
              : state?.engineRunning
                ? state.acquisitionReady
                  ? "SSH source and engine ready"
                  : "Engine running · source needs attention"
                : "Not running"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">SSH blocking</dt>
          <dd>
            {!online
              ? "Unverified · blocks expire without contact"
              : state?.blocking === "pending"
                ? "Trial · confirmation required"
                : state?.blocking === "enabled"
                  ? "Enabled · temporary entries"
                  : "Off"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last report</dt>
          <dd>{when(machine.lastSeen)}</dd>
        </div>
      </dl>
      {state?.detail && (
        <p className="text-sm text-muted-foreground">{state.detail}</p>
      )}
      {state && !state.supported && (
        <p className="text-sm text-muted-foreground">
          Requires Debian or Ubuntu, systemd, OpenSSH and nftables. Unsupported
          configurations remain unchanged.
        </p>
      )}
      {managed && (
        <p className="text-xs text-muted-foreground">
          SSH ports: {state.sshPorts.join(", ") || "unavailable"}. Trusted
          addresses: {state.trustedIPs.join(", ") || "none configured"}. This
          integration does not provide web application protection.
        </p>
      )}
      {!machine.enabled && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Connect a separate privileged management helper once on this
            machine. The Security collector’s credentials cannot install
            software or change blocking rules.
          </p>
          <MaintenanceLink id={machine.id} />
          {!installerAvailable && (
            <p className="text-xs text-muted-foreground">
              Build the updated daemon bundle before connecting management.
            </p>
          )}
        </div>
      )}
      {online && state?.supported && state.ownership !== "external" && (
        <div className="flex flex-wrap gap-2">
          {!managed && (
            <Button
              disabled={busy || pending}
              onClick={() => review("install")}
            >
              Review CrowdSec installation
            </Button>
          )}
          {managed && (
            <>
              <Button
                variant="outline"
                disabled={busy || pending}
                onClick={() => review("repair")}
              >
                Repair
              </Button>
              <Button
                variant="outline"
                disabled={busy || pending}
                onClick={() => review("update")}
              >
                Update
              </Button>
              <Button
                variant="outline"
                disabled={busy || pending}
                onClick={() => review("uninstall")}
              >
                Uninstall
              </Button>
              {state.blocking !== "off" && (
                <Button
                  variant="outline"
                  disabled={busy || pending}
                  onClick={() => review("disable")}
                >
                  Disable blocking
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {online && managed && state?.blocking === "off" && (
        <div className="max-w-xl space-y-2 border-t pt-4">
          <label
            htmlFor={`trusted-${machine.id}`}
            className="text-sm font-medium"
          >
            Trusted administrator IP addresses
          </label>
          <input
            id={`trusted-${machine.id}`}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={trusted}
            onChange={(e) => setTrusted(e.target.value)}
            placeholder="Your SSH client's public IP; separate multiple addresses with commas"
          />
          <p className="text-xs text-muted-foreground">
            Use the address your machine sees for your SSH connection.
            Previously trusted addresses stay exempt. IPv4 and IPv6 addresses
            are supported; ranges are not accepted.
          </p>
          <Button
            variant="outline"
            disabled={
              busy || pending || !trusted.trim() || !state.acquisitionReady
            }
            onClick={() =>
              review("enable", {
                trustedIPs: trusted.split(/[\s,]+/).filter(Boolean),
              })
            }
          >
            Review SSH blocking trial
          </Button>
        </div>
      )}
      {online && state?.blocking === "pending" && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm">
            Open a new SSH connection now. Confirm by{" "}
            {when(state.confirmBefore)} or blocking automatically turns off.
          </p>
          <Button disabled={busy || pending} onClick={() => review("confirm")}>
            Review confirmation
          </Button>
        </div>
      )}
      {plan && (
        <section
          className="space-y-3 rounded-md border border-primary/30 p-4"
          aria-label="Review protection change"
        >
          <h4 className="font-medium">Review: {plan.action}</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {(plan.steps ?? protectionPlan(plan.action)).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
          {plan.parameters.trustedIPs && (
            <p className="text-sm">
              Trusted: {plan.parameters.trustedIPs.join(", ")}
            </p>
          )}
          {plan.parameters.ip && (
            <p className="text-sm">Address: {plan.parameters.ip}</p>
          )}
          {plan.action === "confirm" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tested}
                onChange={(e) => setTested(e.target.checked)}
              />
              I successfully opened a new SSH connection during this trial.
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Plan expires {when(plan.expiresAt)}. Approval requires passkey
            verification.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={
                busy || pending || (plan.action === "confirm" && !tested)
              }
              onClick={() =>
                void run(async () => {
                  await reauthenticate();
                  await api("/security/protections/approve", { id: plan.id });
                  setPlan(null);
                  setNotice(
                    "Approved. The machine will fetch this job over its outbound connection.",
                  );
                })
              }
            >
              Approve {plan.action}
            </Button>
            <Button variant="ghost" onClick={() => setPlan(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}
      {!!state?.bans.length && (
        <div className="space-y-2 border-t pt-4">
          <h4 className="text-sm font-medium">
            Eligible SSH decisions{" "}
            {state.blocking === "off" ? "(blocking is off)" : ""}
          </h4>
          {state.bans.map((b) => (
            <div
              key={`${b.ip}:${b.reason}`}
              className="flex flex-wrap items-center gap-3 text-sm"
            >
              <code>{b.ip}</code>
              <span className="text-muted-foreground">
                {b.reason} · {Math.ceil(b.remainingSeconds / 60)} min remaining
              </span>
              <Button
                variant="ghost"
                disabled={busy || pending || !online}
                onClick={() => review("unblock", { ip: b.ip })}
              >
                Exempt for one hour
              </Button>
            </div>
          ))}
        </div>
      )}
      {!!machine.jobs.length && (
        <details className="border-t pt-3 text-sm">
          <summary className="cursor-pointer">Recent protection jobs</summary>
          <div className="mt-3 space-y-2">
            {machine.jobs.map((j) => (
              <div key={j.id}>
                <span className="font-medium">{j.action}</span> · {j.status} ·{" "}
                {when(j.createdAt)}
                {j.result && (
                  <p className="text-xs text-muted-foreground">{j.result}</p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      {machine.enabled && (
        <details className="border-t pt-3 text-sm">
          <summary className="cursor-pointer">Management access</summary>
          <p className="my-3 text-muted-foreground">
            Revoking access stops new jobs. Locally leased blocks expire within
            150 seconds. CrowdSec detection remains installed.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await reauthenticate();
                await api("/security/protections/revoke", {
                  machineId: machine.id,
                });
                setPlan(null);

                setNotice("Management access revoked.");
              })
            }
          >
            Revoke management access
          </Button>
        </details>
      )}
    </section>
  );
}

import type { Machine, MachineList } from "@ephor/api/machines";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, signIn } from "@/lib/auth";
import { CopyEnrollmentCommand, EnrollmentCommand } from "./enrollment-command";

const components = [
  ["monitoring", "Monitoring"],
  ["deployments", "Deployments & backups"],
  ["security", "Security collection"],
  ["protections", "Protection management"],
  ["updater", "Updater"],
] as const;
export function MachineMaintenance({
  machine,
  releaseInfo,
  job,
  refresh,
}: {
  machine: Machine;
  releaseInfo: MachineList["releaseInfo"];
  job: NonNullable<MachineList["updates"]>[number] | undefined;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [command, setCommand] = useState<{
    command: string;
    expiresAt: number;
  } | null>(null);
  const [protections, setProtections] = useState(false);
  const installed = machine.maintenance?.components ?? [];
  const fresh = Number(machine.updaterSeen) > Date.now() - 180000;
  const shared = machine.maintenance?.protocol === 3;
  const ready =
    shared && fresh && machine.updaterKey === releaseInfo?.publicKey;
  const latest = releaseInfo?.release;
  const policy = machine.maintenance?.policy ?? "manual";
  const pinned =
    policy === "pinned" &&
    machine.maintenance?.pinnedVersion !== latest?.version;
  const compatible =
    latest?.updaterProtocol === 3 &&
    !!latest.artifacts[machine.telemetry?.arch as "x86_64" | "aarch64"];
  const newerComponent = installed.some(
    (c) =>
      c.installed &&
      c.version &&
      latest &&
      compare(c.version, latest.version) > 0,
  );
  const needsUpdate = installed.some(
    (c) =>
      c.installed &&
      latest &&
      (c.version !== latest.version || c.buildId !== latest.buildId),
  );
  const active =
    !!job &&
    (["queued", "downloading", "installing"].includes(job.status) ||
      (job.status === "expired" && job.install_started === 1));
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Maintenance failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="max-w-3xl space-y-5 rounded-xl border bg-card p-5"
      aria-label="Ephor maintenance"
    >
      <div className="space-y-2">
        <h2 className="font-medium">Ephor on this machine</h2>
        <p className="text-sm text-muted-foreground">
          One installed Ephor binary powers all enabled services. Active helpers
          briefly restart; application containers keep running. Components that
          are not installed stay disabled.
        </p>
      </div>
      <p className="text-sm">
        Installed Ephor version:{" "}
        <span className="font-mono">
          {shared
            ? (installed.find((c) => c.id === "monitoring")?.version ?? "—")
            : "Migration required"}
        </span>
      </p>
      <div className="space-y-2">
        <label htmlFor="ephor-update-policy" className="text-sm font-medium">
          Update policy
        </label>
        <select
          id="ephor-update-policy"
          className="block rounded border bg-background p-2 text-sm"
          value={policy}
          disabled={busy || active || !ready}
          onChange={(e) => {
            const next = e.target.value;
            void run(async () => {
              await signIn();
              await api("/machines/maintenance/policy", {
                id: machine.id,
                policy: next,
              });
              setNotice("Update policy saved.");
            });
          }}
        >
          <option value="manual">Ask before updating</option>
          <option value="automatic">
            Automatically install signed releases when idle
          </option>
          <option value="pinned">Keep the installed version</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {policy === "pinned"
            ? `Pinned to ${machine.maintenance?.pinnedVersion}. Change this policy to upgrade.`
            : policy === "automatic"
              ? "Automatic updates wait for active jobs. Failed releases require a manual retry. Protection blocking may need re-enabling after a restart."
              : "Updates require your approval and passkey."}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">Component</th>

              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {components.map(([id, label]) => {
              const c = installed.find((c) => c.id === id);
              return (
                <tr key={id} className="border-b last:border-0">
                  <th className="py-3 font-normal">{label}</th>

                  <td className="text-muted-foreground">
                    {!c
                      ? "Setup required to inspect"
                      : !fresh
                        ? "Last reported"
                        : !c.installed
                          ? "Not installed"
                          : c.active
                            ? id === "updater"
                              ? "Ready"
                              : "Running"
                            : "Stopped"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">
        {!releaseInfo?.configured
          ? "The panel needs a signed release source and signing key before machine updates can be enabled."
          : !shared
            ? "Run setup or repair once to migrate this machine to the shared Ephor binary."
            : !fresh
              ? "Waiting for the machine’s updater to report. The last known version is shown above."
              : machine.updaterKey !== releaseInfo.publicKey
                ? "The machine’s signing key differs from the panel. Review signing trust locally before updating."
                : !compatible
                  ? "A signed whole-machine release for this architecture is not available yet."
                  : newerComponent
                    ? "An installed component is newer than this release. Downgrades are blocked."
                    : needsUpdate
                      ? `Ephor ${latest?.version} is available for this machine.`
                      : `All installed components match Ephor ${latest?.version}.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            busy ||
            active ||
            !ready ||
            !compatible ||
            !needsUpdate ||
            pinned ||
            newerComponent ||
            machine.status !== "online"
          }
          onClick={() => {
            if (
              !confirm(
                `Update all installed Ephor components on “${machine.name}” to ${latest?.version}? Helpers briefly restart. Protection blocking may need to be enabled again afterward. A failed health check restores the previous components.`,
              )
            )
              return;
            void run(async () => {
              await signIn();
              await api("/machines/updates", {
                id: machine.id,
                wholeMachine: true,
              });
              setNotice("Ephor update queued.");
            });
          }}
        >
          Update Ephor on this machine
        </Button>
        <Button
          variant="outline"
          disabled={busy || !releaseInfo?.configured}
          onClick={() =>
            void run(async () => {
              await api("/machines/updates/check", {});
              setNotice("Release check complete.");
            })
          }
        >
          Check for updates
        </Button>
      </div>
      {job && (
        <p role="status" className="text-sm text-muted-foreground">
          {job.status === "succeeded"
            ? "Updated"
            : job.status === "rolled_back"
              ? "Previous components restored"
              : job.status === "expired"
                ? "Completion unknown — inspect the machine before retrying"
                : job.status.replaceAll("_", " ")}{" "}
          · {job.version}
          {job.error ? ` · ${job.error}` : ""}
        </p>
      )}
      <div className="space-y-3 border-t pt-5">
        <h3 className="text-sm font-medium">Setup & repair</h3>
        <p className="text-sm text-muted-foreground">
          Use one command for the updater, deployment worker and security
          collector, plus protection management if already enabled or selected
          below. Run it on the enrolled Linux machine with sudo access.
          Monitoring must already be enrolled.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={protections}
            disabled={busy || active}
            onChange={(e) => setProtections(e.target.checked)}
          />
          Enable protection management if not connected
        </label>
        <p className="text-xs text-muted-foreground">
          This authorizes protection management. It does not enable automatic OS
          updates, reboots, or firewall blocking.
        </p>
        <Button
          variant="outline"
          disabled={
            busy ||
            active ||
            !machine.enrolledAt ||
            machine.status === "revoked" ||
            !releaseInfo?.configured ||
            !releaseInfo.maintenanceAvailable
          }
          onClick={() =>
            void run(async () => {
              setCommand(null);
              await signIn();
              setCommand(
                await api("/machines/maintenance/setup", {
                  id: machine.id,
                  protections,
                }),
              );
            })
          }
        >
          {busy ? "Working…" : "Get setup or repair command"}
        </Button>
        {!releaseInfo?.maintenanceAvailable && (
          <p className="text-xs text-muted-foreground">
            Deploy a panel bundle containing the unified maintenance build to
            make setup available.
          </p>
        )}
        {command && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Run before {new Date(command.expiresAt).toLocaleTimeString()}.
              This reinstalls the helpers and may install missing dependencies.
              Wait for current machine jobs to finish first.
            </p>
            <EnrollmentCommand command={command.command} />
            <CopyEnrollmentCommand
              command={command.command}
              onCopyError={setError}
            />
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        The panel has its own Updates page. Operating-system packages and hosted
        applications remain separate from Ephor’s five machine components.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}
function compare(a: string, b: string) {
  const aa = a.split(".").map(Number),
    bb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

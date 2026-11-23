import type { Machine } from "@ephor/api/machines";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, signIn } from "@/lib/auth";
import { CopyEnrollmentCommand, EnrollmentCommand } from "./enrollment-command";

export function DeploymentSettings({ machine }: { machine: Machine }) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const worker = machine.deploymentWorker;
  const ready =
    machine.status !== "revoked" &&
    worker &&
    worker.lastSeen > Date.now() - 120000;
  const current = ready && worker.version >= 6;
  return (
    <section className="w-full max-w-2xl space-y-3 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Deployments</h2>
          <p className="text-sm text-muted-foreground">
            {machine.status === "revoked"
              ? "This machine is disconnected."
              : current
                ? "Ready for persistent services, service connections, and backups."
                : ready
                  ? "Upgrade the deployment worker to use persistent volumes, Qdrant, and database sizing."
                  : worker
                    ? "The deployment worker is not reporting. Check the installer or repair it below."
                    : "New enrollments include deployments. Complete setup here for an older machine or an interrupted installation."}
          </p>
        </div>
        <Button
          variant="subtle-outline"
          size="sm"
          disabled={busy || !machine.enrolledAt || machine.status === "revoked"}
          onClick={async () => {
            setBusy(true);
            setError("");
            setCommand("");
            try {
              await signIn();
              const result = await api<{ command: string }>(
                "/services/worker",
                { machineId: machine.id, minimumProtocol: 6 },
              );
              setCommand(result.command);
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : "Could not create setup command.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? "Preparing…"
            : current
              ? "Get repair command"
              : worker
                ? ready
                  ? "Get upgrade command"
                  : "Get repair command"
                : "Complete setup"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {command && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Run on this machine with sudo access within 10 minutes. Docker,
            Buildx, and Git are installed automatically on Ubuntu and Debian
            when needed. Ports 80 and 443 must be free to serve custom domains.
          </p>
          <EnrollmentCommand command={command} />
          <CopyEnrollmentCommand command={command} onCopyError={setError} />
        </div>
      )}
    </section>
  );
}

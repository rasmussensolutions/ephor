import type { MachineList } from "@ephor/api/machines";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/auth";
import type { ServiceList } from "@/lib/services";
import { CatalogForm } from "./catalog-form";
import { ServiceForm } from "./service-form";

export const deploymentSources = [
  { mode: "github", label: "GitHub repository", icon: GithubLogoIcon },
  { mode: "catalog", label: "Template", icon: StackIcon },
  { mode: "database", label: "Database", icon: DatabaseIcon },
  { mode: "image", label: "Container image", icon: CubeIcon },
] as const;
export type DeploymentMode = (typeof deploymentSources)[number]["mode"];

export function DeployServiceDialog({
  machineId,
  workers,
  initialMode,
  trigger,
  onClose,
  onSaved,
}: {
  machineId: string;
  workers: ServiceList["workers"];
  initialMode: DeploymentMode | null;
  trigger: HTMLElement | null;
  onClose: () => void;
  onSaved: (id: string, message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState(initialMode);
  const [machines, setMachines] = useState<MachineList["machines"] | null>(
    null,
  );
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retrying explicitly reloads the machine inventory.
  useEffect(() => {
    let active = true;
    setError("");
    api<MachineList>("/machines").then(
      (result) => {
        if (active) setMachines(result.machines);
      },
      () => {
        if (active) setError("Could not load machines.");
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const machine = machines?.find((item) => item.id === machineId);
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) details.cancel();
        else onClose();
      }}
    >
      <DialogContent
        className="h-[40rem] [&>[data-slot=dialog-surface]]:flex-1"
        showCloseButton={!busy}
        finalFocus={() => trigger}
      >
        <DialogHeader>
          <DialogTitle>Deploy service</DialogTitle>
          <DialogDescription>
            {machine
              ? `Deploy to ${machine.name}.`
              : "Choose a source for your service."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error ? (
            <div className="space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button
                variant="outline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : !machines ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading machines…
            </p>
          ) : !machine ? (
            <p role="alert" className="text-sm text-destructive">
              This machine is no longer available.
            </p>
          ) : mode === null ? (
            <div className="grid gap-3">
              {deploymentSources.map(({ mode, label, icon: Icon }) => (
                <Button
                  key={mode}
                  variant="outline"
                  className="h-14 justify-start gap-3"
                  onClick={() => setMode(mode)}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setMode(null)}
              >
                Back to sources
              </Button>
              {mode === "catalog" || mode === "database" ? (
                <CatalogForm
                  machines={machines}
                  workers={workers}
                  initialMachineId={machineId}
                  databasesOnly={mode === "database"}
                  onBusyChange={setBusy}
                  onSaved={onSaved}
                />
              ) : (
                <ServiceForm
                  service={null}
                  machines={machines}
                  initialMachineId={machineId}
                  initialSourceType={mode}
                  className="space-y-5"
                  onBusyChange={setBusy}
                  onSaved={onSaved}
                />
              )}
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

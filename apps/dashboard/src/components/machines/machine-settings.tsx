import type { Machine, MachineList } from "@ephor/api/machines";
import { PROVIDER_SUGGESTIONS } from "@ephor/api/providers";
import { useEffect, useState } from "react";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { bytes } from "@/lib/services";
import { DeploymentSettings } from "./deployment-settings";
export function MachineSettings({
  machine,
  busy,
  update,
  releaseInfo,
  job,
  saveProvider,
}: {
  machine: Machine;
  busy: boolean;
  update: () => void;
  releaseInfo: MachineList["releaseInfo"];
  job: NonNullable<MachineList["updates"]>[number] | undefined;
  saveProvider: (provider: string | null) => Promise<void>;
}) {
  const metrics = machine.telemetry;
  const latest = releaseInfo?.release;
  const version = metrics?.agentVersion;
  const newer =
    latest &&
    version &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    latest.version
      .split(".")
      .map(Number)
      .some(
        (part, index, parts) =>
          parts
            .slice(0, index)
            .every((v, i) => v === Number(version.split(".")[i])) &&
          part > Number(version.split(".")[index]),
      );
  const activeJob =
    job && ["queued", "downloading", "installing"].includes(job.status);
  const enabled =
    releaseInfo?.publicKey &&
    machine.updaterKey === releaseInfo.publicKey &&
    Number(machine.updaterSeen) > Date.now() - 180000;
  const compatible =
    latest && metrics && latest.artifacts[metrics.arch as "x86_64" | "aarch64"];
  const canUpdate =
    machine.status === "online" && enabled && compatible && newer && !activeJob;
  const updateLabels: Record<string, string> = {
    queued: "Queued",
    downloading: "Downloading…",
    installing: "Installing…",
    succeeded: "Updated",
    rolled_back: "Rolled back",
    failed: "Update failed",
    expired: "Completion unknown",
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-6 py-1">
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {metrics
              ? `${metrics.hostname} · ${metrics.os} · ${metrics.arch} · ${metrics.cpuCount} ${metrics.cpuCount === 1 ? "core" : "cores"} · ${bytes(metrics.memoryTotal)} RAM`
              : "No metrics received."}
            {metrics &&
              machine.status !== "online" &&
              " · Last reported values"}
          </p>
          <ProviderSettings
            machine={machine}
            save={saveProvider}
            disabled={busy || machine.status === "revoked"}
          />
          {metrics && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs font-medium">
                  Daemon{" "}
                  <span className="font-mono text-muted-foreground">
                    {version || "—"}
                  </span>
                </p>
                {canUpdate && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={update}
                  >
                    Update to {latest?.version}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {!releaseInfo?.configured
                  ? "Release updates are not configured."
                  : enabled
                    ? compatible
                      ? newer
                        ? `Version ${latest?.version} is available.`
                        : "No newer compatible version is available."
                      : "No release is available for this architecture."
                    : machine.updaterKey
                      ? "Updater is not responding or trusts a different signing key. Check ephor-updater on the VPS."
                      : "Enable the updater once on this VPS to receive signed updates from your panel."}
              </p>
              {job && (
                <p role="status" className="text-xs text-muted-foreground">
                  {updateLabels[job.status]} · {job.version}
                  {job.error ? ` · ${job.error}` : ""}
                </p>
              )}
              {!machine.updaterKey &&
                machine.status !== "revoked" &&
                releaseInfo?.configured &&
                (releaseInfo.bootstrapCommand ? (
                  <div className="max-w-2xl space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Run once on this VPS with sudo access:
                    </p>
                    <pre className="overflow-x-auto rounded-md border bg-background p-3 text-xs whitespace-pre-wrap break-all select-all">
                      {releaseInfo.bootstrapCommand}
                    </pre>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Bundle the new daemon build on your panel to make the
                    updater setup command available.
                  </p>
                ))}
            </div>
          )}
        </div>
      </div>
      <DeploymentSettings key={machine.id} machine={machine} />
    </div>
  );
}

function ProviderSettings({
  machine,
  save,
  disabled,
}: {
  machine: Machine;
  save: (provider: string | null) => Promise<void>;
  disabled: boolean;
}) {
  const [manual, setManual] = useState(machine.providerOverride !== null);
  const [value, setValue] = useState(machine.providerOverride ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setManual(machine.providerOverride !== null);
    setValue(machine.providerOverride ?? "");
  }, [machine.providerOverride]);
  const hosting = machine.telemetry?.hosting;
  const id = `provider-${machine.id}`;
  const changed = (manual ? value.trim() : null) !== machine.providerOverride;
  return (
    <form
      className="max-w-lg space-y-2 border-b pb-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        setSaved(false);
        try {
          await save(manual ? value.trim() : null);
          setSaved(true);
        } catch (error) {
          setError(
            error instanceof Error ? error.message : "Could not save provider.",
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <label htmlFor={id} className="text-xs font-medium">
        Provider
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          id={id}
          value={manual ? "manual" : "automatic"}
          disabled={disabled || saving}
          onValueChange={(next) => {
            setManual(next === "manual");
            setSaved(false);
          }}
          className="h-8"
          options={[
            {
              value: "automatic",
              label: hosting ? `Automatic · ${hosting.provider}` : "Automatic",
            },
            { value: "manual", label: "Set manually" },
          ]}
        />
        {manual && (
          <Autocomplete
            className="h-8 w-44 text-xs"
            aria-label="Provider name"
            value={value}
            disabled={disabled || saving}
            required
            maxLength={60}
            placeholder="e.g. netcup"
            items={PROVIDER_SUGGESTIONS}
            onValueChange={(next) => {
              setValue(next);
              setSaved(false);
            }}
          />
        )}
        <Button
          type="submit"
          size="xs"
          variant="outline"
          disabled={disabled || saving || !changed || (manual && !value.trim())}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {hosting
          ? `Detected: ${hosting.provider}${[hosting.region, hosting.zone].filter(Boolean).length ? ` · ${[hosting.region, hosting.zone].filter(Boolean).join(" · ")}` : ""}.`
          : !machine.telemetry
            ? "Detection is available after the machine reports its first metrics."
            : machine.telemetry.hosting === undefined
              ? "Automatic detection requires daemon 0.1.2 or later. You can set a provider manually."
              : "No provider detected. You can set one manually."}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-xs text-muted-foreground">
          Provider saved.
        </p>
      )}
    </form>
  );
}

import type { Machine } from "@ephor/api/machines";
import { PROVIDER_SUGGESTIONS } from "@ephor/api/providers";
import { useEffect, useState } from "react";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { bytes } from "@/lib/services";
export function MachineSettings({
  machine,
  busy,
  saveProvider,
}: {
  machine: Machine;
  busy: boolean;
  saveProvider: (provider: string | null) => Promise<void>;
}) {
  const metrics = machine.telemetry;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {metrics
          ? `${metrics.hostname} · ${metrics.os} · ${metrics.arch} · ${metrics.cpuCount} cores · ${bytes(metrics.memoryTotal)} RAM`
          : "No metrics received."}
      </p>
      <ProviderSettings
        machine={machine}
        save={saveProvider}
        disabled={busy || machine.status === "revoked"}
      />
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

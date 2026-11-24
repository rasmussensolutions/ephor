import type { SecurityDeployment, SecurityOverview } from "@ephor/api/security";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api, reauthenticate } from "@/lib/auth";
import { when } from "./security-data";
export const runtimeLabel = (d: SecurityDeployment | null) =>
  d?.runtime === "cloudflare-worker"
    ? "Cloudflare Worker"
    : d?.runtime === "node"
      ? "Node.js server"
      : d?.runtime === "bun"
        ? "Bun server"
        : "Hosting unknown";
export function DeploymentDetails({
  data,
  machines,
  changed,
}: {
  data: SecurityDeployment;
  machines: SecurityOverview["machines"];
  changed: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(data.configured),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const worker = data.runtime === "cloudflare-worker";
  async function save() {
    setBusy(true);
    setError("");
    try {
      await reauthenticate();
      await api("/security/deployment", { ...draft, revision: data.revision });
      setEditing(false);
      changed();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save deployment details.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 border-t p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Deployment details</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Runtime comes from Ephor’s server. Provider and network details are
            administrator declarations.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(data.configured);
            setEditing(!editing);
            setError("");
          }}
        >
          {editing ? "Cancel" : "Edit details"}
        </Button>
      </div>
      <dl className="grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Runtime · detected</dt>
          <dd className="mt-1">
            {runtimeLabel(data)} · {data.database}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Panel address · configured</dt>
          <dd className="mt-1 break-all">{data.origin}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            Provider · {worker ? "detected" : "declared"}
          </dt>
          <dd className="mt-1">
            {worker ? "Cloudflare" : data.configured.provider || "Unknown"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            Ingress · {worker ? "detected" : "declared"}
          </dt>
          <dd className="mt-1">
            {worker
              ? "Cloudflare edge"
              : data.configured.ingress.replaceAll("-", " ")}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Frontend:{" "}
        {data.frontendDetected === "same-runtime"
          ? "served by this runtime (detected)"
          : data.configured.frontend === "unknown"
            ? "unknown"
            : `${data.configured.frontend.replaceAll("-", " ")} (declared)`}
        {data.configured.machineId
          ? ` · Host: ${machines.find((m) => m.id === data.configured.machineId)?.name ?? "unavailable machine"} (declared)`
          : ""}
        .{" "}
        {data.updatedAt
          ? `Details updated ${when(data.updatedAt)}.`
          : "No deployment details recorded yet."}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {editing && (
        <form
          className="grid gap-4 rounded-md border p-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="space-y-1 text-xs">
            Hosting provider
            <input
              value={draft.provider}
              disabled={worker}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
              placeholder={
                worker ? "Cloudflare" : "For example, Hetzner or Railway"
              }
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <div className="space-y-1">
            <span className="text-xs">Panel ingress</span>
            <Select
              aria-label="Panel ingress"
              value={draft.ingress}
              disabled={worker}
              onValueChange={(v) =>
                setDraft({ ...draft, ingress: v as typeof draft.ingress })
              }
              options={[
                "unknown",
                "direct",
                "reverse-proxy",
                "cloudflare-proxy",
                "cloudflare-tunnel",
                "private",
              ].map((value) => ({ value, label: value.replaceAll("-", " ") }))}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs">Frontend hosting</span>
            <Select
              aria-label="Frontend hosting"
              value={
                data.frontendDetected === "same-runtime"
                  ? "same-runtime"
                  : draft.frontend
              }
              disabled={data.frontendDetected === "same-runtime"}
              onValueChange={(v) =>
                setDraft({ ...draft, frontend: v as typeof draft.frontend })
              }
              options={[
                { value: "unknown", label: "Unknown" },
                { value: "same-runtime", label: "Same runtime" },
                { value: "separate", label: "Separate frontend host" },
              ]}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs">Ephor host machine</span>
            <Select
              aria-label="Ephor host machine"
              disabled={worker}
              value={draft.machineId ?? ""}
              onValueChange={(v) =>
                setDraft({ ...draft, machineId: v || null })
              }
              options={[
                {
                  value: "",
                  label: worker
                    ? "Provider-managed runtime"
                    : "Not linked / unknown",
                },
                ...machines
                  .filter((m) => m.state === "active")
                  .map((m) => ({ value: m.id, label: m.name })),
              ]}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            These details describe your deployment. They do not configure
            routing, access policies or machine connections.
          </p>
          <div>
            <Button size="sm" disabled={busy} type="submit">
              {busy ? "Saving…" : "Verify passkey and save"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

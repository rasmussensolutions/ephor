import type { MachineList } from "@ephor/api/machines";
import type { CatalogItem, ServiceTechnology } from "@ephor/api/services";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, errorMessage, signIn } from "@/lib/auth";
import type { ServiceList } from "@/lib/services";
import { ServiceIcon } from "./service-icon";

export function CatalogForm({
  machines,
  workers,
  onSaved,
  onBusyChange,
  initialMachineId,
  databasesOnly = false,
}: {
  machines: MachineList["machines"];
  workers: ServiceList["workers"];
  onSaved: (id: string, message: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  initialMachineId?: string;
  databasesOnly?: boolean;
}) {
  const formId = useId();
  const [apps, setApps] = useState<CatalogItem[]>([]),
    [selected, setSelected] = useState<CatalogItem | null>(null);
  const [search, setSearch] = useState(""),
    [machine, setMachine] = useState(""),
    [name, setName] = useState(""),
    [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const submitting = useRef(false);
  const [created, setCreated] = useState<{
    id: string;
    deploymentError: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    api<{ apps: CatalogItem[] }>("/services/catalog")
      .then((r) => {
        if (active) setApps(r.apps);
      })
      .catch(() => {
        if (active)
          setError("Could not load the catalog. Close and reopen to retry.");
      });
    return () => {
      active = false;
    };
  }, []);
  const ready = (id: string) =>
    workers.some(
      (w) =>
        w.machine_id === id &&
        Number(w.version) >= 3 &&
        Number(w.last_seen) > Date.now() - 120000,
    );
  async function deploy(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      let r = created;
      if (!r) {
        setProgress("Confirm with your passkey to deploy this app…");
        await signIn();
        setProgress("Creating your service and queuing deployment…");
        r = await api<{ id: string; deploymentError: string | null }>(
          "/services/catalog/deploy",
          {
            template: selected.id,
            machineId: machine,
            name,
            domain: selected.web ? domain : null,
          },
        );
      }
      setCreated(r);
      setProgress("Opening your service…");
      await onSaved(
        r.id,
        r.deploymentError
          ? `App saved. ${errorMessage(r.deploymentError)}`
          : "App deployment queued. Open Setup & data for access credentials and backups.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not deploy app.");
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusyChange(false);
      setProgress("");
    }
  }
  return (
    <div className="space-y-5">
      {error && !selected && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!selected ? (
        <>
          <Input
            aria-label="Search app catalog"
            placeholder="Search apps or categories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="grid gap-3">
            {apps
              .filter(
                (a) =>
                  (!databasesOnly || a.category === "Databases") &&
                  `${a.name} ${a.category}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              )
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="flex gap-4 rounded-xl border bg-card p-4 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setSelected(a);
                    setName(a.name);
                    setMachine(
                      initialMachineId ??
                        machines.find((m) => ready(m.id))?.id ??
                        "",
                    );
                  }}
                >
                  <ServiceIcon
                    source={{
                      type: "catalog",
                      technology: a.technology as ServiceTechnology | null,
                    }}
                    image={a.components.at(-1)?.image ?? ""}
                    size={24}
                  />
                  <span>
                    <span className="block font-medium">{a.name}</span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {a.description}
                    </span>
                    <span className="mt-2 block text-xs text-muted-foreground">
                      {a.category} · {a.components.length} container
                      {a.components.length > 1 ? "s" : ""} · {a.memoryMb} MiB
                      budget
                    </span>
                  </span>
                </button>
              ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Reviewed templates with pinned images and persistent storage.
            Templates and data remain on your own infrastructure.
          </p>
        </>
      ) : (
        <form onSubmit={deploy} className="space-y-5" aria-busy={busy}>
          <fieldset disabled={busy || !!created} className="min-w-0 space-y-5">
            <Button
              variant="ghost"
              type="button"
              onClick={() => setSelected(null)}
            >
              ← All apps
            </Button>
            <div>
              <h3 className="text-lg font-semibold">{selected.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {selected.description}
              </p>
            </div>
            <label htmlFor="catalog-name" className="block space-y-2 text-sm">
              <span>Service name</span>
              <Input
                id="catalog-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
              />
            </label>
            <label
              className="block space-y-2 text-sm"
              htmlFor={`${formId}-machine`}
            >
              <span>Machine</span>
              <Select
                id={`${formId}-machine`}
                disabled={busy || !!created}
                value={machine}
                onValueChange={(next) => setMachine(next)}
                required
                className="w-full"
                placeholder="Choose a machine"
                options={machines.map((m) => {
                  const available = ready(m.id);
                  return {
                    value: m.id,
                    label: available
                      ? m.name
                      : `${m.name} · Update deployment worker`,
                    disabled: !available,
                  };
                })}
              />
            </label>
            {!machines.some((m) => ready(m.id)) && (
              <p className="text-sm text-muted-foreground">
                Connect a machine to get started. For an existing machine, check
                Deployments in its settings.
              </p>
            )}
            {selected.web && (
              <label
                htmlFor="catalog-domain"
                className="block space-y-2 text-sm"
              >
                <span>Domain</span>
                <Input
                  id="catalog-domain"
                  placeholder="example.com or app.example.com"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  required
                />
                <span className="block text-xs text-muted-foreground">
                  Point its DNS A record to this machine. Ephor provisions HTTPS
                  automatically. Root domains and subdomains both work.
                </span>
              </label>
            )}
            <div className="space-y-3 rounded-xl border bg-card p-4 text-sm">
              <p>{selected.components.map((c) => c.name).join(" + ")}</p>
              <p className="text-muted-foreground">
                {selected.memoryMb} MiB container budget, plus 128 MiB free
                headroom. Data persists across restarts.
              </p>
              <p className="text-muted-foreground">
                {selected.web
                  ? "Setup starts behind an access password. Retrieve it from the service page, finish creating your admin account, then publish when ready."
                  : "The database is private. Connection credentials and an SSH tunnel example appear after deployment."}
              </p>
              <p className="text-muted-foreground">{selected.notes}</p>
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {created
                ? "Your service was created, but could not be opened. "
                : ""}
              {error}
            </p>
          )}
          {progress && (
            <p role="status" className="text-sm text-muted-foreground">
              {progress}
            </p>
          )}
          <Button
            type="submit"
            variant="gradient"
            size="action"
            className="w-full"
            disabled={busy || (!created && !ready(machine))}
          >
            {busy
              ? "Please wait…"
              : created
                ? "Open service"
                : `Deploy ${selected.name}`}
          </Button>
        </form>
      )}
    </div>
  );
}

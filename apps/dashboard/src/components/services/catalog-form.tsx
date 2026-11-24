import type { MachineList } from "@ephor/api/machines";
import type { CatalogItem, ServiceTechnology } from "@ephor/api/services";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

import { api, errorMessage, reauthenticate } from "@/lib/auth";
import type { ServiceList } from "@/lib/services";
import { ServiceIcon } from "./service-icon";

export function CatalogForm({
  machines,
  workers,
  onSaved,
  onBusyChange,
  onSourceStepChange,
  onTemplateChange,
  initialMachineId,
}: {
  machines: MachineList["machines"];
  workers: ServiceList["workers"];
  onSaved: (id: string, message: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onSourceStepChange: (isSourceStep: boolean) => void;
  onTemplateChange: (name: string) => void;
  initialMachineId?: string;
}) {
  const formId = useId();
  const [loading, setLoading] = useState(true);
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
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const visible = apps.filter((app) =>
    `${app.name} ${app.category}`.toLowerCase().includes(search.toLowerCase()),
  );
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
        await reauthenticate();
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
    <div className="flex min-h-0 flex-1 flex-col">
      {!selected ? (
        <div className="-mx-1 -mt-1 flex min-h-0 flex-1 flex-col gap-4 px-1 pt-1 pb-5">
          {error && !selected && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Input
            variant="toolbar"
            className="w-full shrink-0"
            aria-label="Search app catalog"
            placeholder="Search apps or categories…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul
            aria-label="Templates"
            aria-busy={loading}
            className="-mx-2 min-h-0 flex-1 scroll-fade-y scroll-fade-3 overflow-y-auto overscroll-contain has-[:focus-visible]:scroll-fade-none"
          >
            {visible.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="group flex min-h-12 w-full items-center gap-3 cursor-pointer rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => {
                    setSelected(a);
                    setError("");
                    onTemplateChange(a.name);
                    onSourceStepChange(false);
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
                    size={20}
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium"
                    title={a.name}
                  >
                    {a.name}
                  </span>
                  <CaretRightIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
                  />
                </button>
              </li>
            ))}
            {!visible.length && (
              <li>
                <div className="py-10 text-center text-sm text-muted-foreground">
                  {loading
                    ? "Loading templates…"
                    : error
                      ? "Templates could not be loaded."
                      : search
                        ? "No templates match your search."
                        : "No templates available."}
                </div>
              </li>
            )}
          </ul>
        </div>
      ) : (
        <form
          onSubmit={deploy}
          aria-busy={busy}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="-mx-1 -mt-1 min-h-0 flex-1 space-y-5 scroll-fade-y scroll-fade-3 overflow-y-auto overscroll-contain px-1 pt-1 pb-5">
            <fieldset
              disabled={busy || !!created}
              className="min-w-0 space-y-5"
            >
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <label
                  htmlFor="catalog-name"
                  className="grid min-w-0 gap-1.5 text-sm"
                >
                  <span>Service name</span>
                  <Input
                    variant="toolbar"
                    id="catalog-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                  />
                </label>
                <label
                  className="grid min-w-0 gap-1.5 text-sm"
                  htmlFor={`${formId}-machine`}
                >
                  <span>Run on</span>
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
              </div>
              {!machines.some((m) => ready(m.id)) && (
                <p className="text-sm text-muted-foreground">
                  Connect a machine to get started. For an existing machine,
                  check Deployments in its settings.
                </p>
              )}
              {selected.web && (
                <label
                  htmlFor="catalog-domain"
                  className="grid min-w-0 gap-1.5 text-sm"
                >
                  <span>Domain</span>
                  <Input
                    variant="toolbar"
                    id="catalog-domain"
                    placeholder="example.com or app.example.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    required
                  />
                </label>
              )}
            </fieldset>
          </div>
          <div className="shrink-0 space-y-3 py-4">
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
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="raised"
                size="action"
                disabled={busy || !!created}
                onClick={() => {
                  setSelected(null);
                  setError("");
                  setDomain("");
                  onTemplateChange("");
                  onSourceStepChange(true);
                }}
              >
                Back
              </Button>
              <Button
                type="submit"
                variant="gradient"
                size="action"
                disabled={busy || (!created && !ready(machine))}
              >
                {busy
                  ? "Deploying…"
                  : created
                    ? "Open service"
                    : "Deploy service"}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

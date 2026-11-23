import { providers } from "@ephor/api/backups";
import type { MachineList } from "@ephor/api/machines";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  cloneElement,
  type ReactElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, errorMessage, signIn } from "@/lib/auth";
import type { ServiceList } from "@/lib/services";

interface Destination {
  id: string;
  name: string;
  status: string;
  machineId: string;
  provider: string;
  bucket: string;
  endpoint: string;
  region: string;
}
interface Plan {
  id: string;
  service_id: string;
  destination_id: string;
  frequency: string;
  hour: number;
  next_run: number;
}
interface Job {
  id: string;
  service_id: string | null;
  machine_id: string;
  plan_id: string | null;
  destination_id: string;
  action: string;
  status: string;
  snapshot_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
interface Backups {
  destinations: Destination[];
  plans: Plan[];
  jobs: Job[];
}
export const Route = createFileRoute("/_authenticated/settings/backups")({
  head: () => ({ meta: [{ title: "Backups — Ephor" }] }),
  loader: async () => {
    const [backups, services, machines] = await Promise.all([
      api<Backups>("/backups"),
      api<ServiceList>("/services?summary=1"),
      api<MachineList>("/machines"),
    ]);
    return { backups, services, machines };
  },
  component: BackupsPage,
});
function Field({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-2 text-sm">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
function BackupsPage() {
  const initial = Route.useLoaderData();
  const [data, setData] = useState(initial.backups),
    [services, setServices] = useState(initial.services),
    [machines, setMachines] = useState(initial.machines.machines);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [adding, setAdding] = useState(false),
    [provider, setProvider] = useState("r2"),
    [region, setRegion] = useState("auto");
  const [serviceId, setServiceId] = useState(""),
    [destinationId, setDestinationId] = useState(""),
    [frequency, setFrequency] = useState("daily"),
    [hour, setHour] = useState(2);
  const [editing, setEditing] = useState(false);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [restore, setRestore] = useState<Job | null>(null);
  const submitting = useRef(false);
  async function refresh() {
    const [b, s, m] = await Promise.all([
      api<Backups>("/backups"),
      api<ServiceList>("/services?summary=1"),
      api<MachineList>("/machines"),
    ]);
    setData(b);
    setServices(s);
    setMachines(m.machines);
  }
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (!document.hidden)
        void Promise.all([
          api<Backups>("/backups"),
          api<ServiceList>("/services?summary=1"),
          api<MachineList>("/machines"),
        ])
          .then(([b, s, m]) => {
            if (active) {
              setData(b);
              setServices(s);
              setMachines(m.machines);
            }
          })
          .catch(() => {
            if (active)
              setError(
                "Could not refresh backups. Showing the last received status.",
              );
          });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const machineOptions = machines
    .filter((m) => m.status !== "revoked")
    .map((m) => {
      const worker = services.workers.find((w) => w.machine_id === m.id);
      const reason = !worker
        ? "Deployment worker not installed"
        : Number(worker.version) < 4
          ? "Upgrade required"
          : Number(worker.last_seen) <= Date.now() - 120000
            ? "Deployment worker offline"
            : "";
      return { ...m, reason };
    });
  const available = machineOptions.filter((m) => !m.reason);
  const name = (id: string | null) =>
    services.services.find((s) => s.id === id)?.name ?? "Storage connection";
  async function act(
    work: () => Promise<void>,
    message: string,
    inDialog = false,
  ) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    if (inDialog) setDialogError("");
    try {
      await signIn();
      await work();
      setNotice(message);
      try {
        await refresh();
      } catch {
        setError(
          "Changes saved, but the latest status could not be loaded. Please refresh the page.",
        );
      }
    } catch (e) {
      const reportError = inDialog ? setDialogError : setError;
      reportError(e instanceof Error ? e.message : "The operation failed.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function chooseService(id: string) {
    setServiceId(id);
    const p = data.plans.find((p) => p.service_id === id);
    setDestinationId(
      p?.destination_id ??
        data.destinations.find((d) => d.status === "ready")?.id ??
        "",
    );
    setFrequency(p?.frequency ?? "daily");
    setHour(p?.hour ?? 2);
  }
  async function download(plan: Plan) {
    const kit = await api(`/backups/plans/${plan.id}/recovery`, {});
    const blob = new Blob([JSON.stringify(kit, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ephor-recovery-${plan.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const activeJobs = data.jobs.filter((j) =>
    ["queued", "running"].includes(j.status),
  );
  const failures = data.jobs.filter(
    (j) =>
      j.status === "failed" &&
      !data.jobs.some(
        (n) =>
          n.plan_id === j.plan_id &&
          n.destination_id === j.destination_id &&
          n.action === j.action &&
          n.created_at > j.created_at,
      ),
  );
  const selectedPlan = data.plans.find((plan) => plan.service_id === serviceId);
  const latestBackup =
    selectedPlan &&
    data.jobs.find(
      (job) =>
        job.plan_id === selectedPlan.id &&
        job.action === "backup" &&
        job.status === "succeeded",
    );
  const backupInProgress =
    selectedPlan &&
    activeJobs.some(
      (job) => job.plan_id === selectedPlan.id && job.action === "backup",
    );
  return (
    <SettingsPage
      title="Backups"
      description="Manage encrypted backups of your persistent services and restore them as separate services."
    >
      {(error || notice) && (
        <div className="settings-surface space-y-1 rounded-lg px-4 py-3 text-sm sm:px-5">
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
      )}
      {(!available.length || !!failures.length) && (
        <SettingsSection title="Needs attention">
          <SettingsGroup>
            {!available.length && (
              <SettingsRow
                title="No machines available for backups"
                description={
                  <>
                    Connect a machine, or check an existing machine’s
                    deployments in{" "}
                    <Link
                      to="/machines"
                      className="underline underline-offset-4"
                    >
                      machine settings
                    </Link>{" "}
                    to get started.
                  </>
                }
              />
            )}
            {!!failures.length && (
              <SettingsRow
                title={
                  <span role="alert" className="text-destructive">
                    {failures.length} backup operation
                    {failures.length === 1 ? " needs" : "s need"} attention
                  </span>
                }
                description="Check the failed operations in history before relying on your backups."
                control={
                  <Button
                    variant="outline"
                    onClick={() =>
                      document
                        .getElementById("backup-history")
                        ?.scrollIntoView({ block: "start" })
                    }
                  >
                    View history
                  </Button>
                }
              />
            )}
          </SettingsGroup>
        </SettingsSection>
      )}

      <SettingsSection title="Backup destinations">
        <SettingsGroup>
          {data.destinations.map((d) => {
            const checking = data.jobs.some(
              (job) =>
                job.destination_id === d.id &&
                job.action === "check" &&
                ["queued", "running"].includes(job.status),
            );
            const working = activeJobs.some(
              (job) => job.destination_id === d.id,
            );
            const machineId =
              available.find((machine) => machine.id === d.machineId)?.id ??
              available[0]?.id;
            const status =
              d.status === "ready"
                ? "Connection verified"
                : d.status === "pending"
                  ? "Checking connection…"
                  : "Connection failed";
            return (
              <SettingsRow
                key={d.id}
                title={d.name}
                description={
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="truncate"
                      title={`${providers.find((provider) => provider.id === d.provider)?.name} · ${d.bucket}`}
                    >
                      {
                        providers.find((provider) => provider.id === d.provider)
                          ?.name
                      }{" "}
                      · {d.bucket}
                    </span>
                    <span
                      title={status}
                      className={`shrink-0 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[0.6875rem] leading-none ${d.status === "failed" ? "border-destructive/20 text-destructive" : "text-muted-foreground"}`}
                    >
                      {d.status === "ready"
                        ? "Verified"
                        : d.status === "pending"
                          ? "Checking…"
                          : "Failed"}
                    </span>
                  </div>
                }
                control={
                  <Dialog
                    open={configuring === d.id}
                    onOpenChange={(open, event) => {
                      if (submitting.current) {
                        event.cancel();
                        return;
                      }
                      setDialogError("");
                      setConfiguring(open ? d.id : null);
                    }}
                  >
                    <DialogTrigger
                      render={
                        <Button
                          variant="raised"
                          size="action"
                          disabled={busy}
                        />
                      }
                    >
                      Configure
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Configure {d.name}</DialogTitle>
                        <DialogDescription>
                          Check this destination’s connection or replace its
                          access keys.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogBody>
                        <div className="space-y-5">
                          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
                            <dt className="text-muted-foreground">Provider</dt>
                            <dd>
                              {
                                providers.find(
                                  (provider) => provider.id === d.provider,
                                )?.name
                              }
                            </dd>
                            <dt className="text-muted-foreground">Bucket</dt>
                            <dd className="break-all">{d.bucket}</dd>
                            <dt className="text-muted-foreground">Endpoint</dt>
                            <dd className="break-all">{d.endpoint}</dd>
                            <dt className="text-muted-foreground">Region</dt>
                            <dd>{d.region}</dd>
                            <dt className="text-muted-foreground">Status</dt>
                            <dd
                              className={
                                d.status === "failed"
                                  ? "text-destructive"
                                  : undefined
                              }
                            >
                              {status}
                            </dd>
                          </dl>
                          <Button
                            type="button"
                            variant="raised"
                            size="action"
                            disabled={busy || !machineId || checking}
                            onClick={() =>
                              void act(
                                async () => {
                                  await api(
                                    `/backups/destinations/${d.id}/check`,
                                    { machineId },
                                  );
                                  setConfiguring(null);
                                },
                                "Connection check queued.",
                                true,
                              )
                            }
                          >
                            {checking
                              ? "Checking connection…"
                              : "Check connection"}
                          </Button>
                          <form
                            className="space-y-4 border-t pt-5"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const form = event.currentTarget;
                              const values = Object.fromEntries(
                                new FormData(form),
                              );
                              void act(
                                async () => {
                                  await api(
                                    `/backups/destinations/${d.id}/credentials`,
                                    { ...values, machineId },
                                  );
                                  form.reset();
                                  setConfiguring(null);
                                },
                                "Access keys updated. A fresh connection check is queued. Download updated recovery kits after verification.",
                                true,
                              );
                            }}
                          >
                            <div className="space-y-1">
                              <h3 className="text-sm font-medium">
                                Access keys
                              </h3>
                              <p className="text-xs leading-5 text-muted-foreground">
                                Your current keys are saved. Enter both fields
                                to replace them.
                              </p>
                            </div>
                            <fieldset disabled={busy} className="space-y-4">
                              <Field
                                label={
                                  d.provider === "b2"
                                    ? "New application key ID"
                                    : "New access key ID"
                                }
                              >
                                <Input
                                  name="accessKey"
                                  required
                                  autoComplete="off"
                                />
                              </Field>
                              <Field
                                label={
                                  d.provider === "b2"
                                    ? "New application key"
                                    : "New secret access key"
                                }
                              >
                                <Input
                                  name="secretKey"
                                  type="password"
                                  required
                                  autoComplete="new-password"
                                />
                              </Field>
                            </fieldset>
                            {!machineId && (
                              <p className="text-xs text-muted-foreground">
                                Connect a machine with an up-to-date deployment
                                worker to check this destination or update its
                                keys.
                              </p>
                            )}
                            {working && (
                              <p className="text-xs text-muted-foreground">
                                Wait for the current storage operation to finish
                                before updating access keys.
                              </p>
                            )}
                            {dialogError && (
                              <p
                                role="alert"
                                className="text-sm text-destructive"
                              >
                                {dialogError}
                              </p>
                            )}
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                type="button"
                                variant="raised"
                                size="action"
                                disabled={busy}
                                onClick={() => setConfiguring(null)}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="submit"
                                variant="gradient"
                                size="action"
                                disabled={busy || !machineId || working}
                              >
                                {busy ? "Working…" : "Update & check"}
                              </Button>
                            </div>
                          </form>
                        </div>
                      </DialogBody>
                    </DialogContent>
                  </Dialog>
                }
              />
            );
          })}
          <SettingsRow
            title={
              data.destinations.length
                ? "Add a destination"
                : "No backup destinations"
            }
            description="Store encrypted backups in your own S3-compatible storage."
            control={
              <Dialog
                open={adding}
                onOpenChange={(open, event) => {
                  if (submitting.current) {
                    event.cancel();
                    return;
                  }
                  setDialogError("");
                  if (open) {
                    setProvider("r2");
                    setRegion("auto");
                  }
                  setAdding(open);
                }}
              >
                <DialogTrigger
                  render={
                    <Button variant="raised" size="action" disabled={busy} />
                  }
                >
                  Add destination
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add backup destination</DialogTitle>
                    <DialogDescription>
                      Connect your storage and verify it with an encrypted test
                      backup.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogBody>
                    <form
                      id="backup-storage-form"
                      className="space-y-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = e.currentTarget;
                        const b = Object.fromEntries(new FormData(form));
                        void act(
                          async () => {
                            await api("/backups/destinations", {
                              ...b,
                              provider,
                              region,
                            });
                            form.reset();
                            setAdding(false);
                          },
                          "Storage check queued. Ephor will write, read back, and verify an encrypted test backup.",
                          true,
                        );
                      }}
                    >
                      <p className="text-sm text-muted-foreground">
                        Use a private bucket dedicated to Ephor, with access
                        keys restricted to that bucket. Your backup data travels
                        directly from your machine to storage.
                      </p>
                      <fieldset
                        disabled={busy}
                        className="grid gap-4 sm:grid-cols-2"
                      >
                        <Field label="Provider">
                          <Select
                            value={provider}
                            onValueChange={(next) => {
                              setProvider(next);
                              setRegion(
                                providers.find((p) => p.id === next)?.region ??
                                  "",
                              );
                            }}
                            className="w-full"
                            options={providers.map((p) => ({
                              value: p.id,
                              label: p.name,
                            }))}
                          />
                        </Field>
                        <Field label="Storage name">
                          <Input
                            name="name"
                            required
                            maxLength={80}
                            placeholder="Production backups"
                          />
                        </Field>
                        {provider === "r2" ? (
                          <Field label="Cloudflare account ID">
                            <Input
                              name="accountId"
                              required
                              pattern="[a-f0-9]{32}"
                              placeholder="32-character account ID"
                              autoComplete="off"
                            />
                          </Field>
                        ) : (
                          <Field label="Bucket region">
                            <Input
                              value={region}
                              required
                              onChange={(e) => setRegion(e.target.value)}
                              placeholder="Region shown by your provider"
                            />
                          </Field>
                        )}
                        {provider === "r2" && (
                          <Field label="Bucket jurisdiction">
                            <Select
                              name="jurisdiction"
                              defaultValue="default"
                              className="w-full"
                              options={[
                                {
                                  value: "default",
                                  label:
                                    "Default · no jurisdiction restriction",
                                },
                                { value: "eu", label: "European Union (EU)" },
                                { value: "us", label: "United States (US)" },
                                { value: "fedramp", label: "FedRAMP" },
                              ]}
                            />
                          </Field>
                        )}
                        <Field label="Bucket name">
                          <Input
                            name="bucket"
                            required
                            pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]"
                            placeholder="ephor-backups"
                          />
                        </Field>
                        <Field
                          label={
                            provider === "b2"
                              ? "Application key ID"
                              : "Access key ID"
                          }
                        >
                          <Input name="accessKey" required autoComplete="off" />
                        </Field>
                        <Field
                          label={
                            provider === "b2"
                              ? "Application key"
                              : "Secret access key"
                          }
                        >
                          <Input
                            name="secretKey"
                            type="password"
                            required
                            autoComplete="new-password"
                          />
                        </Field>
                        <Field label="Machine to test the connection">
                          <Select
                            name="machineId"
                            required
                            defaultValue=""
                            className="w-full"
                            placeholder="Choose a machine"
                            options={machineOptions.map((m) => ({
                              value: m.id,
                              label: m.reason
                                ? `${m.name} · ${m.reason}`
                                : m.name,
                              disabled: !!m.reason,
                            }))}
                          />
                        </Field>
                      </fieldset>
                      {machineOptions.some((m) => m.reason) && (
                        <div className="text-sm text-muted-foreground">
                          {machineOptions
                            .filter((m) => m.reason)
                            .map((m) => (
                              <p key={m.id}>
                                {m.name}: {m.reason}.
                              </p>
                            ))}
                          <p>
                            Open{" "}
                            <Link
                              to="/machines"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline"
                            >
                              machine settings
                            </Link>{" "}
                            in a new tab to set up or upgrade the deployment
                            worker. This form will update when it reconnects.
                          </p>
                        </div>
                      )}
                      {provider === "r2" && (
                        <p className="text-xs text-muted-foreground">
                          Match the jurisdiction in your bucket’s Cloudflare
                          settings. An EU bucket needs the EU endpoint even when
                          the keys are correct. A location hint alone does not
                          change the jurisdiction.
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Encryption protects the contents. Protection from
                        deletion depends on your storage provider’s versioning
                        or retention settings. Ephor does not enable or verify
                        those settings.
                      </p>
                      {dialogError && (
                        <p role="alert" className="text-sm text-destructive">
                          {dialogError}
                        </p>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="raised"
                          size="action"
                          disabled={busy}
                          onClick={() => setAdding(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="gradient"
                          size="action"
                          disabled={busy || !available.length}
                          type="submit"
                        >
                          {busy ? "Connecting…" : "Check & connect"}
                        </Button>
                      </div>
                    </form>
                  </DialogBody>
                </DialogContent>
              </Dialog>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <Dialog
        open={editing}
        onOpenChange={(open, event) => {
          if (submitting.current) {
            event.cancel();
            return;
          }
          setDialogError("");
          setEditing(open);
        }}
      >
        <SettingsSection title="Backup schedules">
          <SettingsGroup>
            {data.plans.map((plan) => {
              const destination = data.destinations.find(
                (d) => d.id === plan.destination_id,
              );
              const active = activeJobs.some(
                (job) => job.plan_id === plan.id && job.action === "backup",
              );
              return (
                <SettingsRow
                  key={plan.id}
                  title={
                    <span className="flex items-center gap-2">
                      {name(plan.service_id)}
                      {active && (
                        <span className="rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-normal text-muted-foreground">
                          Backing up…
                        </span>
                      )}
                    </span>
                  }
                  description={
                    <>
                      {plan.frequency === "manual"
                        ? "Manual only"
                        : `${plan.frequency === "weekly" ? "Sundays" : "Daily"} at ${String(plan.hour).padStart(2, "0")}:00 UTC`}
                      {destination ? ` · ${destination.name}` : ""}
                    </>
                  }
                  control={
                    <DialogTrigger
                      render={
                        <Button
                          variant="raised"
                          size="action"
                          disabled={busy}
                        />
                      }
                      onClick={() => {
                        setScheduleId(plan.id);
                        chooseService(plan.service_id);
                      }}
                    >
                      Configure
                    </DialogTrigger>
                  }
                />
              );
            })}
            <SettingsRow
              title={
                data.plans.length
                  ? "Protect another app"
                  : "No backup schedules"
              }
              description={
                !services.services.some(
                  (service) =>
                    service.spec.catalog || service.spec.volumes?.length,
                )
                  ? "Deploy a persistent service from Services to set up its backups."
                  : !data.destinations.some(
                        (destination) => destination.status === "ready",
                      )
                    ? "Connect and verify storage before adding a schedule."
                    : "Choose an app, storage destination, and when to back it up."
              }
              control={
                <DialogTrigger
                  render={
                    <Button
                      variant="raised"
                      size="action"
                      disabled={
                        busy ||
                        !services.services.some(
                          (service) =>
                            service.spec.catalog ||
                            service.spec.volumes?.length,
                        ) ||
                        !data.destinations.some(
                          (destination) => destination.status === "ready",
                        )
                      }
                    />
                  }
                  onClick={() => {
                    setScheduleId(null);
                    chooseService("");
                  }}
                >
                  Add schedule
                </DialogTrigger>
              }
            />
          </SettingsGroup>
        </SettingsSection>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {scheduleId
                ? `Configure backups for ${name(serviceId)}`
                : "Add backup schedule"}
            </DialogTitle>
            <DialogDescription>
              Choose when to back up your app and where to store it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-5">
              {dialogError && (
                <p role="alert" className="text-sm text-destructive">
                  {dialogError}
                </p>
              )}
              <form
                id="backup-schedule-form"
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(
                    async () => {
                      await api("/backups/plans", {
                        serviceId,
                        destinationId,
                        frequency,
                        hour,
                      });
                      setEditing(false);
                    },
                    "Backup schedule saved. Download the recovery kit and keep it in your password manager.",
                    true,
                  );
                }}
              >
                <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
                  <Field label="Catalog app">
                    <Select
                      required
                      value={serviceId}
                      disabled={scheduleId !== null}
                      onValueChange={(next) => chooseService(next)}
                      className="w-full"
                      placeholder="Choose an app"
                      options={services.services
                        .filter((s) => s.spec.catalog || s.spec.volumes?.length)
                        .map((s) => ({ value: s.id, label: s.name }))}
                    />
                  </Field>
                  <Field label="Storage">
                    <Select
                      required
                      value={destinationId}
                      disabled={data.plans.some(
                        (p) => p.service_id === serviceId,
                      )}
                      onValueChange={(next) => setDestinationId(next)}
                      className="w-full"
                      placeholder="Choose storage"
                      options={data.destinations
                        .filter(
                          (d) => d.status === "ready" || d.id === destinationId,
                        )
                        .map((d) => ({ value: d.id, label: d.name }))}
                    />
                  </Field>
                  <Field label="Schedule">
                    <Select
                      value={frequency}
                      onValueChange={(next) => setFrequency(next)}
                      className="w-full"
                      options={[
                        { value: "daily", label: "Daily" },
                        { value: "weekly", label: "Weekly · Sunday" },
                        { value: "manual", label: "Manual only" },
                      ]}
                    />
                  </Field>
                  <Field label="Start hour (UTC)">
                    <Select
                      value={String(hour)}
                      disabled={frequency === "manual"}
                      onValueChange={(next) => setHour(Number(next))}
                      className="w-full"
                      options={Array.from({ length: 24 }, (_, h) => ({
                        value: String(h),
                        label: `${String(h).padStart(2, "0")}:00 UTC`,
                      }))}
                    />
                  </Field>
                </fieldset>
                <p className="text-xs leading-5 text-muted-foreground">
                  The app briefly stops to make a consistent temporary copy on
                  your machine, then resumes while the encrypted backup uploads
                  to your storage. Keep enough free disk space for that copy;
                  Ephor removes it after verification. Offline machines catch up
                  when they reconnect. Remote backups are retained until you
                  explicitly remove them with Restic.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="raised"
                    size="action"
                    disabled={busy}
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="gradient"
                    size="action"
                    disabled={busy || !serviceId || !destinationId}
                  >
                    {busy ? "Saving…" : "Save schedule"}
                  </Button>
                </div>
              </form>
              {selectedPlan && (
                <div className="space-y-4 border-t pt-5">
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                    <dt className="text-muted-foreground">
                      Last verified backup
                    </dt>
                    <dd>
                      {latestBackup
                        ? new Date(latestBackup.updated_at).toLocaleString()
                        : "No successful backup yet"}
                    </dd>
                    {selectedPlan.frequency !== "manual" && (
                      <>
                        <dt className="text-muted-foreground">Next backup</dt>
                        <dd>
                          {new Date(selectedPlan.next_run).toLocaleString()}
                          {selectedPlan.next_run < Date.now()
                            ? " · waiting for machine or current operation"
                            : ""}
                        </dd>
                      </>
                    )}
                  </dl>
                  <div className="divide-y">
                    <SettingsRow
                      title="On-demand backup"
                      description="Run a backup using the saved schedule settings."
                      control={
                        <Button
                          variant="raised"
                          size="action"
                          disabled={busy || backupInProgress}
                          onClick={() =>
                            void act(
                              async () => {
                                await api(
                                  `/backups/plans/${selectedPlan.id}/run`,
                                  {},
                                );
                                setEditing(false);
                              },
                              "Backup queued. The app will briefly stop while its data is copied.",
                              true,
                            )
                          }
                        >
                          {backupInProgress
                            ? "Backup in progress"
                            : "Back up now"}
                        </Button>
                      }
                    />
                    <SettingsRow
                      title="Recovery kit"
                      description="Keep a copy in your password manager, separately from your servers."
                      control={
                        <Button
                          variant="raised"
                          size="action"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              async () => {
                                await download(selectedPlan);
                                setEditing(false);
                              },
                              "Recovery kit downloaded. It contains secrets—store it in your password manager, separately from your servers.",
                              true,
                            )
                          }
                        >
                          Download kit
                        </Button>
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <div id="backup-history" className="scroll-mt-6">
        <SettingsSection title="History">
          <SettingsGroup>
            {!data.jobs.length && (
              <SettingsRow
                title="No backup activity yet"
                description="Storage checks, backups, and restores will appear here."
              />
            )}
            {data.jobs.map((j) => (
              <SettingsRow
                key={j.id}
                title={
                  <>
                    {j.action === "check"
                      ? "Storage check"
                      : j.action === "restore"
                        ? "Restore"
                        : "Backup"}{" "}
                    ·{" "}
                    {j.action === "check"
                      ? (data.destinations.find(
                          (d) => d.id === j.destination_id,
                        )?.name ?? "Storage connection")
                      : name(j.service_id)}
                  </>
                }
                description={
                  <>
                    <p>
                      <time dateTime={new Date(j.created_at).toISOString()}>
                        {new Date(j.created_at).toLocaleString()}
                      </time>{" "}
                      ·{" "}
                      <span
                        className={
                          j.status === "failed" ? "text-destructive" : undefined
                        }
                      >
                        {(
                          {
                            queued: "Queued",
                            running: "In progress",
                            succeeded: "Completed",
                            failed: "Failed",
                          } as Record<string, string>
                        )[j.status] ?? j.status}
                      </span>
                    </p>
                    {j.error && (
                      <p className="text-destructive">
                        {errorMessage(j.error)}
                      </p>
                    )}
                  </>
                }
                control={
                  j.action === "backup" && j.status === "succeeded" ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      aria-expanded={restore?.id === j.id}
                      aria-controls={
                        restore?.id === j.id
                          ? `backup-restore-${j.id}`
                          : undefined
                      }
                      onClick={() =>
                        setRestore(restore?.id === j.id ? null : j)
                      }
                    >
                      Restore…
                    </Button>
                  ) : j.action === "restore" && j.service_id ? (
                    <Link
                      to="/services/$serviceId"
                      params={{ serviceId: j.service_id }}
                      className="text-sm underline underline-offset-4"
                    >
                      Open service
                    </Link>
                  ) : undefined
                }
              >
                {restore?.id === j.id && (
                  <form
                    id={`backup-restore-${j.id}`}
                    className="space-y-4 border-t pt-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const b = Object.fromEntries(
                        new FormData(e.currentTarget),
                      );
                      void act(async () => {
                        await api("/backups/restore", {
                          ...b,
                          backupId: restore.id,
                        });
                        setRestore(null);
                      }, "Restore queued. A separate service will appear in Services. Verify it before changing DNS or connecting clients.");
                    }}
                  >
                    <h3 className="text-sm font-medium">
                      Restore {name(restore.service_id)} as a new service
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Original data stays in place. Choose a machine with the
                      same CPU architecture and enough disk space for both the
                      downloaded archives and restored data. Catalog web apps
                      require a new domain and start protected. Custom services
                      restore privately; reconnect their dependencies and verify
                      recovery before adding a domain. Restored processes start
                      with saved variables and may still contact external
                      services.
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Destination machine">
                        <Select
                          name="machineId"
                          required
                          defaultValue=""
                          className="w-full"
                          placeholder="Choose a machine"
                          options={machineOptions.map((m) => ({
                            value: m.id,
                            label: m.reason
                              ? `${m.name} · ${m.reason}`
                              : m.name,
                            disabled: !!m.reason,
                          }))}
                        />
                      </Field>
                      <Field label="New service name">
                        <Input
                          name="name"
                          required
                          maxLength={80}
                          defaultValue={`${name(restore.service_id)} restored`.slice(
                            0,
                            80,
                          )}
                        />
                      </Field>
                      <Field label="New domain (catalog web apps only)">
                        <Input
                          name="domain"
                          placeholder="recovered.example.com"
                        />
                      </Field>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" disabled={busy}>
                        Restore into new service
                      </Button>
                      <Button
                        variant="outline"
                        type="button"
                        disabled={busy}
                        onClick={() => setRestore(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </SettingsRow>
            ))}
          </SettingsGroup>
        </SettingsSection>
      </div>
    </SettingsPage>
  );
}

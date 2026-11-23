import type {
  ProtectionAction,
  ProtectionMachine,
  ProtectionOverview,
  ProtectionParameters,
  UpdatePolicy,
} from "@ephor/api/protections";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { useState } from "react";
import { siDebian, siUbuntu } from "simple-icons";
import crowdsec from "@/assets/protections/crowdsec.png";
import { MaintenanceLink } from "@/components/machines/maintenance-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { api, signIn } from "@/lib/auth";
import { useSecurityData, when } from "./security-data";
import { SecurityLayer } from "./security-layer";
import { MachineProtection } from "./security-protections";
export type ProtectionProduct = "crowdsec" | "updates";
export function ProtectionLogo({ product }: { product: ProtectionProduct }) {
  return product === "crowdsec" ? (
    <img
      src={crowdsec}
      alt=""
      aria-hidden
      width={28}
      height={28}
      className="size-7 shrink-0 object-contain"
    />
  ) : (
    <span aria-hidden className="relative flex w-8 shrink-0 items-center">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-6 fill-[#A81D33]"
      >
        <path d={siDebian.path} />
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="-ml-1 mt-3 size-4 rounded-full bg-card fill-[#E95420]"
      >
        <path d={siUbuntu.path} />
      </svg>
    </span>
  );
}
export function ManagedProtectionsPanel({ machineId }: { machineId?: string }) {
  const { data } = useSecurityData<ProtectionOverview>(
    `/security/protections${machineId ? `?machine=${encodeURIComponent(machineId)}` : ""}`,
    10000,
  );
  const [open, setOpen] = useState<ProtectionProduct | null>(null);
  return (
    <ManagedProtectionsCard
      data={data}
      machineId={machineId}
      open={open}
      onOpen={setOpen}
    />
  );
}
export function ManagedProtectionsCard({
  data,
  machineId,
  open,
  onOpen,
}: {
  data: ProtectionOverview | null;
  machineId?: string;
  open: ProtectionProduct | null;
  onOpen: (product: ProtectionProduct | null) => void;
}) {
  const machines = data?.machines ?? [];
  const online = (m: ProtectionMachine) =>
    m.enabled &&
    !!m.lastSeen &&
    Date.now() - m.lastSeen >= 0 &&
    Date.now() - m.lastSeen < 90000;
  const crowd = machines.filter(
    (m) => m.snapshot?.ownership === "managed",
  ).length;
  const updates = machines.filter((m) => m.snapshot?.updates?.managed).length;
  const detection = machines.filter(
    (m) =>
      online(m) &&
      m.snapshot?.ownership === "managed" &&
      m.snapshot.acquisitionReady,
  ).length;
  const scheduled = machines.filter(
    (m) =>
      online(m) && m.snapshot?.updates?.enabled && m.snapshot.updates.healthy,
  ).length;
  return (
    <>
      <SecurityLayer title="Managed protections" icon={ShieldCheckIcon}>
        <div className="divide-y">
          {(
            [
              {
                id: "crowdsec",
                title: "CrowdSec",
                description: "SSH attack detection & blocking",
                count: crowd,
                status: `${detection} ready · ${crowd} managed`,
              },
              {
                id: "updates",
                title: "Automatic updates",
                description: "unattended-upgrades · Debian & Ubuntu",
                count: updates,
                status: `${scheduled} scheduled · ${updates} managed`,
              },
            ] as const
          ).map((p) => (
            <div key={p.id} className="flex items-start gap-3 p-4">
              <ProtectionLogo product={p.id} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {p.description}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {data ? p.status : "Status unavailable"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpen(p.id)}
                aria-label={`${p.count ? "Manage" : "Install"} ${p.title}`}
              >
                {p.count ? "Manage" : "Install"}
              </Button>
            </div>
          ))}
        </div>
        <p className="border-t p-4 text-xs text-muted-foreground">
          Changes require review and a passkey. Tailscale is optional; public
          services stay public.
        </p>
      </SecurityLayer>
      {open && (
        <ProtectionDialog
          product={open}
          machineId={machineId}
          onClose={() => onOpen(null)}
        />
      )}
    </>
  );
}
function ProtectionDialog({
  product,
  machineId,
  onClose,
}: {
  product: ProtectionProduct;
  machineId?: string;
  onClose: () => void;
}) {
  const { data, error, refresh } = useSecurityData<ProtectionOverview>(
    `/security/protections${machineId ? `?machine=${encodeURIComponent(machineId)}` : ""}`,
    10000,
  );
  const [selected, setSelected] = useState(machineId ?? "");
  const machine =
    data?.machines.find((m) => m.id === selected) ?? data?.machines[0];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <ProtectionLogo product={product} />
            {product === "crowdsec" ? "CrowdSec" : "Automatic updates"}
          </DialogTitle>
          <DialogDescription>
            {product === "crowdsec"
              ? "Detect SSH attacks and manage temporary SSH blocking."
              : "Schedule security updates and optional reboots with unattended-upgrades."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {!data && <p role="status">Loading machines…</p>}
          {data?.machines.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Enroll a machine to manage protections.
            </p>
          )}
          {machine && (
            <>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Machine</span>
                <Select
                  aria-label="Machine"
                  value={machine.id}
                  onValueChange={setSelected}
                  options={(data?.machines ?? []).map((m) => ({
                    value: m.id,
                    label: m.name,
                  }))}
                />
              </div>
              {product === "crowdsec" ? (
                <MachineProtection
                  key={machine.id}
                  machine={machine}
                  installerAvailable={!!data?.installerAvailable}
                  refresh={refresh}
                />
              ) : (
                <UpdateManagement
                  key={machine.id}
                  machine={machine}
                  installerAvailable={!!data?.installerAvailable}
                  refresh={refresh}
                />
              )}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
export function ManagementSetup({
  machine,
}: {
  machine: ProtectionMachine;
  installerAvailable: boolean;
  refresh: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <p className="text-sm">
        Set up, update and repair all Ephor helpers in this machine’s
        Maintenance tab.
      </p>
      <MaintenanceLink id={machine.id} />
    </div>
  );
}
const initialPolicy: UpdatePolicy = {
  days: [1, 2, 3, 4, 5, 6, 7],
  startMinute: 120,
  automaticReboot: false,
  rebootMinute: 240,
};
export const clockTime = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const minuteValue = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function policyDescription(p: UpdatePolicy) {
  return `${p.days.map((d) => days[d - 1]).join(", ")} · check for updates at ${clockTime(p.startMinute)} UTC · ${p.automaticReboot ? `reboot if required at ${clockTime(p.rebootMinute)} UTC` : "automatic reboots off"}`;
}
type Plan = {
  id: string;
  action: ProtectionAction;
  steps: string[];
  parameters: ProtectionParameters;
  expiresAt: number;
};
export function UpdateManagement({
  machine,
  installerAvailable,
  refresh,
}: {
  machine: ProtectionMachine;
  installerAvailable: boolean;
  refresh: () => void;
}) {
  const state = machine.snapshot?.updates;
  const [policy, setPolicy] = useState<UpdatePolicy>(() => {
      const p = state?.policy ?? initialPolicy;
      return {
        days: p.days,
        startMinute: p.startMinute,
        automaticReboot: p.automaticReboot,
        rebootMinute: p.rebootMinute,
      };
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [plan, setPlan] = useState<Plan | null>(null),
    [accepted, setAccepted] = useState(false);
  const online =
    machine.enabled &&
    !!machine.lastSeen &&
    Date.now() - machine.lastSeen < 90000;
  const pending =
    !!state?.busy ||
    machine.jobs.some((j) => ["queued", "running"].includes(j.status));
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update management failed");
    } finally {
      setBusy(false);
    }
  }
  function review(action: ProtectionAction) {
    void run(async () => {
      await signIn();
      setAccepted(false);
      setPlan(
        await api("/security/protections/plan", {
          machineId: machine.id,
          action,
          parameters:
            action === "updates.install" || action === "updates.configure"
              ? { policy }
              : {},
        }),
      );
    });
  }
  if (!machine.enabled || !state || state.scheduleVersion !== 2)
    return (
      <ManagementSetup
        machine={machine}
        installerAvailable={installerAvailable}
        refresh={refresh}
      />
    );
  const validSchedule =
    policy.days.length > 0 &&
    policy.startMinute >= 0 &&
    policy.startMinute < 1440 &&
    policy.rebootMinute >= 0 &&
    policy.rebootMinute < 1440;
  const disabled =
    busy ||
    pending ||
    !online ||
    !state.supported ||
    (state.managed && !state.healthy);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/20 p-4 text-sm">
        <p className="font-medium">
          {!online
            ? "Management offline"
            : state.busy
              ? "Update operation in progress…"
              : !state.managed
                ? state.installed
                  ? "Installed · not managed by Ephor"
                  : "Not installed"
                : !state.healthy
                  ? "Configuration needs local review"
                  : state.enabled
                    ? "Scheduled security updates"
                    : "Updates paused"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{state.detail}</p>
        {state.policy?.windowMinutes !== undefined && (
          <p className="mt-2 text-xs text-muted-foreground">
            Save this schedule to apply independent update and reboot times.
          </p>
        )}
        {state.policy && (
          <p className="mt-2 text-xs">{policyDescription(state.policy)}</p>
        )}
        {state.rebootRequired && (
          <p className="mt-2 text-xs">
            The machine reports that a reboot is required.
          </p>
        )}
      </div>
      {!state.supported && (
        <p className="text-sm text-muted-foreground">
          Requires Debian or Ubuntu with systemd and the latest management
          helper.
        </p>
      )}
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
      <SecurityLayer title="Update schedule" icon={ArrowClockwiseIcon}>
        <div className="space-y-4 p-4">
          <fieldset disabled={disabled} className="space-y-4">
            <legend className="sr-only">Automatic update schedule</legend>
            <div>
              <p className="mb-2 text-xs text-muted-foreground">Days · UTC</p>
              <div className="flex flex-wrap gap-1">
                {days.map((day, i) => (
                  <button
                    type="button"
                    key={day}
                    aria-pressed={policy.days.includes(i + 1)}
                    onClick={() =>
                      setPolicy({
                        ...policy,
                        days: policy.days.includes(i + 1)
                          ? policy.days.filter((d) => d !== i + 1)
                          : [...policy.days, i + 1].sort(),
                      })
                    }
                    className={`rounded-md border px-2 py-1.5 text-xs ${policy.days.includes(i + 1) ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>
            <label className="block space-y-1 text-xs">
              Check for updates at
              <input
                aria-label="Check for updates at"
                type="time"
                value={clockTime(policy.startMinute)}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    startMinute: minuteValue(e.target.value),
                  })
                }
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Times are in UTC. If no security updates are available, nothing is
              installed. Missed checks wait until the next selected day.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={policy.automaticReboot}
                onChange={(e) =>
                  setPolicy({ ...policy, automaticReboot: e.target.checked })
                }
              />
              <span>
                Automatically reboot when required
                <span className="mt-1 block text-xs text-muted-foreground">
                  Only when required, on the selected days. Skipped if users or
                  package operations are active, or safety checks fail.
                </span>
              </span>
            </label>
            {policy.automaticReboot && (
              <label className="block space-y-1 text-xs">
                Reboot at
                <input
                  aria-label="Reboot at"
                  type="time"
                  value={clockTime(policy.rebootMinute)}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      rebootMinute: minuteValue(e.target.value),
                    })
                  }
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </label>
            )}
          </fieldset>
          {!validSchedule && (
            <p role="alert" className="text-xs text-destructive">
              Choose at least one day and valid update and reboot times.
            </p>
          )}
          <Button
            disabled={disabled || !validSchedule}
            onClick={() =>
              review(state.managed ? "updates.configure" : "updates.install")
            }
          >
            {state.managed
              ? "Review schedule"
              : state.installed
                ? "Review and manage"
                : "Review installation"}
          </Button>
        </div>
      </SecurityLayer>
      {state.managed && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={disabled || !state.enabled}
            onClick={() => review("updates.disable")}
          >
            Pause updates
          </Button>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => review("updates.remove")}
          >
            Remove management
          </Button>
        </div>
      )}
      {plan && (
        <section
          aria-label="Review automatic update change"
          className="space-y-3 rounded-lg border border-blue-500/40 p-4"
        >
          <h3 className="text-sm font-medium">Review change</h3>
          {plan.parameters.policy && (
            <p className="text-sm font-medium">
              {policyDescription(plan.parameters.policy)}
            </p>
          )}
          <ul className="list-disc space-y-2 pl-4 text-xs text-muted-foreground">
            {plan.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>
              I reviewed the schedule and the impact on service availability.
            </span>
          </label>
          <p className="text-xs text-muted-foreground">
            Approval expires {when(plan.expiresAt)} and requires a passkey.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={
                !accepted ||
                busy ||
                pending ||
                !online ||
                Date.now() >= plan.expiresAt
              }
              onClick={() =>
                void run(async () => {
                  await signIn();
                  await api("/security/protections/approve", { id: plan.id });
                  setPlan(null);
                  setNotice(
                    "Approved. The machine will apply this reviewed policy.",
                  );
                })
              }
            >
              Approve change
            </Button>
            <Button variant="ghost" onClick={() => setPlan(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}
      <details className="border-t pt-3 text-sm">
        <summary className="cursor-pointer">Recent update jobs</summary>
        <div className="mt-3 space-y-2">
          {machine.jobs
            .filter((j) => j.action.startsWith("updates."))
            .map((j) => (
              <div key={j.id}>
                <p>
                  {j.action.replace("updates.", "")} · {j.status} ·{" "}
                  {when(j.createdAt)}
                </p>
                <p className="text-xs text-muted-foreground">{j.result}</p>
              </div>
            ))}
        </div>
      </details>
    </div>
  );
}

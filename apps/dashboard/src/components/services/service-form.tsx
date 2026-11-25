import { Slider } from "@base-ui/react/slider";
import type { MachineList } from "@ephor/api/machines";
import type {
  ServiceDomains,
  ServiceSource,
  ServiceSpec,
} from "@ephor/api/services";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, reauthenticate } from "@/lib/auth";
import { RepositoryBranchPicker, RepositoryPicker } from "./github-source";
import { RepositoryDirectoryPicker } from "./repository-directory-picker";

export interface EditableService {
  id: string;
  name: string;
  machineId: string;
  domain: string | null;
  domains?: ServiceDomains;
  source: ServiceSource;
  autoDeploy: boolean;
  currentDeployment?: string | null;
  spec: Omit<ServiceSpec, "environment" | "registry"> & {
    environment: string[];
    registry: { server: string; username: string } | null;
  };
}
function ResourceLimit({
  label,
  unit,
  value,
  min,
  inputMin = min,
  max,
  step,
  onChange,
}: {
  label: string;
  unit: "vCPU" | "GB";
  value: number;
  min: number;
  inputMin?: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const [inputValue, setInputValue] = useState<string>();
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-sm">
        <label htmlFor={id}>{label}</label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            variant="toolbar"
            type="number"
            className="w-24 text-right tabular-nums"
            min={inputMin}
            max={max}
            step="any"
            required
            value={inputValue ?? value}
            onChange={(event) => {
              setInputValue(event.target.value);
              onChange(Number(event.target.value));
            }}
            onBlur={() => setInputValue(undefined)}
            aria-describedby={`${id}-unit`}
          />
          <span id={`${id}-unit`} className="w-9 text-xs text-muted-foreground">
            {unit}
          </span>
        </div>
      </div>
      <Slider.Root
        min={min}
        max={max}
        step={step}
        largeStep={step * 10}
        thumbAlignment="edge"
        value={Math.min(max, Math.max(min, value))}
        onValueChange={(next) => {
          setInputValue(undefined);
          onChange(next);
        }}
      >
        <Slider.Control className="flex h-8 w-full cursor-pointer touch-pan-y items-center">
          <Slider.Track className="relative h-1.5 w-full rounded-full bg-border">
            <Slider.Indicator className="rounded-full bg-(--button-gradient-base)" />
            <Slider.Thumb
              className="size-4 rounded-full border border-input bg-card shadow-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-card"
              getAriaLabel={() => label}
              getAriaValueText={(formatted) => `${formatted} ${unit}`}
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
    </div>
  );
}

export function variables(text: string) {
  if (text.trim().startsWith("{"))
    return JSON.parse(text) as Record<string, string>;
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const equal = line.indexOf("=");
    if (equal < 1) throw new Error("Use NAME=value, one variable per line.");
    const name = line.slice(0, equal).trim();
    if (Object.hasOwn(result, name))
      throw new Error(`Duplicate variable: ${name}`);
    result[name] = line.slice(equal + 1);
  }
  return result;
}
export function ServiceForm({
  service,
  machines,
  onSaved,
  onBusyChange,
  onRepositoryChange,
  onImageChange,
  onSourceStepChange,
  initialMachineId,
  initialSourceType = "github",
  fixedSource = false,
  className = "space-y-5 px-6 pb-8",
}: {
  service: EditableService | null;
  machines: MachineList["machines"];
  onSaved: (id: string, message: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onRepositoryChange?: (repository: string, installationId?: string) => void;
  onImageChange?: (image: string) => void;
  onSourceStepChange?: (isSourceStep: boolean) => void;
  className?: string;
  initialMachineId?: string;
  initialSourceType?: "github" | "image";
  fixedSource?: boolean;
}) {
  const formId = useId();
  const [step, setStep] = useState(service ? 1 : 0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    if (fixedSource && previousStep.current !== step) {
      const form = formRef.current;
      const focusTarget = form?.querySelector<HTMLElement>("h2") ?? form;
      focusTarget?.focus({ preventScroll: true });
      formRef.current
        ?.querySelector("[data-deployment-scroll]")
        ?.scrollTo({ top: 0, behavior: "instant" });
    }
    previousStep.current = step;
  }, [fixedSource, step]);
  const [draft, setDraft] = useState({
    name: service?.name ?? "",
    machineId:
      service?.machineId ??
      initialMachineId ??
      machines.find((m) => m.status === "online")?.id ??
      "",
    type: service?.source.type ?? initialSourceType,
    installationId: service?.source.installationId ?? "",
    repositoryId: service?.source.repositoryId ?? "",
    repository: service?.source.repository ?? "",
    branch: service?.source.branch ?? "main",
    image: service?.spec.image ?? "",
    domain: service?.domain ?? "",
    aliases: service?.domains?.aliases.join("\n") ?? "",
    redirect: service?.domains?.redirect ?? true,
    port: service?.spec.port ?? 3000,
    healthPath: service?.spec.healthPath ?? "/",
    memoryMb: service?.spec.memoryMb ?? 512,
    cpus: service?.spec.cpus ?? 0.5,
    volumes:
      service?.spec.volumes
        ?.map((v) => `${v.name}=${v.mountPath}`)
        .join("\n") ?? "",
    environment: "",
    buildEnvironment: "",
    buildType: service?.source.buildType ?? "auto",
    context: service?.source.context ?? ".",
    dockerfile: service?.source.dockerfile ?? "Dockerfile",
    buildMemoryMb: service?.source.buildMemoryMb ?? 512,
    buildCpus: service?.source.buildCpus ?? 1,
    buildMachineId: service?.source.buildMachineId ?? "",
    registryUser: service?.spec.registry?.username ?? "",
    registryPassword: "",
    autoDeploy: service?.autoDeploy ?? true,
  });
  const update = (key: string, value: string | number | boolean) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const hasNextStep = step === 0 || (service !== null && step === 1);
  function goToStep(nextStep: number) {
    setError("");
    setStep(nextStep);
    onSourceStepChange?.(nextStep === 0);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (hasNextStep) {
      if (step === 0 && draft.type === "github") return;
      if (step === 0 && draft.type === "image") {
        const image = draft.image.trim();
        if (!image) {
          setError("Enter a container image.");
          return;
        }
        const imageName = image.split("/").at(-1)?.split(/[:@]/)[0] ?? "";
        setDraft((previous) => ({
          ...previous,
          image,
          name: previous.name || imageName,
        }));
        onImageChange?.(image);
      }
      goToStep(step + 1);
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    try {
      const image =
        draft.type === "github"
          ? (service?.spec.image ?? "ephor.local/pending:latest")
          : draft.image;
      const spec = {
        image,
        volumes: draft.volumes
          .split("\n")
          .filter((l) => l.trim())
          .map((line) => {
            const [name, mountPath, extra] = line.trim().split("=");
            if (!name || !mountPath || extra !== undefined)
              throw new Error("Use volume-name=/mount/path, one per line.");
            return { name, mountPath };
          }),
        port: draft.port,
        healthPath: draft.healthPath,
        memoryMb: draft.memoryMb,
        cpus: draft.cpus,
        environment: draft.environment.trim()
          ? variables(draft.environment)
          : service
            ? undefined
            : {},
        registry: draft.registryPassword
          ? {
              server: image.split("/")[0],
              username: draft.registryUser,
              password: draft.registryPassword,
            }
          : undefined,
      };
      const domains = {
        primary: draft.domain,
        aliases: draft.aliases.split(/[\s,]+/).filter(Boolean),
        redirect: draft.redirect,
      };
      await reauthenticate();
      if (service) {
        await api(`/services/${service.id}/configure`, {
          spec,
          domains,
          source:
            draft.type === "github" && draft.installationId
              ? {
                  type: "github",
                  installationId: draft.installationId,
                  repositoryId: draft.repositoryId,
                  branch: draft.branch,
                  buildType: draft.buildType,
                  context: draft.context,
                  dockerfile: draft.dockerfile,
                  buildMemoryMb: draft.buildMemoryMb,
                  buildCpus: draft.buildCpus,
                  buildMachineId: draft.buildMachineId || undefined,
                }
              : undefined,
          autoDeploy: draft.autoDeploy,
          buildSettings:
            draft.type === "github"
              ? {
                  buildType: draft.buildType,
                  context: draft.context,
                  dockerfile: draft.dockerfile,
                  buildMemoryMb: draft.buildMemoryMb,
                  buildCpus: draft.buildCpus,
                  buildMachineId: draft.buildMachineId || undefined,
                }
              : undefined,
          buildEnvironment: draft.buildEnvironment.trim()
            ? variables(draft.buildEnvironment)
            : undefined,
        });
        await onSaved(
          service.id,
          "Settings saved. Deploy to apply these changes.",
        );
      } else {
        const result = await api<{
          id: string;
          deploymentError: string | null;
        }>("/services/create", {
          name: draft.name,
          machineId: draft.machineId,
          domain: draft.domain,
          domains,
          spec,
          deploy: true,
          autoDeploy: draft.autoDeploy,
          buildEnvironment: variables(draft.buildEnvironment),
          source:
            draft.type === "github"
              ? {
                  type: "github",
                  installationId: draft.installationId,
                  repositoryId: draft.repositoryId,
                  branch: draft.branch,
                  buildType: draft.buildType,
                  context: draft.context,
                  dockerfile: draft.dockerfile,
                  buildMemoryMb: draft.buildMemoryMb,
                  buildCpus: draft.buildCpus,
                  buildMachineId: draft.buildMachineId || undefined,
                }
              : { type: "image" },
        });
        await onSaved(
          result.id,
          result.deploymentError
            ? `Service saved. ${errorMessage(result.deploymentError)} Then choose Deploy.`
            : "Deployment queued. Follow its progress below.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this service.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <form
      ref={formRef}
      onSubmit={submit}
      className={className}
      aria-busy={busy}
      aria-label={fixedSource ? "Service deployment" : undefined}
      tabIndex={fixedSource ? -1 : undefined}
    >
      <div
        data-deployment-scroll={fixedSource || undefined}
        className={
          fixedSource
            ? step === 0 && draft.type === "github"
              ? "-mx-1 -mt-1 flex min-h-0 flex-1 flex-col gap-5 px-1 pt-1 pb-5"
              : "-mx-1 -mt-1 min-h-0 flex-1 space-y-5 scroll-fade-y scroll-fade-3 overflow-y-auto overscroll-contain px-1 pt-1 pb-5"
            : "space-y-5"
        }
      >
        {!fixedSource && (
          <ol
            className="flex gap-3 text-xs text-muted-foreground"
            aria-label="Setup progress"
          >
            {["Source", "Configuration", "Review & deploy"].map((title, i) => (
              <li
                key={title}
                className={i === step ? "font-medium text-primary" : ""}
                aria-current={i === step ? "step" : undefined}
              >
                {i + 1}. {title}
              </li>
            ))}
          </ol>
        )}
        {step === 0 && (
          <>
            {!fixedSource && (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={
                    draft.type === "github" ? "raised" : "subtle-outline"
                  }
                  size="action"
                  aria-pressed={draft.type === "github"}
                  disabled={!!service}
                  onClick={() => update("type", "github")}
                >
                  GitHub repository
                </Button>
                <Button
                  type="button"
                  variant={draft.type === "image" ? "raised" : "subtle-outline"}
                  size="action"
                  aria-pressed={draft.type === "image"}
                  disabled={!!service}
                  onClick={() => update("type", "image")}
                >
                  Container image
                </Button>
              </div>
            )}
            {draft.type === "github" ? (
              <RepositoryPicker
                scrollable={fixedSource}
                value={draft}
                onChange={(v) => {
                  setDraft((d) => ({
                    ...d,
                    ...v,
                    context:
                      d.repositoryId === v.repositoryId &&
                      d.installationId === v.installationId
                        ? d.context
                        : ".",
                    dockerfile:
                      d.repositoryId === v.repositoryId &&
                      d.installationId === v.installationId
                        ? d.dockerfile
                        : "Dockerfile",
                    branch:
                      d.repositoryId === v.repositoryId &&
                      d.installationId === v.installationId
                        ? d.branch
                        : v.branch,
                    name:
                      d.name && d.name !== d.repository.split("/").at(-1)
                        ? d.name
                        : v.repository.split("/").at(-1) || "",
                  }));
                  onRepositoryChange?.(v.repository, v.installationId);
                  goToStep(1);
                }}
              />
            ) : (
              <div className="space-y-4">
                <label
                  htmlFor={`${formId}-1`}
                  className="grid min-w-0 gap-1.5 text-sm"
                >
                  <span>Container image</span>
                  <Input
                    id={`${formId}-1`}
                    variant="toolbar"
                    required
                    placeholder="docker.io/your-team/app:latest"
                    value={draft.image}
                    onChange={(e) => update("image", e.target.value)}
                  />
                </label>
              </div>
            )}
          </>
        )}
        {step === 1 && (
          <>
            {draft.type === "github" && (
              <div
                className={
                  fixedSource && draft.repositoryId
                    ? "grid items-start gap-4 sm:grid-cols-2"
                    : "space-y-5"
                }
              >
                {draft.repositoryId && (
                  <RepositoryBranchPicker
                    key={`${draft.installationId}:${draft.repositoryId}`}
                    value={draft}
                    showRepository={!fixedSource}
                    onChange={(branch) => update("branch", branch)}
                  />
                )}
                <RepositoryDirectoryPicker
                  key={`${draft.installationId}:${draft.repositoryId}:${draft.branch}`}
                  repo={draft}
                  value={draft.context}
                  onChange={(path) => update("context", path)}
                  disabled={busy}
                />
              </div>
            )}
            {!service && (
              <div
                className={
                  fixedSource ? "grid gap-4 sm:grid-cols-2" : "space-y-5"
                }
              >
                <label htmlFor={`${formId}-2`} className="grid gap-1.5 text-sm">
                  <span>Service name</span>
                  <Input
                    variant="toolbar"
                    id={`${formId}-2`}
                    required
                    maxLength={80}
                    value={draft.name}
                    onChange={(e) => update("name", e.target.value)}
                  />
                </label>
                <label
                  className="grid gap-1.5 text-sm"
                  htmlFor={`${formId}-machine`}
                >
                  <span>Run on</span>
                  <Select
                    id={`${formId}-machine`}
                    required
                    value={draft.machineId}
                    onValueChange={(next) => update("machineId", next)}
                    className="w-full"
                    placeholder="Choose a machine"
                    options={machines
                      .filter((m) => m.status !== "revoked")
                      .map((m) => ({
                        value: m.id,
                        label: `${m.name} · ${m.status}`,
                      }))}
                  />
                </label>
              </div>
            )}
            {service && draft.type === "image" && (
              <label
                htmlFor={`${formId}-image`}
                className="grid gap-1.5 text-sm"
              >
                <span>Container image</span>
                <Input
                  variant="toolbar"
                  id={`${formId}-image`}
                  required
                  value={draft.image}
                  onChange={(e) => update("image", e.target.value)}
                />
              </label>
            )}
            <label htmlFor={`${formId}-3`} className="grid gap-1.5 text-sm">
              <span>
                Primary domain{" "}
                <span className="text-muted-foreground">(optional)</span>
              </span>
              <Input
                variant="toolbar"
                id={`${formId}-3`}
                placeholder="example.com or app.example.com"
                value={draft.domain}
                onChange={(e) => update("domain", e.target.value)}
              />
            </label>
            {draft.domain && (
              <Collapsible
                className={
                  fixedSource ? "border-t pt-4" : "rounded-lg border p-3"
                }
              >
                <CollapsibleTrigger className="text-sm">
                  Additional domains and redirects
                </CollapsibleTrigger>
                <CollapsibleContent keepMounted>
                  <div className="mt-3 space-y-3">
                    <label
                      className="grid gap-1.5 text-sm"
                      htmlFor={`${formId}-aliases`}
                    >
                      <span>Other domains, one per line</span>
                      <Textarea
                        id={`${formId}-aliases`}
                        rows={2}
                        placeholder="www.example.com"
                        value={draft.aliases}
                        onChange={(e) => update("aliases", e.target.value)}
                      />
                    </label>
                    <label
                      className="flex items-center gap-2 text-sm"
                      htmlFor={`${formId}-redirect`}
                    >
                      <Checkbox
                        id={`${formId}-redirect`}
                        checked={draft.redirect}
                        onCheckedChange={(checked) =>
                          update("redirect", checked)
                        }
                      />
                      Redirect other domains to the primary domain
                    </label>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            <div className="grid grid-cols-2 gap-4">
              <label
                htmlFor={`${formId}-4`}
                className="grid min-w-0 gap-1.5 text-sm"
              >
                <span>Application port</span>
                <Input
                  variant="toolbar"
                  id={`${formId}-4`}
                  type="number"
                  required
                  min={1024}
                  max={65535}
                  value={draft.port}
                  onChange={(e) => update("port", Number(e.target.value))}
                />
              </label>
              <label
                htmlFor={`${formId}-5`}
                className="grid min-w-0 gap-1.5 text-sm"
              >
                <span>Health check path</span>
                <Input
                  variant="toolbar"
                  id={`${formId}-5`}
                  required
                  value={draft.healthPath}
                  onChange={(e) => update("healthPath", e.target.value)}
                />
              </label>
            </div>
            <section
              aria-labelledby={`${formId}-resources`}
              className="space-y-3 border-t pt-4"
            >
              <h3 id={`${formId}-resources`} className="text-sm font-medium">
                Resources
              </h3>
              <ResourceLimit
                label="App CPU"
                unit="vCPU"
                min={0.1}
                max={32}
                step={0.1}
                value={draft.cpus}
                onChange={(value) => update("cpus", value)}
              />
              <ResourceLimit
                label="App memory"
                unit="GB"
                min={0.5}
                inputMin={0.0625}
                max={64}
                step={0.5}
                value={draft.memoryMb / 1024}
                onChange={(value) =>
                  update("memoryMb", Math.round(value * 1024))
                }
              />
            </section>
            {draft.type === "github" && (
              <section
                aria-labelledby={`${formId}-build-settings`}
                className="space-y-4 border-t pt-4"
              >
                <h3
                  id={`${formId}-build-settings`}
                  className="text-sm font-medium"
                >
                  Build settings
                </h3>
                <label
                  className="grid gap-1.5 text-sm"
                  htmlFor={`${formId}-build-method`}
                >
                  <span>Build method</span>
                  <Select
                    id={`${formId}-build-method`}
                    value={draft.buildType}
                    onValueChange={(next) => update("buildType", next)}
                    className="w-full"
                    options={[
                      {
                        value: "auto",
                        label: "Automatic",
                      },
                      { value: "dockerfile", label: "Dockerfile" },
                      {
                        value: "railpack",
                        label: "Railpack",
                      },
                    ]}
                  />
                </label>
                <label htmlFor={`${formId}-9`} className="grid gap-1.5 text-sm">
                  <span>Dockerfile path</span>
                  <Input
                    variant="toolbar"
                    id={`${formId}-9`}
                    placeholder="Dockerfile"
                    value={draft.dockerfile}
                    onChange={(e) => update("dockerfile", e.target.value)}
                  />
                </label>
                <label
                  className="grid gap-1.5 text-sm"
                  htmlFor={`${formId}-build-machine`}
                >
                  <span>Build machine</span>
                  <Select
                    id={`${formId}-build-machine`}
                    value={draft.buildMachineId}
                    onValueChange={(next) => update("buildMachineId", next)}
                    className="w-full"
                    options={[
                      {
                        value: "",
                        label: "Same as runtime",
                      },
                      ...machines
                        .filter(
                          (m) =>
                            m.status !== "revoked" && m.id !== draft.machineId,
                        )
                        .map((m) => ({ value: m.id, label: m.name })),
                    ]}
                  />
                  {draft.buildMachineId && (
                    <span className="text-xs text-muted-foreground">
                      Requires matching CPU architecture and a build registry.
                    </span>
                  )}
                </label>

                <ResourceLimit
                  label="Build CPU"
                  unit="vCPU"
                  min={0.25}
                  max={16}
                  step={0.25}
                  value={draft.buildCpus}
                  onChange={(value) => update("buildCpus", value)}
                />
                <ResourceLimit
                  label="Build memory"
                  unit="GB"
                  min={0.5}
                  max={32}
                  step={0.5}
                  value={draft.buildMemoryMb / 1024}
                  onChange={(value) =>
                    update("buildMemoryMb", Math.round(value * 1024))
                  }
                />
                <label
                  className="grid gap-1.5 text-sm"
                  htmlFor={`${formId}-build-vars`}
                >
                  <span>Build variables</span>
                  <Textarea
                    id={`${formId}-build-vars`}
                    className="font-mono text-xs md:text-xs"
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="PUBLIC_API_URL=https://api.example.com"
                    value={draft.buildEnvironment}
                    onChange={(e) => update("buildEnvironment", e.target.value)}
                  />
                  {service && (
                    <span className="text-xs text-muted-foreground">
                      Leave blank to keep existing values. Use{" "}
                      <code>{"{}"}</code> to clear them.
                    </span>
                  )}
                </label>
                <label
                  className="flex items-center gap-2 text-sm"
                  htmlFor={`${formId}-auto-deploy`}
                >
                  <Checkbox
                    id={`${formId}-auto-deploy`}
                    checked={draft.autoDeploy}
                    onCheckedChange={(checked) => update("autoDeploy", checked)}
                  />
                  Automatically deploy pushes to {draft.branch}
                </label>
              </section>
            )}
            {draft.type === "image" && (
              <Collapsible className="border-t pt-4">
                <CollapsibleTrigger className="text-sm">
                  Registry access (optional)
                </CollapsibleTrigger>
                <CollapsibleContent keepMounted>
                  <div className="mt-3 space-y-3">
                    <label
                      htmlFor={`${formId}-12`}
                      className="grid gap-1.5 text-sm"
                    >
                      <span>Registry username</span>
                      <Input
                        variant="toolbar"
                        id={`${formId}-12`}
                        value={draft.registryUser}
                        onChange={(e) => update("registryUser", e.target.value)}
                      />
                    </label>
                    <label
                      htmlFor={`${formId}-13`}
                      className="grid gap-1.5 text-sm"
                    >
                      <span>Registry read token</span>
                      <Input
                        variant="toolbar"
                        id={`${formId}-13`}
                        type="password"
                        autoComplete="new-password"
                        value={draft.registryPassword}
                        onChange={(e) =>
                          update("registryPassword", e.target.value)
                        }
                      />
                    </label>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
            <label
              className="grid gap-1.5 text-sm"
              htmlFor={`${formId}-runtime-vars`}
            >
              <span>Runtime variables</span>
              <Textarea
                id={`${formId}-runtime-vars`}
                className="font-mono text-xs md:text-xs"
                rows={4}
                autoComplete="off"
                spellCheck={false}
                placeholder="DATABASE_URL=…"
                value={draft.environment}
                onChange={(e) => update("environment", e.target.value)}
              />
              {service && (
                <span className="text-xs text-muted-foreground">
                  Leave blank to keep existing values. Use <code>{"{}"}</code>{" "}
                  to clear them.
                </span>
              )}
            </label>
            <label
              className="grid gap-1.5 text-sm"
              htmlFor={`${formId}-volumes`}
            >
              <span>Persistent volumes (optional)</span>
              <Textarea
                id={`${formId}-volumes`}
                className="font-mono text-xs md:text-xs"
                rows={3}
                value={draft.volumes}
                onChange={(e) => update("volumes", e.target.value)}
                placeholder="data=/app/data"
              />
              <span className="text-xs text-muted-foreground">
                One volume-name=/mount/path per line. Changes apply on the next
                deployment with a brief stop/start. Keep the same volume name to
                retain its data when changing its path. Removing a line detaches
                the volume; adding the same name later reattaches its data.
              </span>
            </label>
          </>
        )}
        {service && step === 2 && (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/40 p-4 text-sm">
              <p className="font-medium">{draft.name}</p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="break-all">
                  {draft.type === "github"
                    ? `${draft.repository} · ${draft.branch}`
                    : draft.image}
                </dd>
                <dt className="text-muted-foreground">Machine</dt>
                <dd>{machines.find((m) => m.id === draft.machineId)?.name}</dd>
                <dt className="text-muted-foreground">Domain</dt>
                <dd className="break-all">
                  {draft.domain || "Private endpoint"}
                  {draft.aliases.trim() && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {draft.aliases
                        .split(/[\s,]+/)
                        .filter(Boolean)
                        .join(", ")}{" "}
                      ·{" "}
                      {draft.redirect
                        ? "redirect to primary"
                        : "serve application"}
                    </span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Health</dt>
                <dd>
                  Port {draft.port} · {draft.healthPath}
                </dd>
                <dt className="text-muted-foreground">Resources</dt>
                <dd>
                  {draft.cpus} vCPU · {draft.memoryMb / 1024} GB
                </dd>
                {draft.type === "github" && (
                  <>
                    <dt className="text-muted-foreground">Directory</dt>
                    <dd className="break-all font-mono text-xs">
                      {draft.context === "."
                        ? "Repository root"
                        : draft.context}
                    </dd>
                    <dt className="text-muted-foreground">Build</dt>
                    <dd>
                      {draft.buildType} · {draft.buildMemoryMb / 1024} GB ·{" "}
                      {draft.buildCpus} CPU
                    </dd>
                  </>
                )}
              </dl>
            </div>
            <p className="text-sm text-muted-foreground">
              Save these settings, then deploy when you’re ready.
            </p>
            <p className="text-xs text-muted-foreground">
              The app must listen on 0.0.0.0 at the configured port. It runs
              without root access, with a read-only filesystem and writable
              /tmp. Configured volumes retain data; other paths remain
              read-only. Persistent services use stop/start deployments with
              downtime.
            </p>
          </div>
        )}
        {error && !fixedSource && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      {!(step === 0 && draft.type === "github") && (
        <div
          className={fixedSource ? "shrink-0 space-y-3 py-4" : "border-t pt-5"}
        >
          {fixedSource && error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            {step > 0 ? (
              <Button
                type="button"
                variant="subtle-outline"
                size="action"
                disabled={busy}
                onClick={() => {
                  if (step === 1) {
                    onRepositoryChange?.("");
                    onImageChange?.("");
                  }
                  goToStep(step - 1);
                }}
              >
                Back
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="submit"
              variant="gradient"
              size="action"
              disabled={busy}
            >
              {busy
                ? service
                  ? "Saving…"
                  : "Deploying…"
                : hasNextStep
                  ? "Continue"
                  : service
                    ? "Save settings"
                    : "Deploy service"}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

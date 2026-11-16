import type { MachineList } from "@ephor/api/machines";
import type {
  ServiceDomains,
  ServiceSource,
  ServiceSpec,
} from "@ephor/api/services";
import { type FormEvent, useId, useState } from "react";
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
import { api, errorMessage, signIn } from "@/lib/auth";
import { RepositoryPicker } from "./github-source";

export interface EditableService {
  id: string;
  name: string;
  machineId: string;
  domain: string | null;
  domains?: ServiceDomains;
  source: ServiceSource;
  autoDeploy: boolean;
  spec: Omit<ServiceSpec, "environment" | "registry"> & {
    environment: string[];
    registry: { server: string; username: string } | null;
  };
}
const control = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
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
  initialMachineId,
  initialSourceType = "github",
  className = "space-y-5 px-6 pb-8",
}: {
  service: EditableService | null;
  machines: MachineList["machines"];
  onSaved: (id: string, message: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  className?: string;
  initialMachineId?: string;
  initialSourceType?: "github" | "image";
}) {
  const formId = useId();
  const [step, setStep] = useState(service ? 1 : 0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
    memoryMb: service?.spec.memoryMb ?? 256,
    cpus: service?.spec.cpus ?? 0.5,
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
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (step < 2) {
      setStep(step + 1);
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
      await signIn();
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
    <form onSubmit={submit} className={className} aria-busy={busy}>
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
      {step === 0 && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={draft.type === "github" ? "raised" : "subtle-outline"}
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
          {draft.type === "github" ? (
            <RepositoryPicker
              value={draft}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  ...v,
                  name: d.name || v.repository.split("/")[1] || "",
                }))
              }
            />
          ) : (
            <label htmlFor={`${formId}-1`} className="block space-y-2 text-sm">
              <span>Container image</span>
              <Input
                id={`${formId}-1`}
                required
                placeholder="docker.io/your-team/app:latest"
                value={draft.image}
                onChange={(e) => update("image", e.target.value)}
              />
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            {draft.type === "github"
              ? "Ephor builds your code on your machine. No workflow file or registry is needed for builds on the same machine."
              : "Ephor pulls an existing image. Use a version tag or digest for predictable deployments."}
          </p>
        </>
      )}
      {step === 1 && (
        <>
          {!service && (
            <>
              <label
                htmlFor={`${formId}-2`}
                className="block space-y-2 text-sm"
              >
                <span>Service name</span>
                <Input
                  id={`${formId}-2`}
                  required
                  maxLength={80}
                  value={draft.name}
                  onChange={(e) => update("name", e.target.value)}
                />
              </label>
              <label
                className="block space-y-2 text-sm"
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
            </>
          )}
          {service && draft.type === "image" && (
            <label
              htmlFor={`${formId}-image`}
              className="block space-y-2 text-sm"
            >
              <span>Container image</span>
              <Input
                id={`${formId}-image`}
                required
                value={draft.image}
                onChange={(e) => update("image", e.target.value)}
              />
            </label>
          )}
          <label htmlFor={`${formId}-3`} className="block space-y-2 text-sm">
            <span>
              Primary domain{" "}
              <span className="text-muted-foreground">(optional)</span>
            </span>
            <Input
              id={`${formId}-3`}
              placeholder="example.com or app.example.com"
              value={draft.domain}
              onChange={(e) => update("domain", e.target.value)}
            />
            <span className="block text-xs text-muted-foreground">
              Use any root domain or subdomain you own. Ephor handles HTTPS once
              DNS points to your machine.
            </span>
          </label>
          {draft.domain && (
            <Collapsible className="rounded-lg border p-3">
              <CollapsibleTrigger className="text-sm">
                Additional domains and redirects
              </CollapsibleTrigger>
              <CollapsibleContent keepMounted>
                <div className="mt-3 space-y-3">
                  <label
                    className="block space-y-2 text-sm"
                    htmlFor={`${formId}-aliases`}
                  >
                    <span>Other domains, one per line</span>
                    <Textarea
                      id={`${formId}-aliases`}
                      className={control}
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
                      onCheckedChange={(checked) => update("redirect", checked)}
                    />
                    Redirect other domains to the primary domain
                  </label>
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label htmlFor={`${formId}-4`} className="space-y-2 text-sm">
              <span>Application port</span>
              <Input
                id={`${formId}-4`}
                type="number"
                required
                min={1024}
                max={65535}
                value={draft.port}
                onChange={(e) => update("port", Number(e.target.value))}
              />
            </label>
            <label htmlFor={`${formId}-5`} className="space-y-2 text-sm">
              <span>Health check path</span>
              <Input
                id={`${formId}-5`}
                required
                value={draft.healthPath}
                onChange={(e) => update("healthPath", e.target.value)}
              />
            </label>
          </div>
          <label
            className="block space-y-2 text-sm"
            htmlFor={`${formId}-runtime-vars`}
          >
            <span>Runtime variables</span>
            <Textarea
              id={`${formId}-runtime-vars`}
              className={`${control} font-mono text-xs`}
              rows={4}
              autoComplete="off"
              spellCheck={false}
              placeholder="DATABASE_URL=…"
              value={draft.environment}
              onChange={(e) => update("environment", e.target.value)}
            />
            <span className="block text-xs text-muted-foreground">
              {service
                ? `Leave empty to keep ${service.spec.environment.length} existing variables. Enter a complete replacement to change them, or {} to remove all.`
                : "One NAME=value per line, or a JSON object. Encrypted at rest and never sent to the build."}
            </span>
          </label>
          <Collapsible className="rounded-lg border p-3">
            <CollapsibleTrigger className="text-sm">
              Resources
              {draft.type === "github"
                ? ", build settings"
                : " and registry access"}
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <label htmlFor={`${formId}-6`} className="space-y-2 text-sm">
                    <span>App memory (MiB)</span>
                    <Input
                      id={`${formId}-6`}
                      type="number"
                      min={64}
                      max={65536}
                      value={draft.memoryMb}
                      onChange={(e) =>
                        update("memoryMb", Number(e.target.value))
                      }
                    />
                  </label>
                  <label htmlFor={`${formId}-7`} className="space-y-2 text-sm">
                    <span>App CPU cores</span>
                    <Input
                      id={`${formId}-7`}
                      type="number"
                      min={0.1}
                      max={32}
                      step={0.1}
                      value={draft.cpus}
                      onChange={(e) => update("cpus", Number(e.target.value))}
                    />
                  </label>
                </div>
                {draft.type === "github" && (
                  <>
                    <label
                      className="block space-y-2 text-sm"
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
                            label: "Automatic · Dockerfile or Railpack",
                          },
                          { value: "dockerfile", label: "Dockerfile" },
                          {
                            value: "railpack",
                            label: "Railpack · detect framework",
                          },
                        ]}
                      />
                    </label>
                    <label
                      htmlFor={`${formId}-8`}
                      className="block space-y-2 text-sm"
                    >
                      <span>Project directory</span>
                      <Input
                        id={`${formId}-8`}
                        value={draft.context}
                        onChange={(e) => update("context", e.target.value)}
                      />
                    </label>
                    <label
                      htmlFor={`${formId}-9`}
                      className="block space-y-2 text-sm"
                    >
                      <span>Dockerfile path within project directory</span>
                      <Input
                        id={`${formId}-9`}
                        value={draft.dockerfile}
                        onChange={(e) => update("dockerfile", e.target.value)}
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <label
                        htmlFor={`${formId}-10`}
                        className="space-y-2 text-sm"
                      >
                        <span>Build memory (MiB)</span>
                        <Input
                          id={`${formId}-10`}
                          type="number"
                          min={512}
                          max={32768}
                          value={draft.buildMemoryMb}
                          onChange={(e) =>
                            update("buildMemoryMb", Number(e.target.value))
                          }
                        />
                      </label>
                      <label
                        htmlFor={`${formId}-11`}
                        className="space-y-2 text-sm"
                      >
                        <span>Build CPU cores</span>
                        <Input
                          id={`${formId}-11`}
                          type="number"
                          min={0.25}
                          max={16}
                          step={0.25}
                          value={draft.buildCpus}
                          onChange={(e) =>
                            update("buildCpus", Number(e.target.value))
                          }
                        />
                      </label>
                    </div>
                    <label
                      className="block space-y-2 text-sm"
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
                            label: "Same machine · no registry needed",
                          },
                          ...machines
                            .filter(
                              (m) =>
                                m.status !== "revoked" &&
                                m.id !== draft.machineId,
                            )
                            .map((m) => ({ value: m.id, label: m.name })),
                        ]}
                      />
                      <span className="block text-xs text-muted-foreground">
                        A separate machine needs matching CPU architecture and a
                        build registry configured in Settings → Integrations.
                      </span>
                    </label>

                    <label
                      className="block space-y-2 text-sm"
                      htmlFor={`${formId}-build-vars`}
                    >
                      <span>Build variables</span>
                      <Textarea
                        id={`${formId}-build-vars`}
                        className={`${control} font-mono text-xs`}
                        rows={3}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="PUBLIC_API_URL=https://api.example.com"
                        value={draft.buildEnvironment}
                        onChange={(e) =>
                          update("buildEnvironment", e.target.value)
                        }
                      />
                      <span className="block text-xs text-muted-foreground">
                        Leave empty to preserve existing values, or enter {} to
                        clear them. Only provide values the repository is
                        allowed to read during builds. Dockerfiles access them
                        through BuildKit secret mounts; Railpack receives them
                        as build variables. Built client-side values can become
                        public.
                      </span>
                    </label>
                    <label
                      className="flex items-center gap-2 text-sm"
                      htmlFor={`${formId}-auto-deploy`}
                    >
                      <Checkbox
                        id={`${formId}-auto-deploy`}
                        checked={draft.autoDeploy}
                        onCheckedChange={(checked) =>
                          update("autoDeploy", checked)
                        }
                      />
                      Automatically deploy pushes to {draft.branch}
                    </label>
                  </>
                )}
                {draft.type === "image" && (
                  <>
                    <label
                      htmlFor={`${formId}-12`}
                      className="block space-y-2 text-sm"
                    >
                      <span>Registry username (private images only)</span>
                      <Input
                        id={`${formId}-12`}
                        value={draft.registryUser}
                        onChange={(e) => update("registryUser", e.target.value)}
                      />
                    </label>
                    <label
                      htmlFor={`${formId}-13`}
                      className="block space-y-2 text-sm"
                    >
                      <span>Registry read token</span>
                      <Input
                        id={`${formId}-13`}
                        type="password"
                        autoComplete="new-password"
                        value={draft.registryPassword}
                        onChange={(e) =>
                          update("registryPassword", e.target.value)
                        }
                      />
                    </label>
                  </>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
      {step === 2 && (
        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4 text-sm">
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
              {draft.type === "github" && (
                <>
                  <dt className="text-muted-foreground">Build</dt>
                  <dd>
                    {draft.buildType} · {draft.buildMemoryMb} MiB ·{" "}
                    {draft.buildCpus} CPU
                  </dd>
                </>
              )}
            </dl>
          </div>
          <p className="text-sm text-muted-foreground">
            {service
              ? "Save these settings, then deploy when you’re ready."
              : "Ephor will build or pull the image, start the application, and check its health before routing traffic. Follow progress and logs on the service page."}
          </p>
          <p className="text-xs text-muted-foreground">
            The app must listen on 0.0.0.0 at the configured port. It runs
            without root access, with a read-only filesystem and writable /tmp.
            Use an external database or object storage for persistent data.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-between gap-3">
        {step > 0 ? (
          <Button
            type="button"
            variant="subtle-outline"
            size="action"
            disabled={busy}
            onClick={() => setStep(step - 1)}
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
          disabled={
            busy ||
            (step === 0 && draft.type === "github" && !draft.repositoryId)
          }
        >
          {busy
            ? "Saving…"
            : step < 2
              ? "Continue"
              : service
                ? "Save settings"
                : "Deploy service"}
        </Button>
      </div>
    </form>
  );
}

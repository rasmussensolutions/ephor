import type { MachineList } from "@ephor/api/machines";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { siGithub } from "simple-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/auth";
import { deploymentSources } from "@/lib/deployment-sources";
import type { Project } from "@/lib/projects";
import { queryClient } from "@/lib/query";
import type { ServiceList } from "@/lib/services";
import { CatalogForm } from "./catalog-form";
import type { DeploymentOptions } from "./deployment-provider";
import { prefetchFirstRepositoryPage } from "./github-source";
import { ServiceForm } from "./service-form";

function deploymentQueryOptions({ machineId, projectId }: DeploymentOptions) {
  return queryOptions({
    queryKey: ["deployment-options", machineId, projectId],
    queryFn: async () => {
      const [inventory, data, project] = await Promise.all([
        api<MachineList>("/machines"),
        api<ServiceList>("/services?summary=1"),
        projectId
          ? api<Project>(`/projects/${encodeURIComponent(projectId)}`)
          : Promise.resolve(null),
      ]);
      return { machines: inventory.machines, workers: data.workers, project };
    },
    refetchOnWindowFocus: false,
  });
}
export async function prefetchDeploymentData(options: DeploymentOptions) {
  await Promise.allSettled([
    queryClient().prefetchQuery(deploymentQueryOptions(options)),
    !options.source || options.source === "github"
      ? prefetchFirstRepositoryPage()
      : Promise.resolve(),
  ]);
}

export default function DeploymentDialog({
  options,
  open,
  onClose,
  onClosed,
  trigger,
}: {
  options: DeploymentOptions;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
  trigger: HTMLElement | null;
}) {
  const { machineId, projectId } = options;
  const [source, setSource] = useState(options.source ?? "github");
  const [repository, setRepository] = useState("");
  const [template, setTemplate] = useState("");
  const [image, setImage] = useState("");
  const [isSourceStep, setIsSourceStep] = useState(true);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const query = useQuery(deploymentQueryOptions(options));
  const data = query.data;
  const machine = data?.machines.find(
    (item) => item.id === machineId && item.status !== "revoked",
  );
  async function onSaved(id: string, message: string) {
    if (projectId) {
      try {
        await api(`/projects/${encodeURIComponent(projectId)}/add`, {
          serviceId: id,
        });
      } catch {
        message +=
          " Could not add the service to this project. Use Add service in the project to retry.";
      }
    }
    window.dispatchEvent(new Event("ephor:services-changed"));
    await navigate({
      to: "/services/$serviceId",
      params: { serviceId: id },
      search: { deploymentNotice: message },
    });
    onClose();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next) {
          if (busy) details.cancel();
          else onClose();
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
      disablePointerDismissal
    >
      <DialogContent
        showCloseButton={!busy}
        className="h-[min(44rem,calc(100dvh-2rem))] sm:max-w-lg [&>[data-slot=dialog-surface]]:flex-1"
        finalFocus={() =>
          trigger?.isConnected ? trigger : document.getElementById("main")
        }
      >
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">
            {template
              ? `Deploy ${template}`
              : repository
                ? `Deploy ${repository.split("/").at(-1)}`
                : image
                  ? `Deploy ${image.split("/").at(-1)?.split("@")[0]}`
                  : "Deploy service"}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-1 flex-col overflow-hidden pb-0 sm:pb-0">
          {isSourceStep && (
            <Select
              className="mb-4 w-full shrink-0"
              aria-label="Deployment source"
              value={source}
              disabled={busy}
              options={deploymentSources.map(({ mode, label, icon: Icon }) => ({
                value: mode,
                label,
                icon:
                  mode === "github" ? (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="size-4 fill-current"
                      focusable="false"
                    >
                      <path d={siGithub.path} />
                    </svg>
                  ) : (
                    <Icon className="size-4" />
                  ),
              }))}
              onValueChange={(value) => {
                const next = deploymentSources.find(
                  ({ mode }) => mode === value,
                );
                if (next && next.mode !== source) {
                  setRepository("");
                  setTemplate("");
                  setImage("");
                  setSource(next.mode);
                }
              }}
            />
          )}
          {query.isPending ? (
            <div
              role="status"
              className="min-h-0 flex-1 pb-5 text-sm text-muted-foreground"
            >
              Loading deployment options…
            </div>
          ) : query.isError && !data ? (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-5">
              <p role="alert" className="text-sm text-destructive">
                {query.error.message}
              </p>
              <Button variant="raised" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : machineId && !machine ? (
            <p
              role="alert"
              className="min-h-0 flex-1 pb-5 text-sm text-destructive"
            >
              This machine is no longer available for deployments.
            </p>
          ) : data && source === "catalog" ? (
            <CatalogForm
              onTemplateChange={setTemplate}
              machines={data.machines}
              workers={data.workers}
              initialMachineId={machineId}
              onBusyChange={setBusy}
              onSourceStepChange={setIsSourceStep}
              onSaved={onSaved}
            />
          ) : data && source !== "catalog" ? (
            <ServiceForm
              key={source}
              service={null}
              machines={data.machines}
              initialMachineId={machineId}
              initialSourceType={source}
              onRepositoryChange={setRepository}
              onImageChange={setImage}
              fixedSource
              className="flex min-h-0 flex-1 flex-col outline-none"
              onBusyChange={setBusy}
              onSourceStepChange={setIsSourceStep}
              onSaved={onSaved}
            />
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

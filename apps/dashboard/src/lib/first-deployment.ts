import type { Service, ServiceList } from "./services";

export function needsFirstDeployment(service: Service, data: ServiceList) {
  return !(
    service.currentDeployment ||
    data.deployments.some(
      (job) =>
        job.service_id === service.id &&
        ["deploy", "rollback", "restore"].includes(job.action) &&
        job.status === "succeeded",
    )
  );
}

export function firstDeploymentProgress(service: Service, data: ServiceList) {
  const builds = data.builds.filter((job) => job.service_id === service.id);
  const deployments = data.deployments.filter(
    (job) => job.service_id === service.id && job.action === "deploy",
  );
  const latest = [...builds, ...deployments].sort(
    (a, b) => b.created_at - a.created_at,
  )[0];
  // A repository build and its deployment share an ID. Pair only that attempt
  // so a retry cannot inherit errors or output from the previous attempt.
  const build = builds.find((job) => job.id === latest?.id);
  const deployment = deployments.find((job) => job.id === latest?.id);
  const failed = build?.status === "failed" || deployment?.status === "failed";
  const cancelled = ["cancelled", "superseded"].includes(build?.status ?? "");
  const succeeded = deployment?.status === "succeeded";
  const active = !!latest && !failed && !cancelled && !succeeded;
  const stage = deployment
    ? succeeded
      ? 3
      : deployment.status === "queued" && !build
        ? 0
        : 2
    : build
      ? ["building", "publishing", "ready"].includes(build.phase)
        ? 1
        : 0
      : 0;
  const detail = failed
    ? "Review the output below, update your configuration, or try again."
    : cancelled
      ? "This build was cancelled or replaced. You can deploy again when ready."
      : succeeded
        ? "Your first deployment completed successfully."
        : deployment?.status === "running"
          ? "Starting containers and checking the service."
          : deployment?.status === "queued"
            ? "Waiting for the machine to start deployment."
            : build
              ? ({
                  fetching:
                    "Fetching your repository and checking out the commit.",
                  planning: "Preparing the build configuration.",
                  building:
                    "Building your application. Output appears below as it arrives.",
                  publishing: "Publishing the built image for deployment.",
                  ready: "The image is built. Preparing deployment.",
                }[build.phase] ?? "Waiting for a build worker.")
              : "Your service is saved. Start its first deployment when ready.";
  return {
    id: latest?.id ?? "pending",
    build,
    deployment,
    stage,
    active,
    failed,
    cancelled,
    succeeded,
    detail,
    error: deployment?.error || build?.error,
    startedAt: build?.created_at ?? deployment?.created_at,
    finishedAt: !active
      ? (deployment?.updated_at ?? build?.updated_at)
      : undefined,
  };
}

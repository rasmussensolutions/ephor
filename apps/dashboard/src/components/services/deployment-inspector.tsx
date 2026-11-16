import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth";
import { code, type Service, type ServiceList } from "@/lib/services";
import { BuildDiagnose } from "./build-diagnosis";

export function DeploymentInspector({
  id,
  service,
  data,
  onBack,
}: {
  id: string;
  service: Service;
  data: ServiceList;
  onBack: () => void;
}) {
  const [tab, setTab] = useState("Build logs");
  const deployment = data.deployments.find(
    (d) => d.id === id && d.service_id === service.id,
  );
  const build = data.builds.find(
    (b) => b.id === id && b.service_id === service.id,
  );
  return (
    <section className="space-y-5">
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← All deployments
      </Button>
      <div>
        <h2 className="font-medium">
          {deployment?.source_ref
            ? `Commit ${deployment.source_ref.slice(0, 8)}`
            : service.name}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {new Date(
            deployment?.created_at ?? build?.created_at ?? 0,
          ).toLocaleString()}{" "}
          · {deployment?.status ?? build?.status ?? "Unavailable"}
        </p>
      </div>
      <nav aria-label="Deployment logs" className="flex gap-4 border-b">
        {["Build logs", "Deploy logs"].map((label) => (
          <button
            type="button"
            key={label}
            aria-pressed={tab === label}
            onClick={() => setTab(label)}
            className={`border-b-2 px-1 pb-3 text-sm ${tab === label ? "border-foreground" : "border-transparent text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "Build logs" ? (
        <div className="space-y-3">
          {build?.error && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(build.error)}
            </p>
          )}
          {build?.status === "failed" && (
            <BuildDiagnose
              key={build.id}
              serviceId={service.id}
              buildId={build.id}
            />
          )}
          {build?.logs ? (
            <pre className={code}>{build.logs}</pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {build
                ? "No build output has been received yet."
                : service.source.type === "github"
                  ? "No retained build logs are available for this deployment."
                  : "This service deploys a prebuilt image; no build step is required."}
            </p>
          )}
          {build && (
            <p className="text-xs text-muted-foreground">
              {build.phase} · {build.status}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {deployment?.error && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(deployment.error)}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {deployment
              ? "Historical deploy output is not retained for this deployment. Its recorded status and any error are shown here."
              : "Deployment has not started. Build output is available in Build logs."}
          </p>
          {deployment && (
            <dl className="space-y-3 rounded-lg border p-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Operation</dt>
                <dd className="capitalize">
                  {deployment.action} · {deployment.status}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last updated</dt>
                <dd>{new Date(deployment.updated_at).toLocaleString()}</dd>
              </div>
              {deployment.digest && (
                <div>
                  <dt className="text-muted-foreground">Image</dt>
                  <dd className="break-all font-mono text-xs">
                    {deployment.digest}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
    </section>
  );
}

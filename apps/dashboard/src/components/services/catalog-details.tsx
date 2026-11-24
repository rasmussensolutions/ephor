import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, reauthenticate } from "@/lib/auth";
import type { Service } from "@/lib/services";
import { code } from "@/lib/services";

export function CatalogDetails({
  service,
  busy,
  recoveryRequired,
  run,
  onAction,
  onOpenDomains,
}: {
  service: Service;
  onOpenDomains: () => void;
  busy: boolean;
  recoveryRequired: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onAction: (action: string, backupId?: string) => Promise<void>;
}) {
  const [credentials, setCredentials] = useState<Record<string, string> | null>(
    null,
  );
  const [revealing, setRevealing] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!credentials) return;
    const t = setTimeout(() => setCredentials(null), 60000);
    return () => clearTimeout(t);
  }, [credentials]);
  const runtime = service.runtime?.catalog;
  async function reveal() {
    setRevealing(true);
    setError("");
    try {
      await reauthenticate();
      const r = await api<{ credentials: Record<string, string> }>(
        `/services/${service.id}/catalog-access`,
        {},
      );
      setCredentials(r.credentials);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not reveal credentials.",
      );
    } finally {
      setRevealing(false);
    }
  }
  return (
    <div className="space-y-6">
      {service.spec.catalog &&
        ["postgres", "redis", "qdrant"].includes(
          service.spec.catalog.template,
        ) && (
          <DatabaseResources
            key={JSON.stringify(service.spec.catalog.resources)}
            service={service}
            busy={busy}
            run={run}
          />
        )}
      {recoveryRequired && (
        <div
          role="alert"
          className="rounded-xl border border-destructive p-4 text-sm"
        >
          The last operation was interrupted or failed. Data is retained and the
          app is stopped. Check deployment history, then choose{" "}
          {service.spec.catalog ? "Start / restart app" : "Deploy latest"} to
          resume, or restore a recovery point.
        </div>
      )}
      {service.spec.catalog && (
        <section className="space-y-4 rounded-xl border bg-card p-5">
          <h2 className="font-medium">App access & shared secrets</h2>
          <p className="text-sm text-muted-foreground">
            Template {service.spec.catalog?.template} · revision{" "}
            {service.spec.catalog?.version}. Credentials are generated for this
            app and stored encrypted in Ephor.
          </p>
          {service.spec.catalog?.protected && (
            <p className="text-sm">
              Setup protection is enabled in this service’s configuration. Use
              username <strong>admin</strong> and ACCESS_PASSWORD below, then
              complete the app’s own administrator setup.
            </p>
          )}
          {service.spec.catalog?.template === "umami" && (
            <p className="text-sm text-muted-foreground">
              Inside the protected site, Umami initially uses admin / umami.
              Change this password before publishing.
            </p>
          )}
          {service.domain && (
            <p className="text-sm text-muted-foreground">
              Protection changes take effect only after the queued deployment
              succeeds; check Deployments before relying on the change.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {service.domain && (
              <Button variant="outline" onClick={onOpenDomains}>
                Set up domain
              </Button>
            )}
            <Button
              variant="outline"
              disabled={revealing}
              onClick={() => (credentials ? setCredentials(null) : reveal())}
            >
              {credentials ? "Hide credentials" : "Reveal credentials"}
            </Button>
            {service.domain && !service.spec.catalog?.protected && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api(`/services/${service.id}/catalog-access`, {
                      protect: true,
                    });
                    await api(`/services/${service.id}/action`, {
                      action: "deploy",
                    });
                  })
                }
              >
                Protect & restart
              </Button>
            )}
            {service.spec.catalog?.protected && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Have you completed the app’s setup and secured its administrator account? Ephor will take a recovery point and restart this app to remove the extra access password. The app will briefly be unavailable.",
                    )
                  )
                    void run(async () => {
                      await api(`/services/${service.id}/catalog-access`, {
                        publish: true,
                      });
                      await api(`/services/${service.id}/action`, {
                        action: "deploy",
                      });
                    });
                }}
              >
                Publish after setup
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {credentials && (
            <pre className={code}>
              {Object.entries(credentials)
                .map(([k, v]) => `${k}=${v}`)
                .join("\n")}
            </pre>
          )}
          {!service.domain && runtime?.port ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Connect privately through SSH. Replace VPS_IP with your
                machine’s address, then connect your database client to
                localhost:
                {service.spec.port}. Database username is ephor and database
                name is app for PostgreSQL; Redis uses DB_PASSWORD. Qdrant uses
                the api-key header with API_KEY.
              </p>
              <pre
                className={code}
              >{`ssh -N -L ${service.spec.port}:127.0.0.1:${runtime.port} root@VPS_IP`}</pre>
            </div>
          ) : null}
        </section>
      )}
      <section className="space-y-4 rounded-xl border bg-card p-5">
        <h2 className="font-medium">Containers & persistent storage</h2>
        <p className="text-sm text-muted-foreground">
          Private dependencies are isolated on this app’s network. Stopping or
          restarting keeps data. Persistent services deploy with downtime.
          Failed updates retain data and require explicit recovery; automatic
          code rollback is blocked.
        </p>
        {runtime?.components.map((c) => (
          <div key={c.name} className="border-t pt-3 text-sm">
            <p>
              {c.name} · {c.status}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {c.image}
            </p>
          </div>
        ))}
        {runtime?.volumes.map((v) => (
          <div key={v.name} className="border-t pt-3 text-sm">
            <p>
              {v.component} · {v.target}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {v.name}
            </p>
          </div>
        ))}
        {!runtime && (
          <p className="text-sm text-muted-foreground">
            Storage and container details appear after the worker reports.
          </p>
        )}
      </section>
      <section className="space-y-4 rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Local recovery points</h2>
          <Button
            variant="outline"
            disabled={busy || !runtime}
            onClick={() => {
              if (
                confirm(
                  "Create a consistent recovery point? This briefly stops all containers in this app, then resumes them if they were running.",
                )
              )
                void onAction("backup");
            }}
          >
            Create recovery point
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          A stopped-app snapshot includes every data volume. Restoring creates
          new volumes and keeps the original data. Restarts also take a
          snapshot. Up to 20 recovery points are retained; remove old ones
          deliberately.
        </p>
        <p className="text-sm text-muted-foreground">
          These copies live on the same VPS and consume disk space. Use the
          Backups page to schedule encrypted off-site copies and restore onto
          another machine.
        </p>
        {runtime?.backups.map((b) => (
          <div
            key={b.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
          >
            <div>
              <p className="text-sm">
                {new Date(b.createdAt).toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">
                {b.volumes.length} volume{b.volumes.length !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Restore this recovery point? The app will be stopped. Ephor first snapshots the current data, then restores into new volumes. Writes since this recovery point will not appear in the restored app.",
                    )
                  )
                    void onAction("restore", b.id);
                }}
              >
                Restore
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Permanently delete this recovery point? Live app data will be kept.",
                    )
                  )
                    void onAction("delete-backup", b.id);
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        {!runtime?.backups.length && (
          <p className="text-sm text-muted-foreground">
            No recovery points yet.
          </p>
        )}
      </section>
    </div>
  );
}

function DatabaseResources({
  service,
  busy,
  run,
}: {
  service: Service;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [memoryMb, setMemory] = useState(
    service.spec.catalog?.resources?.memoryMb ?? service.spec.memoryMb,
  );
  const [cpus, setCpus] = useState(
    service.spec.catalog?.resources?.cpus ??
      service.topology?.components[0]?.cpus ??
      service.spec.cpus,
  );
  const [redisMaxmemoryMb, setRedisMemory] = useState(
    service.spec.catalog?.resources?.redisMaxmemoryMb ?? 96,
  );
  const redis = service.spec.catalog?.template === "redis";
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      <h2 className="font-medium">Database resources</h2>
      {service.resourcesPending && (
        <p role="status" className="text-sm font-medium">
          Saved resource settings need a restart to take effect.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Save settings, then use Start / restart app to apply them. Restart takes
        a recovery point and interrupts connections. Redis data memory must stay
        at or below 75% of its container memory.
      </p>
      <label className="block text-sm">
        Memory (MiB)
        <input
          className="ml-3 rounded border p-2"
          type="number"
          min={128}
          max={65536}
          value={memoryMb}
          onChange={(e) => setMemory(Number(e.target.value))}
        />
      </label>
      <label className="block text-sm">
        CPU cores
        <input
          className="ml-3 rounded border p-2"
          type="number"
          min={0.1}
          max={32}
          step={0.1}
          value={cpus}
          onChange={(e) => setCpus(Number(e.target.value))}
        />
      </label>
      {redis && (
        <label className="block text-sm">
          Redis data limit (MiB)
          <input
            className="ml-3 rounded border p-2"
            type="number"
            min={16}
            max={Math.floor(memoryMb * 0.75)}
            value={redisMaxmemoryMb}
            onChange={(e) => setRedisMemory(Number(e.target.value))}
          />
        </label>
      )}
      <Button
        disabled={busy}
        variant="outline"
        onClick={() =>
          run(async () => {
            await api(`/services/${service.id}/resources`, {
              memoryMb,
              cpus,
              ...(redis ? { redisMaxmemoryMb } : {}),
            });
          })
        }
      >
        Save resource settings
      </Button>
    </section>
  );
}

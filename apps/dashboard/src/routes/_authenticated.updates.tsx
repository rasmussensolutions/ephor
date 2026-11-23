import type { ReleaseHost, ReleaseStatus } from "@ephor/api/panel";
import { PageHeader } from "@ephor/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api, signIn } from "@/lib/auth";
export const Route = createFileRoute("/_authenticated/updates")({
  head: () => ({ meta: [{ title: "Updates — Ephor" }] }),
  component: UpdatesPage,
});
const guide =
  "https://github.com/rasmussensolutions/ephor/blob/main/docs/panel-updates.md";
function UpdatesPage() {
  const [status, setStatus] = useState<ReleaseStatus | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false);
  const [host, setHost] = useState<ReleaseHost>("cloudflare"),
    [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await api<ReleaseStatus>("/panel/status");
        if (active) {
          setStatus(s);
          setError((old) =>
            old.startsWith("The panel may be restarting.") ? "" : old,
          );
        }
      } catch {
        if (active)
          setError(
            "The panel may be restarting. This page will reconnect automatically.",
          );
      } finally {
        if (active) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  async function action(name: string, body: unknown = {}) {
    setBusy(true);
    setError("");
    try {
      await signIn();
      setStatus(await api<ReleaseStatus>(`/panel/${name}`, body));
      if (name === "configure") {
        setFields({});
        setEditing(false);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The update could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const job = status?.job,
    active = job && !["failed", "complete"].includes(job.stage);
  const labels: Record<string, string> = {
    accountId: "Cloudflare account ID",
    worker: "Worker name",
    databaseId: "D1 database ID",
    serviceId: "Railway service ID",
    environmentId: "Railway environment ID",
    token: host === "railway" ? "Project token" : "Cloudflare API token",
  };
  return (
    <>
      <PageHeader
        title="Panel updates"
        description="Install official Ephor releases here. Your machines are maintained from each machine’s Maintenance tab."
      />
      <div className="space-y-5">
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {!status ? (
          <p role="status">Checking this installation…</p>
        ) : (
          <>
            <section className="settings-surface space-y-4 rounded-xl p-5">
              <dl className="grid gap-4 sm:grid-cols-3">
                <div>
                  <dt>Installed</dt>
                  <dd>{status.running}</dd>
                </div>
                <div>
                  <dt>Latest release</dt>
                  <dd>{status.latest?.version ?? "Not checked"}</dd>
                </div>
                <div>
                  <dt>Hosting</dt>
                  <dd>{status.hosting?.host ?? status.detectedHost}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-3">
                <Button
                  disabled={busy || !!active}
                  onClick={() => void action("check")}
                >
                  Check for updates
                </Button>
                {status.latest?.compatible && status.hosting && (
                  <Button
                    disabled={busy || !!active}
                    onClick={() =>
                      void action("install", {
                        version: status.latest?.version,
                      })
                    }
                  >
                    Update to {status.latest.version}
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={!!active}
                  onClick={() => {
                    setHost(
                      status.hosting?.host ??
                        (status.detectedHost === "unknown"
                          ? "docker"
                          : status.detectedHost),
                    );
                    setFields(
                      status.hosting
                        ? Object.fromEntries(
                            Object.entries(status.hosting).filter(
                              ([k]) => k !== "host",
                            ),
                          )
                        : {},
                    );
                    setEditing(!editing);
                  }}
                >
                  Hosting setup
                </Button>
                {status.latest && (
                  <a
                    className="text-primary underline"
                    href={status.latest.notes}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Release notes
                  </a>
                )}
              </div>
              {!status.hosting && (
                <p>
                  Connect your host once to enable updates. No GitHub repository
                  is required.
                </p>
              )}
              {status.hosting?.host === "docker" && (
                <p className="text-sm text-muted-foreground">
                  Updater:{" "}
                  {status.updaterSeen &&
                  Date.now() - status.updaterSeen < 180000
                    ? "connected"
                    : "waiting for the host updater"}
                </p>
              )}
            </section>
            {editing && (
              <form
                className="settings-surface space-y-4 rounded-xl p-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action("configure", { host, ...fields });
                }}
              >
                <h2 className="font-medium">Connect hosting</h2>
                <Select
                  value={host}
                  onValueChange={(v) => {
                    setHost(v as ReleaseHost);
                    setFields({});
                  }}
                  options={[
                    { value: "cloudflare", label: "Cloudflare Workers" },
                    { value: "railway", label: "Railway" },
                    { value: "docker", label: "Docker" },
                  ]}
                />
                <p className="text-sm">
                  {host === "docker"
                    ? "The Ephor installer connects the host updater automatically. Existing installations can run the adoption command in the guide."
                    : host === "cloudflare"
                      ? "Use a token limited to this account with Workers Scripts Edit and D1 Edit. Secrets and database bindings are preserved."
                      : "Use a Railway project token for this environment. The service must use the Ephor release image with a persistent volume mounted at /data."}{" "}
                  <a
                    className="text-primary underline"
                    href={guide}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Setup guide
                  </a>
                </p>
                {(host === "cloudflare"
                  ? ["accountId", "worker", "databaseId", "token"]
                  : host === "railway"
                    ? ["serviceId", "environmentId", "token"]
                    : []
                ).map((key) => (
                  <label key={key} className="block space-y-1 text-sm">
                    <span>{labels[key]}</span>
                    <input
                      className="w-full rounded-lg border bg-background p-2"
                      required
                      autoComplete="off"
                      spellCheck={false}
                      type={key === "token" ? "password" : "text"}
                      value={fields[key] ?? ""}
                      onChange={(e) =>
                        setFields({ ...fields, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
                <Button disabled={busy} type="submit">
                  Connect host
                </Button>
              </form>
            )}
            {job && (
              <section
                className="settings-surface space-y-3 rounded-xl p-5"
                aria-label="Update progress"
              >
                <h2 className="font-medium">Ephor {job.version}</h2>
                <p role="status">{job.message}</p>
                {job.recovery && (
                  <p className="break-all text-sm text-muted-foreground">
                    Recovery: {job.recovery}
                  </p>
                )}
                {job.stage === "complete" && (
                  <Button onClick={() => location.reload()}>
                    Reload panel
                  </Button>
                )}
                {job.stage === "failed" && (
                  <p className="text-sm">
                    Resolve the reported problem, then check for updates to
                    retry.{" "}
                    <a href={guide} className="text-primary underline">
                      Recovery guide
                    </a>
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

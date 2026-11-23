import type { PanelConfig, PanelHost, PanelStatus } from "@ephor/api/panel";
import { PageHeader } from "@ephor/ui/page-header";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  GitHubConnection,
  type GitHubStatus,
} from "@/components/services/github-source";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { api, signIn } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated/updates")({
  head: () => ({ meta: [{ title: "Updates — Ephor" }] }),
  component: UpdatesPage,
});
const guide =
  "https://github.com/rasmussensolutions/ephor/blob/main/docs/panel-updates.md";
const hosts = [
  { value: "cloudflare", label: "Cloudflare Workers" },
  { value: "railway", label: "Railway" },
  { value: "vps", label: "VPS / Docker" },
  { value: "other", label: "Other host" },
];
const short = (sha?: string) => sha?.slice(0, 12) ?? "Not checked";
const link = "text-primary underline underline-offset-4";

export function hostingHelp(
  host: PanelHost,
  deployment: PanelConfig["deployment"],
) {
  if (deployment === "manual")
    return "Ephor updates your repository. You deploy the new code or image, apply database migrations, and restart the panel on your host. The panel will verify the running version afterward.";
  if (host === "cloudflare")
    return "Connect this repository’s default branch in Workers Builds, use the Ephor build/deploy commands, and disable preview builds. Cloudflare applies migrations and deploys after you install an update.";
  if (host === "railway")
    return "Enable autodeploy for this repository’s default branch and configure the database migration command as a pre-deploy step. Disable PR environments that share production data.";
  return "Your existing deployment pipeline must build this repository’s default branch, apply migrations, and restart Ephor. A VPS or Docker installation does not redeploy merely because its GitHub repository changes.";
}

function HostingSetup({
  status,
  connected,
  onSaved,
}: {
  status: PanelStatus;
  connected: GitHubStatus;
  onSaved: (status: PanelStatus) => void;
}) {
  const [installation, setInstallation] = useState(
    status.config?.installationId ?? connected.installations[0]?.id ?? "",
  );
  const [repository, setRepository] = useState(
    status.config?.repositoryId ?? "",
  );
  const [repos, setRepos] = useState<
    { id: string; name: string; branch: string }[]
  >([]);
  const [page, setPage] = useState(1),
    [more, setMore] = useState(false);
  const [host, setHost] = useState<PanelHost>(
    status.config?.host ?? status.detectedHost,
  );
  const [deployment, setDeployment] = useState<PanelConfig["deployment"]>(
    status.config?.deployment ?? "manual",
  );
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!installation) return;
    let active = true;
    setError("");
    api<{ repositories: typeof repos; more: boolean }>(
      `/panel/github/repositories?installation=${installation}&page=${page}`,
    )
      .then((r) => {
        if (active) {
          setRepos((old) =>
            page === 1 ? r.repositories : [...old, ...r.repositories],
          );
          setMore(r.more);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [installation, page]);
  return (
    <form
      className="settings-surface space-y-4 rounded-xl p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await signIn();
          onSaved(
            await api<PanelStatus>("/panel/configure", {
              installationId: installation,
              repositoryId: repository,
              host,
              deployment,
              confirmed,
            }),
          );
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Could not save update settings.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="font-medium">How this panel is hosted</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-sm" htmlFor="panel-account">
          <span>GitHub account</span>
          <Select
            className="w-full"
            id="panel-account"
            aria-label="GitHub account"
            value={installation}
            options={connected.installations.map((i) => ({
              value: i.id,
              label: i.account,
            }))}
            onValueChange={(v) => {
              setInstallation(v);
              setRepository("");
              setRepos([]);
              setPage(1);
              setConfirmed(false);
            }}
          />
        </label>
        <label className="space-y-1.5 text-sm" htmlFor="panel-repository">
          <span>Panel repository</span>
          <Select
            className="w-full"
            id="panel-repository"
            aria-label="Panel repository"
            placeholder="Choose your deployment copy"
            value={repository}
            options={repos.map((r) => ({
              value: r.id,
              label: `${r.name} · ${r.branch}`,
            }))}
            onValueChange={(v) => {
              setRepository(v);
              setConfirmed(false);
            }}
          />
        </label>
        <label className="space-y-1.5 text-sm" htmlFor="panel-host">
          <span>Hosting provider</span>
          <Select
            className="w-full"
            id="panel-host"
            aria-label="Hosting provider"
            value={host}
            options={hosts}
            onValueChange={(v) => {
              setHost(v as PanelHost);
              setConfirmed(false);
            }}
          />
        </label>
        <label className="space-y-1.5 text-sm" htmlFor="panel-deployment">
          <span>Deployment method</span>
          <Select
            className="w-full"
            id="panel-deployment"
            aria-label="Deployment method"
            value={deployment}
            options={[
              { value: "manual", label: "I deploy updates manually" },
              { value: "git", label: "My host deploys GitHub pushes" },
            ]}
            onValueChange={(v) => {
              setDeployment(v as PanelConfig["deployment"]);
              setConfirmed(false);
            }}
          />
        </label>
      </div>
      {more && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setPage((p) => p + 1)}
        >
          Load more repositories
        </Button>
      )}
      <p className="text-sm text-muted-foreground">
        {hostingHelp(host, deployment)}
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>
          This is the repository that hosts my panel, and its default branch is
          my production branch.{" "}
          {deployment === "git" &&
            "I have configured automatic deployment and migrations as described above."}
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          <a href={guide} target="_blank" rel="noreferrer" className={link}>
            Setup guide
          </a>
        </p>
      )}
      <Button disabled={busy || !repository || !confirmed} type="submit">
        {busy ? "Saving…" : "Save hosting setup"}
      </Button>
    </form>
  );
}

function UpdatesPage() {
  const [status, setStatus] = useState<PanelStatus | null>(null),
    [connected, setConnected] = useState<GitHubStatus | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false);
  const [backup, setBackup] = useState(false);
  const refresh = useCallback(async () => {
    const next = await api<PanelStatus>("/panel/status?live=1");
    setStatus(next);
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<PanelStatus>("/panel/status?live=1");
        if (active) {
          setStatus(next);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error
              ? e.message
              : "Could not check updates. The host may be restarting; this page will retry.",
          );
      } finally {
        if (active) timer = setTimeout(poll, 15000);
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
      const next = await api<PanelStatus>(`/panel/${name}`, body);
      setStatus(next);
      setBackup(false);
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The update could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different reviewed commit requires a new acknowledgement.
  useEffect(() => {
    setBackup(false);
  }, [status?.job?.head]);
  const progress = status?.progress;
  return (
    <>
      <PageHeader
        title="Panel updates"
        description="Review and install tested Ephor updates for this installation. Machine daemon updates remain on the Machines page."
      />
      <div className="space-y-5">
        <GitHubConnection
          purpose="panel"
          onChange={(s) => {
            setConnected(s);
            void refresh().catch(() => {});
          }}
        />
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/30 p-4 text-sm"
          >
            <p>{error}</p>
            <a href={guide} target="_blank" rel="noreferrer" className={link}>
              Panel update guide
            </a>
          </div>
        )}
        {!status ? (
          <p role="status">Loading update settings…</p>
        ) : (
          <>
            {connected?.installations.length && (!status.config || editing) ? (
              <HostingSetup
                key={status.config?.repositoryId ?? "new"}
                status={status}
                connected={connected}
                onSaved={(s) => {
                  setStatus(s);
                  setEditing(false);
                }}
              />
            ) : null}
            <section
              className="settings-surface space-y-4 rounded-xl p-5"
              aria-label="Installed version"
            >
              <dl className="grid gap-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">
                    Running upstream version
                  </dt>
                  <dd className="mt-1 font-mono">{short(status.running)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Repository upstream version
                  </dt>
                  <dd className="mt-1 font-mono">
                    {short(status.repositoryVersion)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Latest tested version
                  </dt>
                  <dd className="mt-1 font-mono">{short(status.latest)}</dd>
                </div>
              </dl>
              {status.config && (
                <div className="text-sm">
                  <p>
                    {status.config.repository} · {status.config.branch} ·{" "}
                    {hosts.find((h) => h.value === status.config?.host)?.label}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {hostingHelp(status.config.host, status.config.deployment)}
                  </p>
                </div>
              )}
              {status.latest && !status.job && (
                <p role="status" className="text-sm">
                  {status.running === status.latest
                    ? "You are running the latest tested upstream version."
                    : status.repositoryVersion === status.latest
                      ? "Your repository is current, but the running panel is older. Deploy the updated repository on your host."
                      : "A tested upstream version is available. Prepare it to check whether it can be applied to your installation."}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => action("check")}
                >
                  Check for updates
                </Button>
                {status.config &&
                  !status.job &&
                  status.latest &&
                  status.latest !== status.repositoryVersion && (
                    <Button disabled={busy} onClick={() => action("prepare")}>
                      Prepare update
                    </Button>
                  )}
                {status.config && !status.job && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing((v) => !v)}
                  >
                    {editing ? "Close hosting setup" : "Hosting setup"}
                  </Button>
                )}
              </div>
              {status.checkedAt && (
                <p className="text-xs text-muted-foreground">
                  Last checked {new Date(status.checkedAt).toLocaleString()}
                </p>
              )}
            </section>
            {status.job && (
              <section
                className="settings-surface space-y-4 rounded-xl p-5"
                aria-label="Update progress"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-medium">
                    Update to {short(status.job.target)}
                  </h2>
                  <a
                    className={`${link} text-sm`}
                    href={`https://github.com/rasmussensolutions/ephor/commit/${status.job.target}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Official changes
                  </a>
                </div>
                <p role="status" className="text-sm">
                  {progress?.message ?? "Checking update progress…"}
                </p>
                <div className="flex flex-wrap gap-3 text-sm">
                  {progress?.runUrl && (
                    <a
                      className={link}
                      href={progress.runUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Preparation logs
                    </a>
                  )}
                  {progress?.pullUrl && (
                    <a
                      className={link}
                      href={progress.pullUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on GitHub
                    </a>
                  )}
                </div>
                {progress?.stage === "prepared" && (
                  <Button disabled={busy} onClick={() => action("review")}>
                    Review update
                  </Button>
                )}
                {progress?.files && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">
                      Changes to your installation ({progress.files.length}{" "}
                      files)
                    </h3>
                    <div className="max-h-96 overflow-auto rounded-lg border">
                      {progress.files.map((file) => (
                        <details
                          key={file.filename}
                          className="border-b p-3 last:border-b-0"
                        >
                          <summary className="cursor-pointer break-all text-sm">
                            <span className="font-mono">{file.filename}</span> ·{" "}
                            {file.status} · +{file.additions} −{file.deletions}
                            {file.filename.startsWith(
                              "packages/api/migrations/",
                            )
                              ? " · Database migration"
                              : ""}
                          </summary>
                          <pre className="mt-3 overflow-auto whitespace-pre-wrap break-all text-xs">
                            {file.patch ??
                              "Diff preview unavailable. Review this file on GitHub before installing."}
                          </pre>
                        </details>
                      ))}
                    </div>
                  </div>
                )}
                {progress?.stage === "ready" && (
                  <>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={backup}
                        onChange={(e) => setBackup(e.target.checked)}
                      />
                      <span>
                        I reviewed these changes and have a usable database
                        backup or recovery point. Reverting code does not
                        reverse database migrations.
                      </span>
                    </label>
                    <Button
                      disabled={busy || !backup}
                      onClick={() =>
                        action("install", {
                          head: progress.head,
                          target: status.job?.target,
                          backupConfirmed: backup,
                        })
                      }
                    >
                      {status.config?.deployment === "manual"
                        ? "Merge update for manual deployment"
                        : "Install update"}
                    </Button>
                  </>
                )}
                {progress?.stage === "updated" && (
                  <div className="flex gap-2">
                    <Button onClick={() => location.reload()}>
                      Reload panel
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => action("reset")}
                    >
                      Finish
                    </Button>
                  </div>
                )}
                {progress?.stage !== "updated" && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          "Clear this update attempt? Existing GitHub branches, pull requests, workflows, and deployments will remain. Resolve or close them in GitHub if needed before retrying.",
                        )
                      )
                        void action("reset");
                    }}
                  >
                    Clear attempt
                  </Button>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

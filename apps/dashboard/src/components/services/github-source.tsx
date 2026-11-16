import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, signIn } from "@/lib/auth";

export interface GitHubStatus {
  configured: boolean;
  slug?: string;
  installations: { id: string; account: string }[];
}
interface Flow {
  url?: string;
  state?: string;
  manifest?: unknown;
  connected?: boolean;
}
function follow(flow: Flow) {
  if (!flow.url || !flow.state) return;
  const url = new URL(flow.url);
  if (url.origin !== "https://github.com")
    throw new Error("Unexpected GitHub URL.");
  sessionStorage.setItem("ephor-github-state", flow.state);
  if (flow.manifest) {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = flow.url;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify(flow.manifest);
    form.append(input);
    document.body.append(form);
    form.submit();
  } else location.assign(flow.url);
}
export function GitHubConnection({
  onChange,
}: {
  onChange?: (status: GitHubStatus) => void;
}) {
  const [status, setStatus] = useState<GitHubStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [callback, setCallback] = useState<Record<string, string> | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    let active = true;
    api<GitHubStatus>("/integrations/github")
      .then((s) => {
        if (active) {
          setStatus(s);
          change.current?.(s);
        }
      })
      .catch(() => {
        if (active) setError("Could not load the GitHub connection.");
      });
    const params = new URLSearchParams(location.search);
    if (params.has("github")) {
      setCallback(Object.fromEntries(params));
      history.replaceState(null, "", location.pathname);
    }
    return () => {
      active = false;
    };
  }, []);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      await signIn();
      if (callback) {
        if (callback.state !== sessionStorage.getItem("ephor-github-state"))
          throw new Error("This connection has expired. Start again.");
        const flow = await api<Flow>("/integrations/github/finish", {
          kind: callback.github,
          state: callback.state,
          code: callback.code,
          installationId: callback.installation_id,
        });
        sessionStorage.removeItem("ephor-github-state");
        setCallback(null);
        if (flow.url) follow(flow);
        else {
          const s = await api<GitHubStatus>("/integrations/github");
          setStatus(s);
          change.current?.(s);
        }
      } else follow(await api<Flow>("/integrations/github/start", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect GitHub.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-surface space-y-3 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <GithubLogoIcon size={24} />
          <div>
            <p className="text-sm font-medium">
              {status?.installations.length
                ? `GitHub · ${status.installations.map((i) => i.account).join(", ")}`
                : "Deploy from GitHub"}
            </p>
            <p className="text-xs text-muted-foreground">
              Choose repositories once. Pushes build and deploy automatically.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {status?.configured && !callback && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                if (
                  !confirm(
                    "Disconnect GitHub and cancel pending builds? Running services will stay online. You can revoke the App installation in GitHub too.",
                  )
                )
                  return;
                setBusy(true);
                setError("");
                try {
                  await signIn();
                  await api("/integrations/github/disconnect", {});
                  const next = await api<GitHubStatus>("/integrations/github");
                  setStatus(next);
                  change.current?.(next);
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Could not disconnect GitHub.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Disconnect
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={connect}
          >
            {busy
              ? "Connecting…"
              : callback
                ? "Finish connecting"
                : status?.installations.length
                  ? "Manage repositories"
                  : "Connect GitHub"}
          </Button>
        </div>
      </div>
      {!status?.configured && (
        <p className="text-xs text-muted-foreground">
          The first connection creates a GitHub App for this Ephor instance. It
          requests read-only code access and push events. No workflow files or
          personal tokens.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          {callback && (
            <button
              type="button"
              className="underline"
              onClick={() => {
                setCallback(null);
                setError("");
              }}
            >
              Start again
            </button>
          )}
        </p>
      )}
    </div>
  );
}
interface Repo {
  id: string;
  name: string;
  branch: string;
  private: boolean;
}
export function RepositoryPicker({
  value,
  onChange,
}: {
  value: {
    installationId: string;
    repositoryId: string;
    repository: string;
    branch: string;
  };
  onChange: (v: {
    installationId: string;
    repositoryId: string;
    repository: string;
    branch: string;
  }) => void;
}) {
  const formId = useId();
  const [status, setStatus] = useState<GitHubStatus | null>(null),
    [repos, setRepos] = useState<Repo[]>([]),
    [branches, setBranches] = useState<string[]>([]),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [more, setMore] = useState(false),
    [branchPage, setBranchPage] = useState(1),
    [branchMore, setBranchMore] = useState(false),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    api<GitHubStatus>("/integrations/github")
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch(() => {
        if (active) setError("Could not load GitHub accounts.");
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const account =
      status?.installations.length === 1 ? status.installations[0] : null;
    if (account && !value.installationId)
      onChange({ ...value, installationId: account.id });
  }, [status, value, onChange]);
  useEffect(() => {
    if (!value.installationId) {
      setRepos([]);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    api<{ repositories: Repo[]; more: boolean }>(
      `/integrations/github/repositories?installation=${value.installationId}&page=${page}`,
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
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [value.installationId, page]);
  useEffect(() => {
    if (!value.repositoryId) {
      setBranches([]);
      return;
    }
    let active = true;
    api<{ branches: string[]; more: boolean }>(
      `/integrations/github/branches?installation=${value.installationId}&repository=${value.repositoryId}&page=${branchPage}`,
    )
      .then((r) => {
        if (active) {
          setBranches((old) =>
            branchPage === 1 ? r.branches : [...old, ...r.branches],
          );
          setBranchMore(r.more);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [value.installationId, value.repositoryId, branchPage]);
  return (
    <div className="space-y-3">
      <label
        className="block space-y-1.5 text-sm"
        htmlFor={`${formId}-account`}
      >
        <span>GitHub account</span>
        <Select
          id={`${formId}-account`}
          required
          value={value.installationId}
          onValueChange={(next) => {
            setPage(1);
            setBranchPage(1);
            onChange({
              installationId: next,
              repositoryId: "",
              repository: "",
              branch: "main",
            });
          }}
          className="w-full"
          placeholder="Choose an account"
          options={
            status?.installations.map((i) => ({
              value: i.id,
              label: i.account,
            })) ?? []
          }
        />
      </label>
      {!status?.installations.length && (
        <p className="text-sm text-muted-foreground">
          <Link
            to="/settings/integrations"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Connect GitHub in Settings
          </Link>{" "}
          to choose a repository.
        </p>
      )}
      {value.installationId && (
        <>
          <Input
            aria-label="Filter repositories"
            placeholder="Find a repository…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label
            className="block space-y-1.5 text-sm"
            htmlFor={`${formId}-repository`}
          >
            <span>Repository</span>
            <Select
              id={`${formId}-repository`}
              required
              value={value.repositoryId}
              onValueChange={(next) => {
                const repo = repos.find((r) => r.id === next);
                setBranchPage(1);
                if (repo)
                  onChange({
                    ...value,
                    repositoryId: repo.id,
                    repository: repo.name,
                    branch: repo.branch,
                  });
              }}
              className="w-full"
              placeholder={
                loading ? "Loading repositories…" : "Choose a repository"
              }
              options={repos
                .filter(
                  (r) =>
                    r.id === value.repositoryId ||
                    r.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((r) => ({
                  value: r.id,
                  label: r.private ? `${r.name} · Private` : r.name,
                }))}
            />
          </label>
          {more && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Load more repositories
            </Button>
          )}
        </>
      )}
      {value.repositoryId && (
        <label
          className="block space-y-1.5 text-sm"
          htmlFor={`${formId}-branch`}
        >
          <span>Production branch</span>
          <Select
            id={`${formId}-branch`}
            required
            value={value.branch}
            onValueChange={(next) => onChange({ ...value, branch: next })}
            className="w-full"
            options={[...new Set([value.branch, ...branches])].map(
              (branch) => ({ value: branch, label: branch }),
            )}
          />
          {branchMore && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setBranchPage((p) => p + 1)}
            >
              Load more branches
            </Button>
          )}
          <span className="block text-xs text-muted-foreground">
            Only pushes to this branch trigger production deployments. Pull
            requests do not run automatically.
          </span>
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FolderSimpleIcon } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { LockSimpleIcon } from "@phosphor-icons/react/dist/csr/LockSimple";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api, reauthenticate } from "@/lib/auth";

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
function follow(flow: Flow, storageKey = "ephor-github-state") {
  if (!flow.url || !flow.state) return;
  const url = new URL(flow.url);
  if (url.origin !== "https://github.com")
    throw new Error("Unexpected GitHub URL.");
  sessionStorage.setItem(storageKey, flow.state);
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
  purpose = "services",
}: {
  onChange?: (status: GitHubStatus) => void;
  purpose?: "services" | "panel";
}) {
  const endpoint =
    purpose === "panel" ? "/panel/github" : "/integrations/github";
  const storageKey = `ephor-${purpose}-github-state`;
  const [status, setStatus] = useState<GitHubStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [callback, setCallback] = useState<Record<string, string> | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    let active = true;
    api<GitHubStatus>(endpoint)
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
  }, [endpoint]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      await reauthenticate();
      if (callback) {
        if (callback.state !== sessionStorage.getItem(storageKey))
          throw new Error("This connection has expired. Start again.");
        const flow = await api<Flow>(`${endpoint}/finish`, {
          kind: callback.github,
          state: callback.state,
          code: callback.code,
          installationId: callback.installation_id,
        });
        sessionStorage.removeItem(storageKey);
        setCallback(null);
        if (flow.url) follow(flow, storageKey);
        else {
          const s = await api<GitHubStatus>(endpoint);
          setStatus(s);
          change.current?.(s);
        }
      } else follow(await api<Flow>(`${endpoint}/start`, {}), storageKey);
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
                : purpose === "panel"
                  ? "Connect panel updates"
                  : "Deploy from GitHub"}
            </p>
            <p className="text-xs text-muted-foreground">
              {purpose === "panel"
                ? "Authorize only the repository that hosts this Ephor panel."
                : "Choose repositories once. Pushes build and deploy automatically."}
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
                    purpose === "panel"
                      ? "Disconnect panel updates? Your panel stays online. Already started GitHub workflows and deployments continue. You can revoke the App installation in GitHub too."
                      : "Disconnect GitHub and cancel pending builds? Running services will stay online. You can revoke the App installation in GitHub too.",
                  )
                )
                  return;
                setBusy(true);
                setError("");
                try {
                  await reauthenticate();
                  await api(`${endpoint}/disconnect`, {});
                  const next = await api<GitHubStatus>(endpoint);
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
          {purpose === "panel"
            ? "Creates a separate GitHub App to prepare updates, run checks, and merge approved changes. Install it only on your panel repository. Your application repositories keep their existing access."
            : "The first connection creates a GitHub App for this Ephor instance. It requests read-only code access and push events. No workflow files or personal tokens."}
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
  pushedAt?: string | null;
}
type RepositorySource = {
  installationId: string;
  repositoryId: string;
  repository: string;
  branch: string;
};

function AccountIcon({
  account,
  version,
}: {
  account: GitHubStatus["installations"][number];
  version: number;
}) {
  const source = `/api/integrations/github/avatar?installation=${encodeURIComponent(account.id)}&v=${version}`;
  const [failedSource, setFailedSource] = useState("");
  return (
    <span
      aria-hidden="true"
      className="relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted text-xs font-semibold uppercase text-foreground"
    >
      {account.account.slice(0, 1)}
      {failedSource !== source && (
        <img
          src={source}
          alt=""
          width={24}
          height={24}
          className="absolute inset-0 size-full object-cover"
          draggable={false}
          decoding="async"
          onError={() => setFailedSource(source)}
        />
      )}
    </span>
  );
}

function useAvatarVersion() {
  const [version, setVersion] = useState(() => Math.floor(Date.now() / 60000));
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) setVersion(Math.floor(Date.now() / 60000));
    };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return version;
}

function pushedLabel(date?: string | null) {
  if (!date) return null;
  const pushed = new Date(date);
  if (Number.isNaN(pushed.getTime())) return null;
  return pushed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(pushed.getFullYear() !== new Date().getFullYear()
      ? { year: "numeric" }
      : {}),
  });
}

export function RepositoryPicker({
  value,
  onChange,
}: {
  value: RepositorySource;
  onChange: (v: RepositorySource) => void;
}) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [accountId, setAccountId] = useState(value.installationId);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [accountError, setAccountError] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [accountAttempt, setAccountAttempt] = useState(0);
  const [repoAttempt, setRepoAttempt] = useState(0);
  const avatarVersion = useAvatarVersion();
  const account =
    status?.installations.find((i) => i.id === accountId) ??
    status?.installations[0];
  const installationId = account?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads accounts.
  useEffect(() => {
    let active = true;
    setAccountError("");
    api<GitHubStatus>("/integrations/github")
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch(() => {
        if (active) setAccountError("Could not load GitHub accounts.");
      });
    return () => {
      active = false;
    };
  }, [accountAttempt]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the current repository page.
  useEffect(() => {
    if (!installationId) return;
    let active = true;
    setLoading(true);
    setError("");
    api<{ repositories: Repo[]; more: boolean }>(
      `/integrations/github/repositories?installation=${encodeURIComponent(installationId)}&page=${page}`,
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
        if (active)
          setError(
            e instanceof Error ? e.message : "Could not load repositories.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [installationId, page, repoAttempt]);
  const visible = repos
    .filter((repo) =>
      repo.name.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  return (
    <section className="space-y-4" aria-label="Import Git repository">
      <div>
        <h2
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight outline-none"
        >
          Import Git Repository
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select a repository to build and deploy.
        </p>
      </div>
      {accountError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
          <p role="alert" className="text-sm text-destructive">
            {accountError}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setAccountAttempt((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      ) : !status ? (
        <div
          role="status"
          className="rounded-xl border bg-card p-6 text-sm text-muted-foreground"
        >
          Loading GitHub accounts…
        </div>
      ) : !account ? (
        <div className="flex flex-col items-start gap-4 rounded-xl border bg-card p-6 sm:flex-row sm:items-center">
          <GithubLogoIcon aria-hidden="true" className="size-8 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Connect GitHub</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Grant access to your repositories to start deploying your code.
            </p>
          </div>
          <Button
            render={<Link to="/settings/integrations" />}
            variant="outline"
          >
            Connect GitHub
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full justify-start gap-2.5 px-3"
                  />
                }
                aria-label={`GitHub account: ${account.account}`}
              >
                <AccountIcon account={account} version={avatarVersion} />
                <span className="min-w-0 flex-1 truncate text-left">
                  {account.account}
                </span>
                <CaretDownIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-(--anchor-width) max-w-(--available-width)">
                {status.installations.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    className="min-h-10 gap-2.5"
                    onClick={() => {
                      if (item.id === installationId) return;
                      setAccountId(item.id);
                      setRepos([]);
                      setPage(1);
                      setMore(false);
                      setError("");
                      setLoading(true);
                    }}
                  >
                    <AccountIcon account={item} version={avatarVersion} />
                    <span className="min-w-0 flex-1 truncate">
                      {item.account}
                    </span>
                    {item.id === installationId && (
                      <CheckIcon aria-label="Selected" className="size-4" />
                    )}
                  </DropdownMenuItem>
                ))}
                <div className="my-1 border-t" />
                <DropdownMenuItem
                  render={<Link to="/settings/integrations" />}
                  className="min-h-10 gap-2.5"
                >
                  <PlusIcon aria-hidden="true" className="size-5" />
                  Manage GitHub access
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="relative min-w-0">
              <MagnifyingGlassIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search repositories"
                placeholder="Search repositories…"
                className="h-11 bg-card pl-10"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              />
            </div>
          </div>
          <div
            className="overflow-hidden rounded-xl border bg-card"
            aria-busy={loading}
          >
            {visible.map((repo) => (
              <div
                key={repo.id}
                className="flex min-h-[4.25rem] items-center gap-3 border-b px-4 py-3 last:border-b-0 sm:gap-4 sm:px-5"
              >
                <FolderSimpleIcon
                  aria-hidden="true"
                  className="size-6 shrink-0 text-muted-foreground"
                />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className="min-w-0 truncate font-medium"
                    title={repo.name}
                  >
                    {repo.name.split("/").at(-1)}
                  </span>
                  {repo.private && (
                    <LockSimpleIcon
                      aria-label="Private repository"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  {pushedLabel(repo.pushedAt) && (
                    <span className="text-sm text-muted-foreground">
                      · {pushedLabel(repo.pushedAt)}
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  className="h-9 bg-foreground px-4 text-background hover:bg-foreground/90"
                  onClick={() =>
                    onChange({
                      installationId: account.id,
                      repositoryId: repo.id,
                      repository: repo.name,
                      branch: repo.branch,
                    })
                  }
                >
                  Import
                  <span className="sr-only"> {repo.name}</span>
                </Button>
              </div>
            ))}
            {!visible.length && !error && (
              <p
                role="status"
                className="px-5 py-10 text-center text-sm text-muted-foreground"
              >
                {loading
                  ? "Loading repositories…"
                  : search.trim()
                    ? "No repositories match your search."
                    : "No repositories available for this account."}
              </p>
            )}
            {error && (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRepoAttempt((n) => n + 1)}
                >
                  Retry
                </Button>
              </div>
            )}
            {more && (
              <div className="border-t px-4 py-3 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={loading || Boolean(error)}
                  onClick={() => setPage((n) => n + 1)}
                >
                  {loading ? "Loading…" : "Load more repositories"}
                </Button>
              </div>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Missing a repository?{" "}
            <Link
              to="/settings/integrations"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Manage GitHub access
            </Link>
            .
          </p>
        </>
      )}
    </section>
  );
}

export function RepositoryBranchPicker({
  value,
  onChange,
}: {
  value: RepositorySource;
  onChange: (branch: string) => void;
}) {
  const formId = useId();
  const [branches, setBranches] = useState<string[]>([]);
  const [branchPage, setBranchPage] = useState(1);
  const [branchMore, setBranchMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reloads the current branch page.
  useEffect(() => {
    if (!value.repositoryId) {
      setBranches([]);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
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
        if (active)
          setError(e instanceof Error ? e.message : "Could not load branches.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [value.installationId, value.repositoryId, branchPage, attempt]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
        <GithubLogoIcon aria-hidden="true" className="size-6 shrink-0" />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Importing from GitHub</p>
          <p className="truncate font-medium">{value.repository}</p>
        </div>
      </div>
      <label className="block space-y-1.5 text-sm" htmlFor={`${formId}-branch`}>
        <span className="flex items-center gap-1.5">
          <GitBranchIcon aria-hidden="true" /> Production branch
        </span>
        <Select
          id={`${formId}-branch`}
          required
          value={value.branch}
          onValueChange={onChange}
          className="w-full"
          options={[...new Set([value.branch, ...branches])].map((branch) => ({
            value: branch,
            label: branch,
          }))}
        />
        {branchMore && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading || Boolean(error)}
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
      {error && (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

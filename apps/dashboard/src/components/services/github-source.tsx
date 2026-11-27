import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { siGithub } from "simple-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

import { api, reauthenticate, request } from "@/lib/auth";
import { apiKey, queryClient } from "@/lib/query";

import { prefetchRepositoryDirectory } from "./repository-directory-picker";

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

export function RepositoryAccountIcon({
  installationId,
  account,
}: {
  installationId: string;
  account: string;
}) {
  const version = useAvatarVersion();
  return (
    <AccountIcon
      account={{ id: installationId, account }}
      version={version}
      bordered={false}
    />
  );
}

function AccountIcon({
  account,
  version,
  bordered = true,
}: {
  account: GitHubStatus["installations"][number];
  version: number;
  bordered?: boolean;
}) {
  const source = `/api/integrations/github/avatar?installation=${encodeURIComponent(account.id)}&v=${version}`;
  const [failedSource, setFailedSource] = useState("");
  return (
    <span
      aria-hidden="true"
      className={`relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-semibold uppercase text-foreground ${bordered ? "border" : ""}`}
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

function accountQueryOptions() {
  return {
    queryKey: apiKey("/integrations/github"),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      request<GitHubStatus>("/integrations/github", undefined, signal),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  };
}
export async function prefetchFirstRepositoryPage() {
  const client = queryClient();
  const accounts = await client.fetchQuery(accountQueryOptions());
  const installationId = accounts.installations[0]?.id;
  if (installationId) {
    await client.prefetchInfiniteQuery(repositoryQueryOptions(installationId));
  }
}

function repositoryQueryOptions(installationId: string) {
  return infiniteQueryOptions({
    queryKey: [...apiKey("/integrations/github/repositories"), installationId],
    queryFn: ({ pageParam, signal }) =>
      request<{ repositories: Repo[]; more: boolean }>(
        `/integrations/github/repositories?installation=${encodeURIComponent(installationId ?? "")}&page=${pageParam}`,
        undefined,
        signal,
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) =>
      lastPage.more ? pages.length + 1 : undefined,
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}
function RepositoryLoading({ label }: { label: string }) {
  return (
    <span role="status" className="flex justify-center text-muted-foreground">
      <CircleNotchIcon
        aria-hidden="true"
        className="size-5 motion-safe:animate-spin"
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function RepositoryPicker({
  value,
  onChange,
  scrollable = false,
}: {
  value: RepositorySource;
  onChange: (v: RepositorySource) => void;
  scrollable?: boolean;
}) {
  const accounts = useQuery(accountQueryOptions());
  const status = accounts.data;
  const [accountId, setAccountId] = useState(value.installationId);
  const [search, setSearch] = useState("");
  const avatarVersion = useAvatarVersion();
  const account =
    status?.installations.find((i) => i.id === accountId) ??
    status?.installations[0];
  const installationId = account?.id;
  const client = useQueryClient();
  const repositories = useInfiniteQuery({
    ...repositoryQueryOptions(installationId ?? ""),
    enabled: Boolean(installationId),
  });
  const repos =
    repositories.data?.pages.flatMap((page) => page.repositories) ?? [];
  const accountError = accounts.error?.message;
  const error = repositories.error?.message;
  const loading = repositories.isFetching;
  const more = repositories.hasNextPage;
  const visible = repos
    .filter((repo) =>
      repo.name.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  return (
    <section
      className={
        scrollable ? "flex min-h-0 flex-1 flex-col gap-4" : "space-y-4"
      }
      aria-label="Import Git repository"
    >
      {accountError && !status ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <p role="alert" className="text-sm text-destructive">
            {accountError}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void accounts.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : !status ? (
        <div className="py-6">
          <RepositoryLoading label="Loading GitHub accounts" />
        </div>
      ) : !account ? (
        <div className="flex flex-col items-start gap-4 py-6 sm:flex-row sm:items-center">
          <GithubLogoIcon aria-hidden="true" className="size-8 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Connect GitHub</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Grant access to your repositories to start deploying your code.
            </p>
          </div>
          <Button
            render={<Link to="/settings/integrations" />}
            nativeButton={false}
            variant="outline"
          >
            Connect GitHub
          </Button>
        </div>
      ) : (
        <>
          <div className="grid shrink-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
            <DropdownMenu
              onOpenChange={(open) => {
                if (!open) return;
                for (const installation of status.installations) {
                  if (installation.id !== installationId) {
                    void client.prefetchInfiniteQuery(
                      repositoryQueryOptions(installation.id),
                    );
                  }
                }
              }}
            >
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="raised"
                    size="action"
                    className="w-full justify-start gap-2 px-2.5"
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
                      setSearch("");
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
            <div className="relative w-full min-w-0">
              <MagnifyingGlassIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                variant="toolbar"
                aria-label="Search repositories"
                placeholder="Search repositories…"
                className="h-9 pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              />
            </div>
          </div>
          {accountError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 text-xs text-destructive"
            >
              <span>Could not refresh GitHub accounts.</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => void accounts.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          <ul
            aria-label="Repositories"
            aria-busy={loading}
            className={
              scrollable
                ? "-mx-2 min-h-0 flex-1 scroll-fade-y scroll-fade-3 overflow-y-auto overscroll-contain has-[:focus-visible]:scroll-fade-none"
                : "-mx-2"
            }
          >
            {visible.map((repo) => (
              <li key={repo.id}>
                <button
                  type="button"
                  aria-label={`Select repository ${repo.name}`}
                  onMouseEnter={() =>
                    prefetchRepository({
                      installationId: account.id,
                      repositoryId: repo.id,
                      repository: repo.name,
                      branch: repo.branch,
                    })
                  }
                  onFocus={() =>
                    prefetchRepository({
                      installationId: account.id,
                      repositoryId: repo.id,
                      repository: repo.name,
                      branch: repo.branch,
                    })
                  }
                  className="group flex min-h-12 w-full items-center gap-3 cursor-pointer rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() =>
                    onChange({
                      installationId: account.id,
                      repositoryId: repo.id,
                      repository: repo.name,
                      branch: repo.branch,
                    })
                  }
                >
                  <svg
                    aria-hidden="true"
                    focusable="false"
                    viewBox="0 0 24 24"
                    className="size-5 shrink-0 fill-current text-muted-foreground"
                  >
                    <path d={siGithub.path} />
                  </svg>
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium"
                    title={repo.name}
                  >
                    {repo.name.split("/").at(-1)}
                  </span>
                  <CaretRightIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
                  />
                </button>
              </li>
            ))}
            {!visible.length && !error && (
              <li>
                <div className="py-10 text-center text-sm text-muted-foreground">
                  {repositories.isPending ? (
                    <RepositoryLoading label="Loading repositories" />
                  ) : (
                    <p role="status">
                      {search.trim()
                        ? "No repositories match your search."
                        : "No repositories available for this account."}
                    </p>
                  )}
                </div>
              </li>
            )}
            {error && (
              <li>
                <div className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void (repositories.isFetchNextPageError
                        ? repositories.fetchNextPage()
                        : repositories.refetch())
                    }
                  >
                    Retry
                  </Button>
                </div>
              </li>
            )}
            {more && (
              <li className="py-3 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={loading || Boolean(error)}
                  onClick={() => void repositories.fetchNextPage()}
                >
                  {loading ? (
                    <RepositoryLoading label="Loading repositories" />
                  ) : (
                    "Load more repositories"
                  )}
                </Button>
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}

function branchQueryOptions(installationId: string, repositoryId: string) {
  return infiniteQueryOptions({
    queryKey: [
      ...apiKey("/integrations/github/branches"),
      installationId,
      repositoryId,
    ],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      request<{ branches: string[]; more: boolean }>(
        `/integrations/github/branches?${new URLSearchParams({ installation: installationId, repository: repositoryId, page: String(pageParam) })}`,
        undefined,
        signal,
      ),
    getNextPageParam: (last, pages) =>
      last.more ? pages.length + 1 : undefined,
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}
function prefetchRepository(source: RepositorySource) {
  void queryClient().prefetchInfiniteQuery(
    branchQueryOptions(source.installationId, source.repositoryId),
  );
  void prefetchRepositoryDirectory(source);
}

export function RepositoryBranchPicker({
  value,
  onChange,
  showRepository = true,
}: {
  value: RepositorySource;
  onChange: (branch: string) => void;
  showRepository?: boolean;
}) {
  const formId = useId();
  const query = useInfiniteQuery({
    ...branchQueryOptions(value.installationId, value.repositoryId),
    enabled: Boolean(value.installationId && value.repositoryId),
  });
  const branches = query.data?.pages.flatMap((page) => page.branches) ?? [];
  const branchMore = query.hasNextPage;
  const loading = query.isFetching;
  const error = query.error?.message;
  return (
    <div className="min-w-0 space-y-3">
      {showRepository && (
        <div className="flex items-center gap-3 border-b pb-4">
          <GithubLogoIcon aria-hidden="true" className="size-6 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              Importing from GitHub
            </p>
            <p className="truncate text-sm font-medium">{value.repository}</p>
          </div>
        </div>
      )}
      <label className="grid gap-1.5 text-sm" htmlFor={`${formId}-branch`}>
        <span>Production branch</span>
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
            onClick={() => void query.fetchNextPage()}
          >
            Load more branches
          </Button>
        )}
      </label>
      {error && (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void (query.isFetchNextPageError
                ? query.fetchNextPage()
                : query.refetch())
            }
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

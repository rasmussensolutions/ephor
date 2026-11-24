import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { FolderSimpleIcon } from "@phosphor-icons/react/dist/csr/FolderSimple";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { request } from "@/lib/auth";
import { apiKey, queryClient } from "@/lib/query";

type Repository = {
  installationId: string;
  repositoryId: string;
  repository: string;
  branch: string;
};
interface Directory {
  path: string;
  commit: string;
  hints: string[];
  truncated: boolean;
  directories: { name: string; path: string; selectable: boolean }[];
}
function directoryQueryOptions(repo: Repository, path: string) {
  const endpoint = `/integrations/github/directories?${new URLSearchParams({ installation: repo.installationId, repository: repo.repositoryId, branch: repo.branch, path })}`;
  return queryOptions({
    queryKey: apiKey(endpoint),
    queryFn: ({ signal }) => request<Directory>(endpoint, undefined, signal),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}
export function prefetchRepositoryDirectory(repo: Repository, path = ".") {
  return queryClient().prefetchQuery(directoryQueryOptions(repo, path));
}
function useDirectory(repo: Repository, path: string, enabled: boolean) {
  return useQuery({ ...directoryQueryOptions(repo, path), enabled });
}
function ancestors(path: string) {
  const parts = path.split("/").filter((p) => p && p !== ".");
  return new Set([
    ".",
    ...parts.map((_, i) => parts.slice(0, i + 1).join("/")),
  ]);
}
type TreeProps = {
  repo: Repository;
  selected: string;
  select: (path: string) => void;
  expanded: Set<string>;
  toggle: (path: string) => void;
  group: string;
};
function DirectoryRow({
  path,
  name,
  selectable = true,
  ...tree
}: TreeProps & { path: string; name: string; selectable?: boolean }) {
  const expanded = tree.expanded.has(path);
  const query = useDirectory(
    tree.repo,
    path,
    selectable && (expanded || tree.selected === path),
  );
  return (
    <li>
      <div
        className={`flex min-h-11 items-center gap-2 rounded-md px-2 ${tree.selected === path ? "bg-muted" : ""}`}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!selectable}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
          aria-expanded={expanded}
          onMouseEnter={() => void prefetchRepositoryDirectory(tree.repo, path)}
          onFocus={() => void prefetchRepositoryDirectory(tree.repo, path)}
          onClick={() => tree.toggle(path)}
        >
          <CaretRightIcon
            className={expanded ? "rotate-90" : ""}
            aria-hidden="true"
          />
        </Button>
        <label
          className={`flex min-w-0 flex-1 items-center gap-2 py-2 text-sm ${selectable ? "cursor-pointer" : "text-muted-foreground"}`}
        >
          <input
            type="radio"
            name={tree.group}
            value={path}
            checked={tree.selected === path}
            disabled={!selectable}
            onChange={() => tree.select(path)}
            aria-label={path === "." ? "Repository root" : path}
          />
          <FolderSimpleIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate" title={path}>
            {name}
          </span>
          {!selectable && <span className="text-xs">Unsupported path</span>}
          {query.data?.hints.length ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {query.data.hints.join(" · ")}
            </span>
          ) : null}
        </label>
      </div>
      {expanded && selectable && (
        <div className="ml-5 border-l pl-2">
          {query.isPending && (
            <p
              role="status"
              className="px-3 py-2 text-xs text-muted-foreground"
            >
              Loading folders…
            </p>
          )}
          {query.isError && (
            <div role="alert" className="px-3 py-2 text-xs">
              <p>{query.error.message}</p>
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => void query.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {query.data && (
            <>
              {query.data.directories.length ? (
                <ul>
                  {query.data.directories.map((child) => (
                    <DirectoryRow key={child.path} {...child} {...tree} />
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  No subfolders
                </p>
              )}
              {query.data.truncated && (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  Only the first 1,000 entries are available. Use a manual path
                  to find another folder.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
function DirectoryBrowser({
  repo,
  value,
  onSelect,
}: {
  repo: Repository;
  value: string;
  onSelect: (path: string) => void;
}) {
  const group = useId();
  const [selected, select] = useState(value || ".");
  const [expanded, setExpanded] = useState(() => ancestors(value));
  const [manual, setManual] = useState(value === "." ? "" : value);
  const query = useDirectory(repo, selected, true);
  function toggle(path: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  return (
    <>
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        <ul aria-label="Repository folders" className="min-h-32">
          <DirectoryRow
            path="."
            name={`${repo.repository.split("/").at(-1)} (root)`}
            repo={repo}
            selected={selected}
            select={select}
            expanded={expanded}
            toggle={toggle}
            group={group}
          />
        </ul>
        <details className="px-2 py-2 text-xs">
          <summary className="cursor-pointer">Enter a path manually</summary>
          <div className="mt-2 flex gap-2">
            <Input
              aria-label="Directory path"
              placeholder="apps/web"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  select(manual.trim() || ".");
                  setExpanded(ancestors(manual));
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                select(manual.trim() || ".");
                setExpanded(ancestors(manual));
              }}
            >
              Find
            </Button>
          </div>
        </details>
      </div>
      <div className="shrink-0 space-y-2 border-t px-2 pt-2">
        {query.isPending && (
          <p role="status" className="text-xs text-muted-foreground">
            Checking directory…
          </p>
        )}
        {query.isError && (
          <p role="alert" className="text-xs text-destructive">
            {query.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            disabled={!query.isSuccess || query.isFetching}
            onClick={() => query.data && onSelect(query.data.path)}
          >
            Select directory
          </Button>
        </div>
      </div>
    </>
  );
}
export function RepositoryDirectoryPicker({
  repo,
  value,
  onChange,
  disabled,
}: {
  repo: Repository;
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const ready = Boolean(
    repo.installationId && repo.repositoryId && repo.branch,
  );
  useDirectory(repo, ".", ready);
  useDirectory(repo, value || ".", ready);
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1.5 text-sm">
      <label htmlFor={id}>Project directory</label>
      {repo.installationId && repo.repositoryId ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                id={id}
                type="button"
                variant="raised"
                size="lg"
                className="w-full min-w-0 justify-start font-normal"
                disabled={disabled}
              />
            }
          >
            <FolderSimpleIcon aria-hidden="true" />
            <span
              className="truncate"
              title={value === "." ? undefined : value}
            >
              {value === "." ? "./ (repository root)" : value}
            </span>
            <CaretRightIcon
              aria-hidden="true"
              className="ml-auto text-muted-foreground"
            />
          </PopoverTrigger>
          <PopoverContent
            aria-label="Project directory"
            align="start"
            className="w-80 max-h-[min(24rem,var(--available-height))] gap-2 overflow-hidden p-2"
          >
            {open && (
              <DirectoryBrowser
                repo={repo}
                value={value}
                onSelect={(path) => {
                  onChange(path);
                  setOpen(false);
                }}
              />
            )}
          </PopoverContent>
        </Popover>
      ) : (
        <Input
          id={id}
          variant="toolbar"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
    </div>
  );
}

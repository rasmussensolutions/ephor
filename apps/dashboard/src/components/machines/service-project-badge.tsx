import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import type { Project } from "@/lib/projects";

export function ServiceProjectBadge({ project }: { project?: Project }) {
  if (!project) return null;
  return (
    <span
      className="inline-flex min-w-0 max-w-36 items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
      title={`Project: ${project.name}`}
    >
      <FolderOpenIcon aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">Project: </span>
      <span className="truncate">{project.name}</span>
    </span>
  );
}

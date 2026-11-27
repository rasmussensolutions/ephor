import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";

export function ServiceMachineLabel({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-2 px-2 text-xs text-muted-foreground"
      title={`Machine: ${name}`}
    >
      <CubeIcon aria-hidden size={14} className="shrink-0" />
      <span className="sr-only">Machine: </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

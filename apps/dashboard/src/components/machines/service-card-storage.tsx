import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type StorageVolume, storageFooterHeight } from "@/lib/service-storage";

export function ServiceCardStorage({
  volumes,
  onOpen,
}: {
  volumes: StorageVolume[];
  onOpen: (trigger: HTMLElement) => void;
}) {
  const first = volumes[0];
  if (!first) return null;
  const pending = volumes.some((v) => v.status === "Needs deployment");
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" />}
        data-map-no-drag
        aria-haspopup="dialog"
        aria-label={`Persistent storage: ${volumes.map((v) => `${v.name}, ${v.target}, ${v.status}`).join("; ")}`}
        onClick={(event) => onOpen(event.currentTarget)}
        style={{ height: storageFooterHeight }}
        className="relative flex w-full shrink-0 items-center gap-2 border-t px-3 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <HardDrivesIcon aria-hidden size={16} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{first.name}</span>
        {volumes.length > 1 && (
          <span className="shrink-0 tabular-nums">+{volumes.length - 1}</span>
        )}
        {pending && <span className="shrink-0 text-[10px]">Needs deploy</span>}
      </TooltipTrigger>
      <TooltipContent className="block max-w-sm space-y-2">
        {volumes.map((volume) => (
          <div key={volume.target}>
            <p className="break-all font-medium">
              {volume.name} · {volume.status}
            </p>
            <p className="break-all font-mono opacity-80">{volume.target}</p>
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

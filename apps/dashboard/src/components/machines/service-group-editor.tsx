import type { ServicePresentation } from "@ephor/api/services";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsThreeVertical";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { groupPalette, savePresentation } from "@/lib/service-presentation";
import type { Service } from "@/lib/services";

export function ServiceGroupEditor({ service }: { service: Service }) {
  const inputId = useId();
  const currentName = service.presentation?.groupName ?? service.name;
  const [open, setOpen] = useState(false),
    [name, setName] = useState(currentName),
    [color, setColor] = useState<ServicePresentation["groupColor"]>(
      service.presentation?.groupColor ?? "neutral",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-muted-foreground hover:text-foreground"
        aria-label={`Edit group ${currentName}`}
        title="Group name and color"
        onClick={(event) => {
          setTrigger(event.currentTarget);
          setName(currentName);
          setColor(service.presentation?.groupColor ?? "neutral");
          setError("");
          setOpen(true);
        }}
      >
        <DotsThreeVerticalIcon size={20} />
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next, details) => {
          if (busy) details.cancel();
          else setOpen(next);
        }}
      >
        <SheetContent
          finalFocus={() => trigger}
          className="p-6 pt-12 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <SheetHeader className="px-0">
            <SheetTitle>Edit group</SheetTitle>
            <SheetDescription>
              Give these related services a shared name and color.
            </SheetDescription>
          </SheetHeader>
          <form
            className="space-y-6"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                await savePresentation(service.id, {
                  groupName: name,
                  groupColor: color,
                });
                setOpen(false);
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Could not save group.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label htmlFor={inputId} className="block text-sm font-medium">
              Group name
              <Input
                id={inputId}
                className="mt-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                required
                disabled={busy}
              />
            </label>
            <fieldset disabled={busy}>
              <legend className="mb-3 text-sm font-medium">Group color</legend>
              <div className="flex flex-wrap gap-2">
                {Object.entries(groupPalette).map(([key, option]) => (
                  <button
                    key={key}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={color === key}
                    title={option.label}
                    onClick={() =>
                      setColor(key as ServicePresentation["groupColor"])
                    }
                    className={`flex size-10 items-center justify-center rounded-full border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${color === key ? "border-foreground" : "border-transparent"}`}
                  >
                    <span
                      className="size-7 rounded-full"
                      style={{ backgroundColor: option.color }}
                    />
                  </button>
                ))}
              </div>
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "Saving…" : "Save group"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

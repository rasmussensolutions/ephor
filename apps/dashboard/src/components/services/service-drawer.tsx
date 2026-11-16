import type { MachineList } from "@ephor/api/machines";
import { useEffect, useState } from "react";
import { ServiceDetails } from "@/components/services/service-details";
import type { VariablePending } from "@/components/services/service-variables";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api } from "@/lib/auth";
import type { Service, ServiceList } from "@/lib/services";
import { ComponentDetails } from "./component-details";

export function ServiceDrawer({
  service,
  trigger,
  onClose,
  component,
  onApp,
  initialSection,
}: {
  service: Service;
  trigger: HTMLElement | null;
  onClose: () => void;
  component?: string;
  initialSection?: "Domains";
  onApp?: () => void;
}) {
  const [initial, setInitial] = useState<{
    data: ServiceList;
    machines: MachineList;
  } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState<VariablePending>({
    dirty: false,
    busy: false,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter explicitly starts a new request after failure.
  useEffect(() => {
    let active = true;
    setError("");
    void Promise.all([
      api<ServiceList>(`/services/${service.id}`),
      api<MachineList>("/machines"),
    ])
      .then(([data, machines]) => {
        if (active) setInitial({ data, machines });
      })
      .catch((error) => {
        if (active)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load this service.",
          );
      });
    return () => {
      active = false;
    };
  }, [service.id, attempt]);
  return (
    <Sheet
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (
          pending.busy ||
          (pending.dirty && !confirm("Discard unsaved variable changes?"))
        ) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <SheetContent
        finalFocus={() => trigger}
        className="gap-0 overflow-hidden rounded-l-2xl border-y data-[side=right]:inset-y-3 data-[side=right]:h-auto data-[side=right]:w-full data-[side=right]:sm:inset-y-4 data-[side=right]:sm:max-w-[min(800px,88vw)] motion-reduce:transition-none [&>[data-slot=sheet-close]]:top-7 [&>[data-slot=sheet-close]]:right-5 sm:[&>[data-slot=sheet-close]]:top-9 sm:[&>[data-slot=sheet-close]]:right-8"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {initial ? (
            component ? (
              <ComponentDetails
                id={service.id}
                name={component}
                initial={initial}
                onApp={onApp}
              />
            ) : (
              <ServiceDetails
                id={service.id}
                initial={initial}
                drawer
                initialSection={initialSection}
                onPendingChange={setPending}
              />
            )
          ) : (
            <div className="overflow-auto p-6 pt-12 sm:p-10">
              <SheetHeader className="px-0">
                <SheetTitle>{service.name}</SheetTitle>
                <SheetDescription>Loading service details…</SheetDescription>
              </SheetHeader>
              {error ? (
                <div className="mt-6 space-y-3">
                  <p role="alert" className="text-destructive">
                    {error}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    Try again
                  </Button>
                </div>
              ) : (
                <div role="status" className="mt-8 space-y-4">
                  <p className="text-muted-foreground">
                    Fetching deployments and configuration…
                  </p>
                  <div className="h-36 rounded-xl border bg-muted/30" />
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

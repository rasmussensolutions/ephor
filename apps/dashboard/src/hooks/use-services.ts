import type { MachineList } from "@ephor/api/machines";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/auth";
import { mergeServiceRefresh } from "@/lib/map-position-state";
import { applyPresentation } from "@/lib/service-presentation";
import type { ServiceList } from "@/lib/services";
export function useServices(
  initial: { data: ServiceList; machines: MachineList },
  id?: string,
  interval = 10000,
) {
  const [data, setData] = useState(initial.data);
  const [machines, setMachines] = useState(initial.machines.machines);
  const [error, setError] = useState("");
  const endpoint = id ? `/services/${id}` : "/services?summary=1";
  const refresh = useCallback(async () => {
    const [next, inventory] = await Promise.all([
      api<ServiceList>(endpoint),
      api<MachineList>("/machines"),
    ]);
    setData((previous) => mergeServiceRefresh(previous, next));
    setMachines(inventory.machines);
    setError("");
  }, [endpoint]);
  useEffect(() => {
    const changed = (event: Event) =>
      setData((previous) =>
        previous ? applyPresentation(previous, event) : previous,
      );
    window.addEventListener("ephor:service-presentation", changed);
    return () =>
      window.removeEventListener("ephor:service-presentation", changed);
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden)
        try {
          const next = await api<ServiceList>(endpoint);
          if (active) {
            setData((previous) => mergeServiceRefresh(previous, next));
            setError("");
          }
        } catch {
          if (active)
            setError(
              "Could not refresh services. Showing the last received report.",
            );
        }
      if (active) timer = setTimeout(poll, interval);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [endpoint, interval]);
  return { data, machines, error, refresh };
}

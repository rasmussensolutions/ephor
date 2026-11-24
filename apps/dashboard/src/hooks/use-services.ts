import type { MachineList } from "@ephor/api/machines";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/auth";
import { mergeServiceRefresh } from "@/lib/map-position-state";
import { applyPresentation } from "@/lib/service-presentation";
import type { ServiceList } from "@/lib/services";
import { useApiQuery } from "./use-api-query";
export function useServices(
  initial: { data: ServiceList; machines: MachineList },
  id?: string,
  interval = 10000,
) {
  const [data, setData] = useState(initial.data);

  const endpoint = id ? `/services/${id}` : "/services?summary=1";
  const serviceQuery = useApiQuery(endpoint, initial.data, interval);
  const machineQuery = useApiQuery("/machines", initial.machines, 15000);
  const machines = machineQuery.data.machines;
  const error =
    serviceQuery.isError || machineQuery.isError
      ? "Could not refresh. Showing the last received report."
      : "";
  useEffect(() => {
    setData((previous) => mergeServiceRefresh(previous, serviceQuery.data));
  }, [serviceQuery.data]);
  const refresh = useCallback(async () => {
    const [next] = await Promise.all([
      api<ServiceList>(endpoint),
      api<MachineList>("/machines"),
    ]);
    setData((previous) => mergeServiceRefresh(previous, next));
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
  return { data, machines, error, refresh };
}

import type { ServicePresentation } from "@ephor/api/services";
import { api } from "./auth";
import { mergeMapPositions, type PositionEdit } from "./map-position-state";
import type { Service, ServiceList } from "./services";

type PresentationUpdate = Pick<Service, "id" | "name" | "presentation">;

export const groupPalette: Record<
  ServicePresentation["groupColor"],
  { label: string; color: string }
> = {
  neutral: { label: "Neutral", color: "#85858f" },
  blue: { label: "Blue", color: "#5489e8" },
  violet: { label: "Violet", color: "#a17cdd" },
  green: { label: "Green", color: "#48a681" },
  amber: { label: "Amber", color: "#c79b44" },
  rose: { label: "Rose", color: "#cc718a" },
};
function publishPresentation(service: PresentationUpdate) {
  window.dispatchEvent(
    new CustomEvent("ephor:service-presentation", {
      detail: {
        id: service.id,
        name: service.name,
        presentation: service.presentation,
      },
    }),
  );
}
export async function savePresentation(
  id: string,
  patch: Record<string, unknown>,
) {
  const service = await api<Service>(`/services/${id}/presentation`, patch);
  publishPresentation(service);
  return service;
}
export async function saveMapPositions(updates: PositionEdit[]) {
  const result = await api<{ services: PresentationUpdate[] }>(
    "/services/map-positions",
    {
      positions: updates.map(({ id, point }) => ({
        id,
        x: point.x,
        y: point.y,
      })),
    },
  );
  for (const service of result.services) publishPresentation(service);
}
export function applyPresentation(
  data: ServiceList,
  event: Event,
): ServiceList {
  const update = (event as CustomEvent<PresentationUpdate>).detail;
  return {
    ...data,
    services: data.services.map((service) =>
      service.id === update.id
        ? mergeMapPositions(service, {
            ...service,
            name: update.name,
            presentation: update.presentation,
          })
        : service,
    ),
  };
}

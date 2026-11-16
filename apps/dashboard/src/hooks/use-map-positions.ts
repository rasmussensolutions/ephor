import { useState } from "react";
import { PositionWriter, positionKey } from "@/lib/map-position-state";
import type { MapPoint } from "@/lib/service-map";
import { savePresentation } from "@/lib/service-presentation";
import type { Service } from "@/lib/services";

export function useMapPositions(services: Service[]) {
  const [edits, setEdits] = useState<Record<string, Record<string, MapPoint>>>(
    {},
  );
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState(false);
  const [writer] = useState(
    () =>
      new PositionWriter(
        ({ id, component, point }) =>
          savePresentation(id, {
            position: {
              x: point.x,
              y: point.y,
              ...(component ? { component } : {}),
            },
          }),
        ({ id, component, point }) =>
          setEdits((previous) => {
            if (previous[id]?.[component] !== point) return previous;
            const next = { ...previous, [id]: { ...previous[id] } };
            delete next[id]?.[component];
            return next;
          }),
        () => {
          setSaving(writer.active.size);
          setError(writer.failures.size > 0);
        },
      ),
  );
  function move(id: string, component: string, point: MapPoint) {
    setEdits((previous) => ({
      ...previous,
      [id]: { ...previous[id], [component]: point },
    }));
  }
  function commit(id: string, component: string, point: MapPoint) {
    move(id, component, point);
    writer.commit({ id, component, point });
  }
  return {
    services: services.map((service) =>
      !edits[service.id]
        ? service
        : {
            ...service,
            presentation: {
              groupName: service.name,
              groupColor: "neutral" as const,
              componentNames: {},
              ...service.presentation,
              positions: {
                ...service.presentation?.positions,
                ...edits[service.id],
              },
            },
          },
    ),
    move,
    cancel: (id: string, component: string) => {
      setEdits((previous) => {
        const cardEdits = { ...previous[id] };
        const next = { ...previous, [id]: cardEdits };
        const key = positionKey(id, component);
        const failed =
          writer.active.has(key) || writer.failures.has(key)
            ? writer.latest.get(key)
            : undefined;
        if (failed) cardEdits[component] = failed.point;
        else delete cardEdits[component];
        return next;
      });
    },
    commit,
    saving,
    error,
    retry: () => writer.retry(),
  };
}

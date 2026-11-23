import { useEffect, useState } from "react";
import {
  batchPositionSaves,
  type PositionEdit,
  PositionWriter,
  positionKey,
} from "@/lib/map-position-state";
import type { MapPoint } from "@/lib/service-map";
import { saveMapPositions, savePresentation } from "@/lib/service-presentation";
import type { Service } from "@/lib/services";

export function useMapPositions(services: Service[]) {
  const [edits, setEdits] = useState<Record<string, Record<string, MapPoint>>>(
    {},
  );
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState(false);
  const [writer] = useState(() => {
    const saveRoots = batchPositionSaves(saveMapPositions);
    return new PositionWriter(
      ({ id, component, point }) =>
        component
          ? savePresentation(id, { position: { ...point, component } })
          : saveRoots({ id, component, point }),
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
    );
  });
  useEffect(() => {
    writer.retainServices(new Set(services.map((service) => service.id)));
  }, [services, writer]);
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
  function commitMany(updates: PositionEdit[]) {
    setEdits((previous) => {
      const next = { ...previous };
      for (const { id, component, point } of updates)
        next[id] = { ...next[id], [component]: point };
      return next;
    });
    for (const update of updates) writer.commit(update);
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
    commitMany,
    saving,
    error,
    retry: () => writer.retry(),
  };
}

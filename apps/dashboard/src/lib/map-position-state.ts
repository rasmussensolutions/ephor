import type { MapPoint } from "./service-map";
import type { Service, ServiceList } from "./services";

// Responses may arrive out of order, including full service refreshes and saves
// of other cards. Only the latest stored revision can replace a position.
export function mergeMapPositions(previous: Service, next: Service): Service {
  const positions = { ...next.presentation?.positions };
  for (const [key, point] of Object.entries(
    previous.presentation?.positions ?? {},
  )) {
    if ((point.revision ?? 0) > (positions[key]?.revision ?? -1))
      positions[key] = point;
  }
  if (!next.presentation || !Object.keys(positions).length) return next;
  return { ...next, presentation: { ...next.presentation, positions } };
}
export function mergeServiceRefresh(
  previous: ServiceList | null,
  next: ServiceList,
): ServiceList {
  const old = new Map(previous?.services.map((s) => [s.id, s]));
  return {
    ...next,
    services: next.services.map((s) => {
      const before = old.get(s.id);
      return before ? mergeMapPositions(before, s) : s;
    }),
  };
}
export type PositionEdit = { id: string; component: string; point: MapPoint };
export const positionKey = (id: string, component: string) =>
  JSON.stringify([id, component]);

// Keep per-card promises so the writer can serialize drags and retry failures,
// while an auto-layout or Retry action uses bounded API batches, not a burst.
export function batchPositionSaves(
  save: (edits: PositionEdit[]) => Promise<unknown>,
) {
  let pending: {
    edit: PositionEdit;
    resolve: () => void;
    reject: (reason: unknown) => void;
  }[] = [];
  return (edit: PositionEdit) =>
    new Promise<void>((resolve, reject) => {
      pending.push({ edit, resolve, reject });
      if (pending.length !== 1) return;
      queueMicrotask(() => {
        const updates = pending;
        pending = [];
        // Match the API's D1-safe limit of 32 root positions per request.
        for (let offset = 0; offset < updates.length; offset += 32) {
          const batch = updates.slice(offset, offset + 32);
          void Promise.resolve()
            .then(() => save(batch.map(({ edit }) => edit)))
            .then(
              () => {
                for (const update of batch) update.resolve();
              },
              (error: unknown) => {
                for (const update of batch) update.reject(error);
              },
            );
        }
      });
    });
}

// One request per card in flight; repeated drops replace its queued destination.
// Independent cards save concurrently, so one slow request cannot block the map.
export class PositionWriter {
  pending = new Map<string, PositionEdit>();
  active = new Set<string>();
  failures = new Map<string, PositionEdit>();
  latest = new Map<string, PositionEdit>();
  constructor(
    private save: (edit: PositionEdit) => Promise<unknown>,
    private saved: (edit: PositionEdit) => void,
    private changed: () => void,
  ) {}
  commit(edit: PositionEdit) {
    const key = positionKey(edit.id, edit.component);
    this.latest.set(key, edit);
    this.pending.set(key, edit);
    this.failures.delete(key);
    void this.flush(key);
  }
  private async flush(key: string) {
    if (this.active.has(key)) return;
    this.active.add(key);
    this.changed();
    try {
      while (this.pending.has(key)) {
        const edit = this.pending.get(key);
        if (!edit) break;
        this.pending.delete(key);
        try {
          await this.save(edit);
          if (this.latest.has(key)) {
            this.failures.delete(key);
            this.saved(edit);
          }
        } catch {
          if (this.latest.has(key) && !this.pending.has(key))
            this.failures.set(key, edit);
        }
      }
    } finally {
      this.active.delete(key);
      this.changed();
    }
  }
  retainServices(ids: ReadonlySet<string>) {
    let removed = false;
    for (const [key, edit] of this.latest) {
      if (ids.has(edit.id)) continue;
      this.latest.delete(key);
      this.pending.delete(key);
      this.failures.delete(key);
      removed = true;
    }
    if (removed) this.changed();
  }
  retry() {
    for (const edit of [...this.failures.values()]) this.commit(edit);
  }
}

import { expect, test } from "bun:test";
import {
  batchPositionSaves,
  mergeMapPositions,
  type PositionEdit,
  PositionWriter,
} from "../src/lib/map-position-state";
import type { Service } from "../src/lib/services";

const service = (
  positions: NonNullable<Service["presentation"]>["positions"],
) =>
  ({
    id: "app",
    presentation: {
      groupName: "App",
      groupColor: "neutral",
      componentNames: {},
      positions,
    },
  }) as Service;
test("late poll and sibling save responses cannot roll back newer coordinates; newer remote edits win", () => {
  const current = service({
    "": { x: 300, y: 100, revision: 3 },
    web: { x: 20, y: 50, revision: 5 },
  });
  const stale = service({ "": { x: 0, y: 0, revision: 2 } });
  expect(mergeMapPositions(current, stale).presentation?.positions).toEqual(
    current.presentation?.positions,
  );
  const remote = service({ web: { x: 40, y: 40, revision: 6 } });
  expect(
    mergeMapPositions(current, remote).presentation?.positions?.web,
  ).toEqual(remote.presentation?.positions?.web);
});
const edit = (x: number, component = "") => ({
  id: "app",
  component,
  point: { x, y: 20 },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("rapid drops coalesce per card and another card saves without waiting", async () => {
  const sent: PositionEdit[] = [],
    completed: PositionEdit[] = [];
  const release: (() => void)[] = [];
  const writer = new PositionWriter(
    (e) => {
      sent.push(e);
      return new Promise<void>((resolve) => release.push(resolve));
    },
    (e) => completed.push(e),
    () => {},
  );
  writer.commit(edit(1));
  writer.commit(edit(2));
  writer.commit(edit(3));
  writer.commit(edit(9, "web"));
  expect(sent.map((e) => e.point.x)).toEqual([1, 9]);
  release[0]?.();
  await tick();
  expect(sent.map((e) => e.point.x)).toEqual([1, 9, 3]);
  release[1]?.();
  release[2]?.();
  await tick();
  expect(writer.active.size).toBe(0);
  expect(writer.pending.size).toBe(0);
  expect(completed.map((e) => e.point.x)).toEqual([1, 9, 3]);
});
test("an old failed save cannot restore an obsolete destination and retry saves only the newest one", async () => {
  let fail: (reason?: unknown) => void = () => {};
  const sent: number[] = [];
  const writer = new PositionWriter(
    (e) => {
      sent.push(e.point.x);
      return new Promise<void>((_, reject) => {
        fail = reject;
      });
    },
    () => {},
    () => {},
  );
  writer.commit(edit(1));
  writer.commit(edit(2));
  fail();
  await tick();
  expect(writer.failures.size).toBe(0);
  expect(sent).toEqual([1, 2]);
  fail();
  await tick();
  expect([...writer.failures.values()][0]?.point.x).toBe(2);
  writer.retry();
  expect(sent).toEqual([1, 2, 2]);
  fail();
  await tick();
});

test("bulk position saves coalesce into bounded API batches", async () => {
  const batches: PositionEdit[][] = [];
  const save = batchPositionSaves(async (updates) => {
    batches.push(updates);
  });
  const updates = Array.from({ length: 66 }, (_, index) => ({
    ...edit(index * 24),
    id: `service-${index}`,
  }));
  const pending = updates.map(save);
  expect(batches).toHaveLength(0);
  await Promise.all(pending);
  expect(batches.map((batch) => batch.length)).toEqual([32, 32, 2]);
  expect(batches.flat()).toEqual(updates);
});

test("a failed batch rejects only its own per-card promises", async () => {
  const save = batchPositionSaves(async (updates) => {
    if (updates.some((update) => update.id === "service-32"))
      throw new Error("Save failed");
  });
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, (_, index) =>
      save({ ...edit(index), id: `service-${index}` }),
    ),
  );
  expect(results.slice(0, 32).every((r) => r.status === "fulfilled")).toBe(
    true,
  );
  expect(results.slice(32).every((r) => r.status === "rejected")).toBe(true);
});

test("bulk saves retain per-card serialization and batch retries without restoring an obsolete destination", async () => {
  const sent: PositionEdit[][] = [];
  const completed: PositionEdit[] = [];
  const release: { resolve: () => void; reject: (reason: Error) => void }[] =
    [];
  const save = batchPositionSaves((updates) => {
    sent.push(updates);
    return new Promise<void>((resolve, reject) => {
      release.push({ resolve, reject });
    });
  });
  const writer = new PositionWriter(
    save,
    (update) => completed.push(update),
    () => {},
  );
  const updates = ["a", "b", "c"].map((id, index) => ({
    ...edit(index * 360),
    id,
  }));
  for (const update of updates) writer.commit(update);
  await tick();
  expect(sent).toEqual([updates]);

  const latest = { ...edit(1440), id: "a" };
  writer.commit(latest);
  release[0]?.reject(new Error("Bulk save failed"));
  await tick();
  expect(sent[1]).toEqual([latest]);
  expect([...writer.failures.values()].map((update) => update.id)).toEqual([
    "b",
    "c",
  ]);
  release[1]?.resolve();
  await tick();
  expect(completed).toEqual([latest]);

  writer.retry();
  await tick();
  expect(sent[2]).toEqual(updates.slice(1));
  release[2]?.resolve();
  await tick();
  expect(writer.active.size).toBe(0);
  expect(writer.failures.size).toBe(0);
  expect(writer.pending.size).toBe(0);
  expect(completed).toEqual([latest, ...updates.slice(1)]);
});

for (const removeBeforeFailure of [true, false]) {
  test(`deleted services cannot poison batch retries when removed ${removeBeforeFailure ? "before" : "after"} a save failure`, async () => {
    const sent: PositionEdit[][] = [];
    const completed: PositionEdit[] = [];
    const release: { resolve: () => void; reject: (error: Error) => void }[] =
      [];
    const save = batchPositionSaves((updates) => {
      sent.push(updates);
      return new Promise<void>((resolve, reject) => {
        release.push({ resolve, reject });
      });
    });
    const writer = new PositionWriter(
      save,
      (update) => completed.push(update),
      () => {},
    );
    const kept = { ...edit(48), id: "kept" };
    writer.commit(kept);
    writer.commit({ ...edit(480), id: "deleted" });
    await tick();
    if (removeBeforeFailure) writer.retainServices(new Set(["kept"]));
    release[0]?.reject(new Error("SERVICE_NOT_FOUND"));
    await tick();
    if (!removeBeforeFailure) writer.retainServices(new Set(["kept"]));
    expect([...writer.failures.values()]).toEqual([kept]);
    writer.retry();
    await tick();
    expect(sent[1]).toEqual([kept]);
    release[1]?.resolve();
    await tick();
    expect(writer.active.size).toBe(0);
    expect(writer.failures.size).toBe(0);
    expect(writer.pending.size).toBe(0);
    expect(completed).toEqual([kept]);
  });
}

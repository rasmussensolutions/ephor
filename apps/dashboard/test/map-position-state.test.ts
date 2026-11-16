import { expect, test } from "bun:test";
import {
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

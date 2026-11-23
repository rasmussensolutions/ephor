import { mapGridSize } from "./map-grid";
import type { PositionEdit } from "./map-position-state";
import type { Project } from "./projects";
import { mapLayout } from "./service-map";
import type { Service } from "./services";

const originLimit = 20000;
const margin = mapGridSize * 2;
const serviceGap = mapGridSize * 3;
const projectGap = mapGridSize * 7;
const gridCeil = (value: number) =>
  Math.ceil(value / mapGridSize) * mapGridSize;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareNamed = (
  a: { name: string; id: string },
  b: { name: string; id: string },
) => compareText(a.name, b.name) || compareText(a.id, b.id);

type Size = { width: number; height: number };
type Packing = { wide: boolean; vertical: boolean; reverse: boolean };

function pack<T extends Size>(items: T[], gap: number, packing: Packing) {
  const area = items.reduce(
    (sum, item) =>
      sum + (gridCeil(item.width) + gap) * (gridCeil(item.height) + gap),
    0,
  );
  const narrowest = items.reduce(
    (minimum, item) =>
      Math.min(minimum, gridCeil(packing.vertical ? item.height : item.width)),
    Number.POSITIVE_INFINITY,
  );
  // The last card can extend past the origin limit, so do not bound its edge.
  const maxWidth = originLimit - margin + narrowest;
  const target = packing.wide
    ? maxWidth
    : Math.min(maxWidth, gridCeil(Math.sqrt(area * 1.5)));
  const placements: { item: T; x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const item of packing.reverse ? [...items].reverse() : items) {
    const w = gridCeil(packing.vertical ? item.height : item.width);
    const h = gridCeil(packing.vertical ? item.width : item.height);
    if (x > 0 && x + w > target) {
      y += rowHeight + gap;
      x = 0;
      rowHeight = 0;
    }
    placements.push({
      item,
      x: packing.vertical ? y : x,
      y: packing.vertical ? x : y,
    });
    width = Math.max(width, x + w);
    rowHeight = Math.max(rowHeight, h);
    x += w + gap;
  }
  const height = y + rowHeight;
  return {
    placements,
    width: packing.vertical ? height : width,
    height: packing.vertical ? width : height,
  };
}

/** One-shot, machine-local root edits; saved child positions only affect sizes. */
export function autoLayoutServices(
  services: Service[],
  projects: Project[] = [],
): PositionEdit[] {
  const membership = new Map<string, number>();
  for (const [index, project] of [...projects].sort(compareNamed).entries()) {
    for (const id of project.serviceIds) {
      // Resolve conflicting memberships consistently, independent of API order.
      if (!membership.has(id)) membership.set(id, index);
    }
  }
  const projectOrder = (service: Service) =>
    membership.get(service.id) ?? projects.length;
  const machines = new Map<string, Service[]>();
  for (const service of [...services].sort(
    (a, b) =>
      compareText(a.machineId, b.machineId) ||
      projectOrder(a) - projectOrder(b) ||
      compareNamed(a, b),
  )) {
    const members = machines.get(service.machineId) ?? [];
    members.push(service);
    machines.set(service.machineId, members);
  }

  const edits: PositionEdit[] = [];
  for (const [machineId, members] of machines) {
    const groups = new Map<number, (Size & { id: string; order: number })[]>();
    for (const [order, node] of mapLayout(members).nodes.entries()) {
      if (
        !Number.isFinite(node.width) ||
        !Number.isFinite(node.height) ||
        node.width <= 0 ||
        node.height <= 0
      ) {
        throw new Error(
          `Cannot auto-layout service "${node.service.id}": invalid root dimensions.`,
        );
      }
      const key = projectOrder(node.service);
      const group = groups.get(key) ?? [];
      group.push({
        id: node.service.id,
        order,
        width: node.width,
        height: node.height,
      });
      groups.set(key, group);
    }

    let machineEdits: PositionEdit[] | undefined;
    // Ordinary landscape shelves first. Alternatives handle tall layouts and
    // stretched groups that must sit at an outside edge of the origin range.
    for (const wide of [false, true]) {
      for (const vertical of [false, true]) {
        for (const reverse of [false, true]) {
          const packing = { wide, vertical, reverse };
          const blocks = [...groups.values()].map((group) =>
            pack(group, serviceGap, packing),
          );
          const layout = pack(blocks, projectGap, packing);
          const roots = layout.placements.flatMap((block) =>
            block.item.placements.map((root) => ({
              ...root,
              x: margin + block.x + root.x,
              y: margin + block.y + root.y,
            })),
          );
          // Only origins are bounded, just like persisted map positions. Card
          // edges may extend beyond 20000; clamping origins would cause overlaps.
          if (
            roots.some(
              ({ x, y }) =>
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                x < 0 ||
                y < 0 ||
                x > originLimit ||
                y > originLimit,
            )
          )
            continue;
          machineEdits = roots
            .sort((a, b) => a.item.order - b.item.order)
            .map(({ item, x, y }) => ({
              id: item.id,
              component: "",
              point: { x, y },
            }));
          break;
        }
        if (machineEdits) break;
      }
      if (machineEdits) break;
    }
    if (!machineEdits) {
      throw new Error(
        `Cannot auto-layout services on machine "${machineId}": no safe shelf layout fits root origins within 0..${originLimit} without overlaps.`,
      );
    }
    edits.push(...machineEdits);
  }
  return edits;
}

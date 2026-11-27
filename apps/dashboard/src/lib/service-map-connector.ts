import {
  type MapPoint,
  type mapLayout,
  serviceCardHeight,
} from "./service-map";

type Card = MapPoint & { width?: number; height?: number };

// Keep connectors outside both cards, switching sides as their separation changes.
export function mapConnector(from: Card, to: Card) {
  const fw = from.width ?? 264,
    fh = from.height ?? serviceCardHeight;
  const tw = to.width ?? 264,
    th = to.height ?? serviceCardHeight;
  const width = (fw + tw) / 2,
    height = (fh + th) / 2;
  const dx = to.x + tw / 2 - from.x - fw / 2,
    dy = to.y + th / 2 - from.y - fh / 2;
  const horizontalGap = Math.abs(dx) - width;
  const verticalGap = Math.abs(dy) - height;
  if (horizontalGap < 0 && verticalGap < 0) return null;
  const horizontal =
    horizontalGap >= 0 &&
    (verticalGap < 0 || Math.abs(dx) / width > Math.abs(dy) / height);
  const direction = (horizontal ? dx : dy) >= 0 ? 1 : -1;
  const start = {
    x: from.x + (horizontal ? (direction > 0 ? fw : 0) : fw / 2),
    y: from.y + (horizontal ? fh / 2 : direction > 0 ? fh : 0),
  };
  const end = {
    x: to.x + (horizontal ? (direction > 0 ? 0 : tw) : tw / 2),
    y: to.y + (horizontal ? th / 2 : direction > 0 ? 0 : th),
  };
  const middle = horizontal ? (start.x + end.x) / 2 : (start.y + end.y) / 2;
  const points = horizontal
    ? [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end]
    : [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end];
  let path = `M ${start.x} ${start.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1],
      point = points[i],
      next = points[i + 1];
    if (!previous || !point || !next) continue;
    const before = Math.hypot(point.x - previous.x, point.y - previous.y);
    const after = Math.hypot(next.x - point.x, next.y - point.y);
    const radius = Math.min(6, before / 2, after / 2);
    if (!radius) {
      path += ` L ${point.x} ${point.y}`;
      continue;
    }
    const entry = {
      x: point.x + ((previous.x - point.x) * radius) / before,
      y: point.y + ((previous.y - point.y) * radius) / before,
    };
    const exit = {
      x: point.x + ((next.x - point.x) * radius) / after,
      y: point.y + ((next.y - point.y) * radius) / after,
    };
    path += ` L ${entry.x} ${entry.y} Q ${point.x} ${point.y} ${exit.x} ${exit.y}`;
  }
  path += ` L ${end.x} ${end.y}`;
  const arrow = horizontal
    ? `M ${end.x} ${end.y} L ${end.x - 7 * direction} ${end.y - 5} L ${end.x - 7 * direction} ${end.y + 5} Z`
    : `M ${end.x} ${end.y} L ${end.x - 5} ${end.y - 7 * direction} L ${end.x + 5} ${end.y - 7 * direction} Z`;
  return { path, arrow };
}

export function serviceMapConnections(
  nodes: ReturnType<typeof mapLayout>["nodes"],
) {
  const byId = new Map(nodes.map((n) => [n.service.id, n]));
  return nodes.flatMap((from) =>
    (from.service.variableConnections ?? []).flatMap((link) => {
      const to = byId.get(link.serviceId);
      if (!to || to === from || to.service.machineId !== from.service.machineId)
        return [];
      const connector = mapConnector(from, to);
      if (!connector) return [];
      return [
        {
          ...connector,
          key: `${from.service.id}:${to.service.id}`,
          label: `${from.service.name} → ${to.service.name} · ${link.variables.join(", ")}${from.service.variablesPending ? " · Needs deployment" : ""}`,
        },
      ];
    }),
  );
}

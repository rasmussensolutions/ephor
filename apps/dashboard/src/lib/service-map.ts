import { imageTechnology } from "@ephor/api/services";
import { groupGridOffset, mapGridSize, snapMapPoint } from "./map-grid";
import type { Service } from "./services";
export const componentCardHeight = 192;
export function primaryComponent(service: Service) {
  const topology = service.topology;
  // Older API responses retain recipe order, with the main endpoint last.
  return (
    topology?.components.find((c) => c.name === topology.primary) ??
    topology?.components.at(-1)
  );
}
export function componentLabel(
  component: { name: string; image: string },
  service?: Service,
) {
  const custom = service?.presentation?.componentNames[component.name];
  if (custom) return custom;
  const technology = imageTechnology(component.image);
  const labels: Record<string, string> = {
    postgres: "PostgreSQL",
    mariadb: "MariaDB",
    mysql: "MySQL",
    redis: "Redis",
    mongodb: "MongoDB",
  };
  return (technology && labels[technology]) || component.name;
}
export function primaryHasDomains(service: Service) {
  return service.topology?.web ?? Boolean(service.domain);
}
export function componentStatus(
  service: Service,
  name: string,
  now = Date.now(),
) {
  const report = service.runtime?.catalog?.components.find(
    (c) => c.name === name,
  );
  if (!report) return "Awaiting report";
  if (service.runtimeAt < now - 120000) return "Unavailable";
  return report.status.charAt(0).toUpperCase() + report.status.slice(1);
}
export function componentMetrics(
  service: Service,
  name: string,
  now = Date.now(),
) {
  const status = componentStatus(service, name, now);
  return status === "Running" || status === "Unhealthy"
    ? (service.runtime?.catalog?.components.find((c) => c.name === name)
        ?.metrics ?? null)
    : null;
}
export type MapPoint = { x: number; y: number };
export function componentLayout(service: Service) {
  const primary = primaryComponent(service);
  const components = primary
    ? [
        primary,
        ...(service.topology?.components.filter(
          (c) => c.name !== primary.name,
        ) ?? []),
      ]
    : [];
  const positions = Object.fromEntries(
    components.map((component, index) => [
      component.name,
      service.presentation?.positions?.[component.name] ?? {
        x: (index % 2) * 344,
        y: Math.floor(index / 2) * (componentCardHeight + 56),
      },
    ]),
  );
  if (components.length > 1) {
    for (const [key, point] of Object.entries(positions))
      positions[key] = snapMapPoint(point.x, point.y, groupGridOffset);
  }
  return {
    components,
    positions,
    width: Math.max(264, ...Object.values(positions).map((p) => p.x + 264)),
    height: Math.max(
      componentCardHeight,
      ...Object.values(positions).map((p) => p.y + componentCardHeight),
    ),
  };
}
export function mapLayout(services: Service[]) {
  const nodes = services.map((service) => {
    const count = service.topology?.components.length ?? 0;
    const grouped = count > 1;
    const children = componentLayout(service);
    return {
      service,
      grouped,
      x: 0,
      y: 0,
      width: grouped ? children.width + 48 : count ? 264 : 288,
      height: grouped
        ? children.height + 88
        : count
          ? componentCardHeight
          : 210,
      // Default placement stays stable when a group is stretched by dragging.
      baseWidth: grouped ? 656 : count ? 264 : 288,
      baseHeight: grouped
        ? 88 +
          Math.ceil(count / 2) * componentCardHeight +
          Math.max(0, Math.ceil(count / 2) - 1) * 56
        : count
          ? componentCardHeight
          : 210,
    };
  });
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(nodes.length))));
  let y = 64;
  for (let i = 0; i < nodes.length; i += columns) {
    const row = nodes.slice(i, i + columns);
    let x = 64;
    for (const node of row) {
      const saved = node.service.presentation?.positions?.[""];
      const snapped = snapMapPoint(saved?.x ?? x, saved?.y ?? y);
      node.x = snapped.x;
      node.y = snapped.y;
      x += node.baseWidth + 80;
    }
    y += Math.max(...row.map((n) => n.baseHeight)) + 72;
  }
  return {
    nodes,
    width: Math.max(288, ...nodes.map((n) => n.x + n.width + 64)),
    height: Math.max(210, ...nodes.map((n) => n.y + n.height + 64)),
  };
}

export function projectMapLayout(
  services: Service[],
  machines: { id: string; name: string }[],
) {
  const groups: {
    id: string;
    name: string;
    x: number;
    width: number;
    height: number;
  }[] = [];
  const nodes: ReturnType<typeof mapLayout>["nodes"] = [];
  let offset = 48;
  for (const machine of machines) {
    const members = services.filter(
      (service) => service.machineId === machine.id,
    );
    if (!members.length) continue;
    const group = mapLayout(members);
    groups.push({
      ...machine,
      x: offset,
      width: group.width,
      height: group.height + 48,
    });
    nodes.push(
      ...group.nodes.map((node) => ({
        ...node,
        x: node.x + offset,
        y: node.y + 48,
      })),
    );
    offset += Math.ceil(group.width / mapGridSize) * mapGridSize + 72;
  }
  return {
    groups,
    nodes,
    width: Math.max(288, offset),
    height: Math.max(210, ...groups.map((group) => group.height)),
  };
}

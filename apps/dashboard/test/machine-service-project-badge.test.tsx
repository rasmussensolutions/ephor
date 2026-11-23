import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MachineServicesMap } from "../src/components/machines/machine-services-map";
import { ServiceProjectBadge } from "../src/components/machines/service-project-badge";
import type { Project } from "../src/lib/projects";
import type { Service } from "../src/lib/services";

const service: Service = {
  id: "app",
  machineId: "machine",
  name: "Analytics",
  domain: null,
  spec: {
    image: "nginx",
    port: 80,
    healthPath: "/",
    memoryMb: 256,
    cpus: 1,
    environment: [],
    registry: null,
  },
  source: { type: "image" },
  autoDeploy: false,
  currentDeployment: null,
  runtime: null,
  runtimeAt: 0,
};
const project: Project = {
  id: "project",
  name: "Customer portal",
  serviceIds: [service.id],
};

function template(components: string[], web = true): Service {
  return {
    ...service,
    topology: {
      primary: "app",
      web,
      components: components.map((name) => ({
        name,
        image: "nginx",
        port: 80,
        internal: name !== "app",
        memoryMb: 256,
        cpus: 1,
        volumes: [],
      })),
      dependencies: [],
    },
  };
}

function renderMap(
  services: Service[],
  projects?: Project[],
  autoLayoutDisabled = false,
) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <MachineServicesMap
        services={services}
        projects={projects}
        autoLayoutDisabled={autoLayoutDisabled}
        data={{ services, deployments: [], builds: [], workers: [] }}
        onOpen={() => {}}
      />
    </RouterContextProvider>,
  );
}

for (const [label, card] of [
  ["ordinary service", service],
  ["single-component web service", template(["app"])],
  ["single-component private service", template(["app"], false)],
  ["multi-component service group", template(["app", "database"])],
] as const) {
  test(`${label} shows its project badge exactly once`, () => {
    const html = renderMap([card], [project]);
    expect(html.match(/title="Project: Customer portal"/g)).toHaveLength(1);
    expect(html).toContain('class="sr-only">Project: </span>');
    expect(html).toContain('class="truncate">Customer portal</span>');
  });

  test(`${label} has no badge when unassigned`, () => {
    const html = renderMap([card], [{ ...project, serviceIds: ["other"] }]);
    expect(html).not.toContain("Project:");
    expect(html).not.toContain("No project");
  });
}

test("each canvas service gets only its own project badge", () => {
  const html = renderMap(
    [service, { ...service, id: "other" }, { ...service, id: "unassigned" }],
    [project, { id: "second", name: "Internal tools", serviceIds: ["other"] }],
  );
  expect(html.match(/title="Project: /g)).toHaveLength(2);
  expect(html).toContain('title="Project: Customer portal"');
  expect(html).toContain('title="Project: Internal tools"');
});

test("canvases without project inventory remain unchanged", () => {
  expect(renderMap([service])).not.toContain("Project:");
});

test("auto-layout appears alongside the zoom controls only for a nonempty canvas", () => {
  const html = renderMap([service], [project]);
  expect(html).toContain('aria-label="Map controls"');
  expect(html).toContain('aria-label="Zoom out"');
  expect(html).toContain('aria-label="Fit all services"');
  const button = html.match(
    /<button\b[^>]*aria-label="Auto-layout services"[^>]*>/,
  )?.[0];
  expect(button).toBeDefined();
  expect(button).not.toMatch(/\sdisabled(?:=|[\s>])/);
  expect(renderMap([])).not.toContain('aria-label="Auto-layout services"');
});

test("auto-layout can be disabled while project membership is unavailable", () => {
  const html = renderMap([service], [], true);
  const button = html.match(
    /<button\b[^>]*aria-label="Auto-layout services"[^>]*>/,
  )?.[0];
  expect(button).toBeDefined();
  expect(button).toMatch(/\sdisabled(?:=|[\s>])/);
});

test("rendering the canvas preserves saved positions until auto-layout is requested", () => {
  const html = renderMap(
    [
      {
        ...service,
        presentation: {
          groupName: service.name,
          groupColor: "neutral",
          componentNames: {},
          positions: { "": { x: 1440, y: 1920 } },
        },
      },
    ],
    [project],
  );
  expect(html).toContain("left:1440px;top:1920px");
});

test("project badges truncate long names and retain the full name in the tooltip", () => {
  const name = "Customer portal & internal tools ".repeat(2);
  const html = renderToStaticMarkup(
    createElement(ServiceProjectBadge, { project: { ...project, name } }),
  );
  expect(html).toContain(`title="Project: ${name.replaceAll("&", "&amp;")}"`);
  expect(html).toContain('class="truncate"');
  expect(html).not.toContain("<a");
  expect(renderToStaticMarkup(createElement(ServiceProjectBadge))).toBe("");
});

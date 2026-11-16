import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { Services } from "../src/services/store";
import { Browser, enrolled } from "./helpers";

test("projects require authentication, validate names, and preserve services when removed or deleted", async () => {
  const f = await enrolled();
  expect((await new Browser(f.app).request("/projects")).status).toBe(401);
  expect(
    (await new Browser(f.app).request("/projects/create", { name: "Private" }))
      .status,
  ).toBe(401);
  for (const name of [null, "", "  ", "x".repeat(81), "bad\nname"])
    expect((await f.browser.request("/projects/create", { name })).status).toBe(
      400,
    );
  const response = await f.browser.request("/projects/create", {
    name: " Shop ",
  });
  expect(response.status).toBe(201);
  const project = await response.json();
  expect(project.name).toBe("Shop");
  const machine = await new MachineStore(f.sql).create("Project machine");
  await new MachineStore(f.sql).enroll(machine.token, randomToken());
  const services = new Services(f.sql, f.env.secret);
  const service = await services.create(
    {
      machineId: machine.id,
      name: "App",
      spec: {
        image: "docker.io/library/nginx:latest",
        port: 3000,
        healthPath: "/",
        memoryMb: 256,
        cpus: 0.5,
        environment: {},
      },
    },
    { type: "image" },
  );
  const path = `/projects/${project.id}`;
  expect(
    (await f.browser.request(`${path}/add`, { serviceId: "missing" })).status,
  ).toBe(404);
  for (let i = 0; i < 2; i++)
    expect(
      (await f.browser.request(`${path}/add`, { serviceId: service.id }))
        .status,
    ).toBe(200);
  expect((await (await f.browser.request(path)).json()).serviceIds).toEqual([
    service.id,
  ]);
  const other = await (
    await f.browser.request("/projects/create", { name: "Other" })
  ).json();
  expect(
    (
      await f.browser.request(`/projects/${other.id}/add`, {
        serviceId: service.id,
      })
    ).status,
  ).toBe(409);
  await f.browser.request(`${path}/rename`, { name: "Storefront" });
  expect((await (await f.browser.request(path)).json()).name).toBe(
    "Storefront",
  );
  await f.browser.request(`${path}/remove`, { serviceId: service.id });
  expect((await services.get(service.id)).name).toBe("App");
  expect((await (await f.browser.request(path)).json()).serviceIds).toEqual([]);
  await f.browser.request(`${path}/add`, { serviceId: service.id });
  await f.browser.request(`${path}/delete`, {});
  expect((await f.browser.request(path)).status).toBe(404);
  expect((await services.get(service.id)).name).toBe("App");
  expect(
    (
      await f.browser.request(`/projects/${other.id}/add`, {
        serviceId: service.id,
      })
    ).status,
  ).toBe(200);
  const activity = await (await f.browser.request("/activity")).json();
  expect(
    activity.items.some(
      (item: { action: string; target: { name: string } }) =>
        item.action === "Delete project" && item.target.name === "Storefront",
    ),
  ).toBe(true);
});

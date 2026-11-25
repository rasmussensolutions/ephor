import { expect, test } from "bun:test";
import { FRESH_MS, randomToken } from "../src/auth/store";
import { MachineStore } from "../src/machines/store";
import { Services } from "../src/services/store";
import { Browser, enrolled, timestamp } from "./helpers";

test("disconnected machines can be removed without deleting service history or restoring access", async () => {
  const f = await enrolled();
  const machines = new MachineStore(f.sql);
  const ticket = await machines.create("Hetzner Helsinki");
  const credential = randomToken();
  await machines.enroll(ticket.token, credential);
  const services = new Services(f.sql, f.env.secret);
  const service = await services.create(
    {
      machineId: ticket.id,
      name: "Existing service",
      spec: {
        image: "docker.io/library/nginx:alpine",
        port: 3000,
        healthPath: "/",
        memoryMb: 256,
        cpus: 1,
      },
    },
    { type: "image" },
  );
  const replacement = await machines.create("Helsinki");
  await machines.enroll(replacement.token, randomToken());
  await machines.revoke(ticket.id);
  expect((await machines.get(ticket.id)).status).toBe("revoked");

  for (let attempt = 0; attempt < 2; attempt++) {
    expect(
      (await f.browser.request("/machines/remove", { id: ticket.id })).status,
    ).toBe(200);
  }
  const inventory = await (await f.browser.request("/machines")).json();
  expect(
    inventory.machines.map((machine: { id: string }) => machine.id),
  ).toEqual([replacement.id]);
  expect((await f.browser.request(`/machines/${ticket.id}`)).status).toBe(404);
  expect((await services.get(service.id)).machine_id).toBe(ticket.id);
  const [retained] = await f.sql.query<{ state: string; removed_at: number }>(
    "SELECT state,removed_at FROM ephor_machine WHERE id=$1",
    [ticket.id],
  );
  expect(retained?.state).toBe("revoked");
  expect(Number(retained?.removed_at)).toBeGreaterThan(0);
  await expect(machines.identity(credential)).rejects.toThrow(
    "INVALID_MACHINE_CREDENTIAL",
  );
  await expect(machines.enroll(ticket.token, credential)).rejects.toThrow(
    "INVALID_ENROLLMENT",
  );
  expect(
    (
      await f.browser.request("/machines/rename", {
        id: ticket.id,
        name: "Restore",
      })
    ).status,
  ).toBe(404);
  expect(
    await f.sql.query(
      "SELECT event FROM ephor_auth_audit WHERE subject=$1 AND event='machine.removed'",
      [ticket.id],
    ),
  ).toHaveLength(2);
});

test("removal requires a disconnected machine, owner session, same origin and fresh verification", async () => {
  const f = await enrolled();
  const machines = new MachineStore(f.sql);
  const ticket = await machines.create("Machine");
  const body = { id: ticket.id };
  expect((await f.browser.request("/machines/remove", body)).status).toBe(409);
  await machines.enroll(ticket.token, randomToken());
  expect((await f.browser.request("/machines/remove", body)).status).toBe(409);
  await machines.revoke(ticket.id);
  expect(
    (await new Browser(f.app).request("/machines/remove", body)).status,
  ).toBe(401);
  expect(
    (
      await f.browser.request("/machines/remove", body, {
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - FRESH_MS - 1000),
  ]);
  expect((await f.browser.request("/machines/remove", body)).status).toBe(403);
  expect(await machines.list(ticket.id)).toHaveLength(1);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now()),
  ]);
  for (const id of ["", null, 123, "x".repeat(65)]) {
    expect((await f.browser.request("/machines/remove", { id })).status).toBe(
      400,
    );
  }
  expect((await f.browser.request("/machines/remove", body)).status).toBe(200);
});

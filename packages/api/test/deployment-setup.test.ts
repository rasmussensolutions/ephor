import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createApi } from "../src";
import { validateConfig } from "../src/auth/config";
import { GRANT_MS } from "../src/auth/store";
import { Browser, fixture, login, register, SecurityKey } from "./helpers";

async function deployment() {
  const f = await fixture();
  const setupCode = randomBytes(32).toString("hex");
  const env = { ...f.env, setupCode };
  const app = createApi(env);
  return { ...f, env, app, setupCode, browser: new Browser(app) };
}

test("deployment code completes owner registration and passkey login through the API", async () => {
  const f = await deployment();
  expect(await (await f.browser.request("/setup/status")).json()).toEqual({
    configured: false,
    enrolling: false,
  });
  expect(
    (await f.browser.request("/setup/start", { code: "wrong" })).status,
  ).toBe(401);
  expect(
    (
      await f.browser.request("/setup/start", {
        code: f.setupCode,
        name: "Owner",
      })
    ).status,
  ).toBe(200);
  expect(JSON.stringify((await f.store.read()).state)).not.toContain(
    f.setupCode,
  );
  const key = new SecurityKey();
  expect((await register(f.browser, key)).status).toBe(200);
  expect((await login(new Browser(f.app), key)).status).toBe(200);
  const rotated = createApi({
    ...f.env,
    setupCode: randomBytes(32).toString("hex"),
  });
  expect(
    (await new Browser(rotated).request("/setup/start", { code: f.setupCode }))
      .status,
  ).toBe(401);
  expect(
    (await f.browser.request("/recovery/start", { code: f.setupCode })).status,
  ).toBe(401);
});

test("deployment code is atomically consumed across instances and stays consumed after grant expiry", async () => {
  const f = await deployment();
  const results = await Promise.all([
    f.browser.request("/setup/start", { code: f.setupCode }),
    new Browser(createApi(f.env)).request("/setup/start", {
      code: f.setupCode,
    }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  await f.store.change((s) => {
    if (s.grant) s.grant.expires = Date.now() - GRANT_MS;
  });
  expect(
    (
      await new Browser(createApi(f.env)).request("/setup/start", {
        code: f.setupCode,
      })
    ).status,
  ).toBe(401);
  const nextCode = randomBytes(32).toString("hex");
  const next = new Browser(createApi({ ...f.env, setupCode: nextCode }));
  expect((await next.request("/setup/start", { code: nextCode })).status).toBe(
    200,
  );
});

test("a configured owner rejects the current deployment code even after rotation", async () => {
  const f = await deployment();
  await f.browser.request("/setup/start", { code: f.setupCode });
  expect((await register(f.browser, new SecurityKey())).status).toBe(200);
  const nextCode = randomBytes(32).toString("hex");
  const next = new Browser(createApi({ ...f.env, setupCode: nextCode }));
  expect((await next.request("/setup/start", { code: nextCode })).status).toBe(
    401,
  );
});

test("administrator-issued setup codes override deployment codes and retain expiry", async () => {
  const f = await deployment();
  const adminCode = await f.store.issueSetup();
  expect(
    (await f.browser.request("/setup/start", { code: f.setupCode })).status,
  ).toBe(401);
  expect(
    (await f.browser.request("/setup/start", { code: adminCode })).status,
  ).toBe(200);
  const expired = await f.store.issueSetup();
  await f.store.change((s) => {
    if (s.setup) s.setup.expires = Date.now() - 1;
  });
  expect(
    (await f.browser.request("/setup/start", { code: expired })).status,
  ).toBe(401);
  expect(
    (await f.browser.request("/setup/start", { code: f.setupCode })).status,
  ).toBe(401);
});

test("deployment setup rejects weak codes and reuse of the authentication secret", async () => {
  const f = await fixture();
  for (const setupCode of [
    "weak",
    "a".repeat(64),
    f.env.secret,
    ` ${randomBytes(32).toString("hex")}`,
    randomBytes(65).toString("hex"),
  ])
    expect(() => validateConfig({ ...f.env, setupCode })).toThrow();
});

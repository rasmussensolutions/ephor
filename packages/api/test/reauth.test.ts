import { expect, test } from "bun:test";
import { FRESH_MS } from "../src/auth/store";
import { Browser, enrolled, login, origin, timestamp } from "./helpers";

async function verify(f: Awaited<ReturnType<typeof enrolled>>) {
  const options = await (
    await f.browser.request("/security/reauth/options", {})
  ).json();
  return f.browser.request("/security/reauth/verify", {
    response: f.key.assertion(options.challenge),
  });
}
test("repeated passkey verifications keep the same session, cookie and expiry and record Verify identity", async () => {
  const f = await enrolled();
  const before = await (await f.browser.request("/session")).json();
  const cookies = [...f.browser.cookies];
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - FRESH_MS - 1000),
  ]);
  expect((await f.browser.request("/security/recovery-codes", {})).status).toBe(
    403,
  );
  for (let i = 0; i < 3; i++) expect((await verify(f)).status).toBe(200);
  expect((await f.browser.request("/security/recovery-codes", {})).status).toBe(
    200,
  );
  const after = await (await f.browser.request("/session")).json();
  expect(after.session.id).toBe(before.session.id);
  expect(after.session.expiresAt).toBe(before.session.expiresAt);
  expect(Date.parse(after.session.freshUntil)).toBeGreaterThan(Date.now());
  expect([...f.browser.cookies]).toEqual(cookies);
  expect(await f.sql.query("SELECT id FROM session")).toHaveLength(1);
  const activity = await (await f.browser.request("/activity")).json();
  expect(
    activity.items.filter(
      (a: { action: string }) => a.action === "Verify identity",
    ),
  ).toHaveLength(3);
  expect(
    activity.items.filter((a: { action: string }) => a.action === "Sign in"),
  ).toHaveLength(0);
});
test("verification is session bound, single-use, requires UV and validates the origin", async () => {
  const f = await enrolled();
  const other = new Browser(f.app);
  await login(other, f.key);
  let options = await (
    await f.browser.request("/security/reauth/options", {})
  ).json();
  expect(
    (
      await other.request("/security/reauth/verify", {
        response: f.key.assertion(options.challenge),
      })
    ).status,
  ).toBe(403);
  const assertion = f.key.assertion(options.challenge);
  const attempts = await Promise.all([
    f.browser.request("/security/reauth/verify", { response: assertion }),
    f.browser.request("/security/reauth/verify", { response: assertion }),
  ]);
  expect(attempts.map((r) => r.status).sort()).toEqual([200, 403]);
  for (const [uv, site] of [
    [false, origin],
    [true, "https://evil.example"],
  ] as const) {
    options = await (
      await f.browser.request("/security/reauth/options", {})
    ).json();
    expect(
      (
        await f.browser.request("/security/reauth/verify", {
          response: f.key.assertion(options.challenge, uv, site),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.browser.request("/security/reauth/verify", {
          response: f.key.assertion(options.challenge),
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (await new Browser(f.app).request("/security/reauth/options", {})).status,
  ).toBe(401);
});
test("verification does not revive revoked sessions or authorize a later session", async () => {
  const f = await enrolled();
  expect((await verify(f)).status).toBe(200);
  const other = new Browser(f.app);
  await login(other, f.key);
  await f.sql.query('UPDATE session SET "createdAt"=$1', [
    timestamp(Date.now() - FRESH_MS - 1000),
  ]);
  expect((await other.request("/security/recovery-codes", {})).status).toBe(
    403,
  );
  await f.browser.request("/security/reauth/options", {});
  await f.browser.request("/auth/sign-out", {});
  expect((await f.browser.request("/security/reauth/verify", {})).status).toBe(
    401,
  );
  expect(
    await f.sql.query("SELECT * FROM ephor_session_verification"),
  ).toHaveLength(0);
});

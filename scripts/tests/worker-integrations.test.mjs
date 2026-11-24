import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("integrations use native Workers fetch and D1 without following credential-bearing redirects", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ephor-worker-test-"));
  let runtime;
  try {
    const bundle = join(directory, "worker.js");
    const built = spawnSync(
      "bun",
      [
        "build",
        "scripts/tests/fixtures/worker-integrations.ts",
        "--target",
        "browser",
        "--outfile",
        bundle,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const template = JSON.parse(
      await readFile(join(root, "wrangler.jsonc"), "utf8"),
    );
    const calls = [];
    let redirectAll = false;
    const outboundService = async (request) => {
      const url = new URL(request.url);
      calls.push(url.href);
      const json = (value) =>
        new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        });
      if (redirectAll)
        return new Response(null, {
          status: 302,
          headers: { Location: "https://unexpected.example/steal" },
        });
      if (url.hostname === "api.github.com") {
        if (url.pathname === "/redirect")
          return new Response(null, {
            status: 302,
            headers: { Location: "https://unexpected.example/steal" },
          });
        if (url.pathname.includes("/conversions")) {
          const panel = url.pathname.includes("/panel/");
          return json({
            id: panel ? 124 : 123,
            slug: panel ? "ephor-panel" : "ephor-services",
            pem: privateKey,
            webhook_secret: "fixture-webhook-secret",
          });
        }
        if (url.pathname === "/repos/fixture/web")
          return json({ id: 1, full_name: "fixture/web", owner: { id: 2 } });
        const jwt = request.headers
          .get("Authorization")
          ?.replace(/^Bearer /, "");
        assert.ok(jwt);
        const [header, payload, signature] = jwt.split(".");
        assert.ok(
          verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${payload}`),
            publicKey,
            Buffer.from(signature, "base64url"),
          ),
        );
        const panel = url.pathname.includes("/100");
        assert.equal(
          JSON.parse(Buffer.from(payload, "base64url").toString()).iss,
          panel ? "124" : "123",
        );
        if (url.pathname.endsWith("/access_tokens"))
          return json({ token: "fixture-installation-token" });
        return json({
          app_id: panel ? 124 : 123,
          suspended_at: null,
          account: { login: "fixture" },
        });
      }
      if (url.hostname === "backboard.railway.com")
        return json({ data: { fixture: true } });
      if (url.hostname === "api.cloudflare.com")
        return json({ success: true, result: {} });
      if (url.hostname === "openrouter.ai")
        return json({
          data: [
            {
              id: "fixture/model",
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
            },
          ],
        });
      if (url.hostname === "cloudflare-dns.com")
        return json({ Status: 0, Answer: [{ type: 1, data: "203.0.113.1" }] });
      if (url.hostname === "api.resend.com")
        return json({ id: "fixture-email" });
      throw Error(`Unexpected outbound host: ${url.hostname}`);
    };
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: await readFile(bundle, "utf8"),
        compatibilityDate: template.compatibility_date,
        compatibilityFlags: template.compatibility_flags,
        d1Databases: ["DB"],
        outboundService,
      }),
    );
    const db = await runtime.getD1Database("DB");
    const migrations = join(root, "packages/api/migrations/sqlite");
    for (const file of (await readdir(migrations))
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      for (const sql of (await readFile(join(migrations, file), "utf8"))
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        await db.prepare(sql).run();
    }
    const invoke = async (path) => {
      const response = await runtime.dispatchFetch(`https://fixture/${path}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    for (const purpose of ["services", "panel"]) {
      const result = await invoke(purpose);
      assert.equal(result.status.configured, true);
      assert.equal(result.status.installations.length, 1);
      assert.equal(result.replayRejected, true);
    }
    const rows = (
      await db.prepare("SELECT config FROM ephor_integration").all()
    ).results;
    assert.ok(
      rows.every(
        (row) =>
          !row.config.includes("PRIVATE KEY") &&
          !row.config.includes("fixture-webhook-secret"),
      ),
    );
    assert.ok((await invoke("ai")).models.includes("fixture/model"));
    assert.equal((await invoke("email")).email_status, "sent");
    assert.ok((await invoke("dns")).length > 0);
    assert.equal((await invoke("legacy")).repositoryId, "1");
    assert.equal((await invoke("releases")).ok, true);
    const before = calls.length;
    const redirect = await runtime.dispatchFetch("https://fixture/redirect");
    assert.equal(redirect.status, 500);
    assert.equal(
      (await redirect.json()).error,
      "GITHUB_REPOSITORY_UNAVAILABLE",
    );
    assert.equal(calls.length, before + 1);
    redirectAll = true;
    for (const [scenario, code] of [
      ["releases", "RAILWAY_HTTP_302"],
      ["ai", "AI_PROVIDER_UNAVAILABLE"],
      ["dns", "DNS_LOOKUP_FAILED"],
      ["legacy", "GITHUB_REPOSITORY_UNAVAILABLE"],
    ]) {
      const response = await runtime.dispatchFetch(
        `https://fixture/${scenario}`,
      );
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error, code);
    }
    assert.equal((await invoke("email")).email_status, "failed");
    assert.ok(!calls.some((url) => url.includes("unexpected.example")));
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("released Worker enables machine enrollment updates without release variables", {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ephor-worker-enrollment-"));
  let runtime;
  try {
    const bundle = join(directory, "worker.js");
    const built = spawnSync(
      "bun",
      [
        "build",
        "apps/worker/src/index.ts",
        "--target",
        "browser",
        "--outfile",
        bundle,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const template = JSON.parse(
      await readFile(join(root, "wrangler.jsonc"), "utf8"),
    );
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: await readFile(bundle, "utf8"),
        compatibilityDate: template.compatibility_date,
        compatibilityFlags: template.compatibility_flags,
        d1Databases: ["DB"],
        bindings: {
          EPHOR_ORIGIN: "https://fixture.example",
          BETTER_AUTH_SECRET: "0123456789abcdef".repeat(6),
        },
        serviceBindings: {
          ASSETS: async () =>
            Response.json({
              x86_64: "a".repeat(64),
              aarch64: "b".repeat(64),
              securityProtocol: 1,
              updaterProtocol: 3,
              serviceProtocol: 6,
            }),
        },
      }),
    );
    const db = await runtime.getD1Database("DB");
    const migrations = join(root, "packages/api/migrations/sqlite");
    for (const file of (await readdir(migrations))
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      for (const sql of (await readFile(join(migrations, file), "utf8"))
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean))
        await db.prepare(sql).run();
    }
    const response = await runtime.dispatchFetch(
      "https://fixture.example/api/agent/install.sh",
    );
    const script = await response.text();
    assert.equal(response.status, 200, script);
    assert.ok(
      script.includes(
        `configure-updater '${template.vars.EPHOR_RELEASE_PUBLIC_KEY}'`,
      ),
    );
    assert.ok(script.includes("systemctl enable --now ephor-updater.timer"));
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

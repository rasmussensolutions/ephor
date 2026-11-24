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
    // Exercise the actual Worker route, MCP transport and D1 adapter together.
    const metadata = await runtime.dispatchFetch(
      "https://fixture.example/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(
      (await metadata.json()).resource,
      "https://fixture.example/mcp",
    );
    const anonymous = await runtime.dispatchFetch(
      "https://fixture.example/mcp",
      {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      },
    );
    assert.equal(anonymous.status, 401);
    assert.ok(
      anonymous.headers
        .get("WWW-Authenticate")
        .includes("oauth-protected-resource"),
    );
    const token = `ephor_${"a".repeat(64)}`;
    const { createHash } = await import("node:crypto");
    const state = JSON.parse(
      (await db.prepare("SELECT data FROM ephor_auth_state WHERE id=1").first())
        .data,
    );
    state.configured = true;
    await db
      .prepare("UPDATE ephor_auth_state SET data=? WHERE id=1")
      .bind(JSON.stringify(state))
      .run();
    await db
      .prepare(
        "INSERT INTO ephor_mcp_connection(id,name,token_hash,policy,epoch,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        "worker-test",
        "Worker test",
        createHash("sha256").update(token).digest("hex"),
        JSON.stringify({ allProjects: true }),
        state.epoch,
        Date.now() + 60000,
        Date.now(),
      )
      .run();
    const mcp = async (method, params = {}) =>
      runtime.dispatchFetch("https://fixture.example/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    const initialized = await mcp("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "worker-test", version: "1" },
    });
    assert.equal(initialized.status, 200, await initialized.clone().text());
    const listed = await (await mcp("tools/list")).json();
    assert.ok(listed.result.tools.some((t) => t.name === "list_projects"));
    assert.ok(listed.result.tools.some((t) => t.name === "deploy_service"));
    assert.ok(listed.result.tools.some((t) => t.name === "read_logs"));
    assert.ok(listed.result.tools.some((t) => t.name === "list_repositories"));
    const create = async () =>
      (
        await mcp("tools/call", {
          name: "create_project",
          arguments: { name: "Worker project", requestKey: "worker-create-01" },
        })
      ).json();
    const denied = await create();
    assert.equal(denied.result.isError, true);
    assert.deepEqual(denied.result.content, [
      { type: "text", text: "MCP_SCOPE_DENIED" },
    ]);
    await db
      .prepare("UPDATE ephor_mcp_connection SET policy=? WHERE id=?")
      .bind(JSON.stringify({ allProjects: true, manage: true }), "worker-test")
      .run();
    const proposed = await create();
    assert.equal(proposed.result.isError, undefined);
    assert.equal(proposed.result.structuredContent.result.status, "pending");
    assert.deepEqual(
      (await (await mcp("tools/list")).json()).result,
      listed.result,
    );
    assert.equal(
      await db
        .prepare("SELECT id FROM ephor_project WHERE name=?")
        .bind("Worker project")
        .first(),
      null,
    );
    const projects = await (
      await mcp("tools/call", { name: "list_projects", arguments: {} })
    ).json();
    assert.equal(projects.result.isError, undefined);
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

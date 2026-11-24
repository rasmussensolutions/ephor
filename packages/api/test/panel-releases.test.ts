import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createApi } from "../src";
import {
  bounded,
  type PanelRelease,
  ReleaseSource,
  type SignedRelease,
  sha256,
  verifyRelease,
} from "../src/panel/release/manifest";
import { Providers } from "../src/panel/release/providers";
import type { Hosting, ReleaseJob } from "../src/panel/release/types";
import { PanelReleases } from "../src/panel/release/updates";
import { fixture } from "./helpers";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = Buffer.from(
  publicKey.export({ format: "jwk" }).x ?? "",
  "base64url",
).toString("hex");
const verify = (e: SignedRelease) => verifyRelease(e, key);
const bytes = new TextEncoder().encode("verified content");
async function release(): Promise<PanelRelease> {
  const a = {
    name: "worker.mjs",
    size: bytes.length,
    sha256: await sha256(bytes),
  };
  return {
    format: 1,
    version: "0.3.2",
    sequence: 3,
    minimumSequence: 0,
    image: `ghcr.io/rasmussensolutions/ephor-panel@sha256:${"a".repeat(64)}`,
    worker: a,
    installer: { ...a, name: "install.mjs" },
    assets: {
      "/index.html": {
        ...a,
        name: "index.asset",
        type: "text/html",
        hash: "b".repeat(32),
      },
    },
    migrations: [
      { name: "0028_example.sql", sql: "CREATE TABLE example(id INTEGER);" },
    ],
    compatibilityDate: "2026-11-12",
    headers: "/*\n X-Frame-Options: DENY",
  };
}
function signed(r: PanelRelease): SignedRelease {
  const payload = JSON.stringify(r);
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(`ephor:panel-release:v1\n${payload}`),
      privateKey,
    ).toString("hex"),
  };
}
async function setup() {
  const f = await fixture(),
    panel = new PanelReleases(
      { ...f.env, panelUpdaterToken: "a".repeat(64) },
      undefined,
      // Fixture versions must not change when the application is released.
      { version: "0.3.1", sequence: 2 },
      verify,
    );
  const r = await release(),
    envelope = signed(r);
  panel.source.latest = async () => envelope;
  await panel.configure({ host: "docker" });
  await panel.updater({});
  await panel.check();
  return { f, panel, r, envelope };
}
test("signed releases reject tampering, another signer, executable paths and untrusted registries", async () => {
  const r = await release(),
    e = signed(r);
  expect((await verify(e)).version).toBe("0.3.2");
  await expect(verify({ ...e, payload: `${e.payload} ` })).rejects.toThrow(
    "Untrusted",
  );
  await expect(verifyRelease(e)).rejects.toThrow("Untrusted");
  await expect(
    verify(signed({ ...r, image: "ghcr.io/attacker/panel:latest" })),
  ).rejects.toThrow("Invalid");
  await expect(
    verify(signed({ ...r, worker: { ...r.worker, name: "../secret" } })),
  ).rejects.toThrow("Invalid");
});
test("standalone VPS installers and HTTPS image stay inside the signed artifact boundary", async () => {
  const r = await release();
  const vps = {
    x64: {
      ...r.installer,
      name: "ephor-installer-linux-x64",
      size: 100_000_000,
    },
    arm64: {
      ...r.installer,
      name: "ephor-installer-linux-arm64",
      size: 100_000_000,
    },
    caddyImage: `docker.io/library/caddy@sha256:${"c".repeat(64)}`,
  };
  expect((await verify(signed({ ...r, vps }))).vps?.arm64.size).toBe(
    100_000_000,
  );
  for (const invalid of [
    { ...vps, caddyImage: "docker.io/attacker/caddy:latest" },
    { ...vps, x64: { ...vps.x64, name: "../installer" } },
    { ...vps, arm64: { ...vps.arm64, name: "ephor-installer-linux-x64" } },
    { ...vps, x64: { ...vps.x64, size: 150 * 1024 * 1024 + 1 } },
  ])
    await expect(verify(signed({ ...r, vps: invalid }))).rejects.toThrow(
      "Invalid",
    );
  const envelope = signed({ ...r, vps });
  await expect(
    verify({
      ...envelope,
      payload: envelope.payload.replace("100000000", "100000001"),
    }),
  ).rejects.toThrow("Untrusted");
});
test("downloads are bounded, credential-free and reject redirected credential exfiltration and bad hashes", async () => {
  await expect(bounded(new Response("x".repeat(10)), 9)).rejects.toThrow(
    "size limit",
  );
  const calls: RequestInit[] = [];
  const source = new ReleaseSource((async (
    _u: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push(init ?? {});
    return new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example/asset" },
    });
  }) as unknown as typeof fetch);
  await expect(
    source.artifact(await release(), (await release()).worker),
  ).rejects.toThrow("Untrusted release redirect");
  expect(calls).toHaveLength(1);
  expect(new Headers(calls[0]?.headers).has("authorization")).toBe(false);
  const bad = new ReleaseSource(
    (async () => new Response("modified")) as unknown as typeof fetch,
  );
  await expect(
    bad.artifact(await release(), (await release()).worker),
  ).rejects.toThrow("checksum");
});
test("release jobs require a live updater, matching version, newer signed release and an exclusive lease", async () => {
  const { panel, f } = await setup();
  await expect(panel.install({ version: "wrong" })).rejects.toThrow(
    "PANEL_RELEASE_INCOMPATIBLE",
  );
  await panel.install({ version: "0.3.2" });
  await expect(panel.install({ version: "0.3.2" })).rejects.toThrow(
    "PANEL_UPDATE_BUSY",
  );
  await expect(panel.configure({ host: "docker" })).rejects.toThrow(
    "PANEL_UPDATE_BUSY",
  );
  await panel.change(async () => {
    await expect(
      new PanelReleases(panel.env).change(async () => {}),
    ).rejects.toThrow("PANEL_UPDATE_BUSY");
  });
  const rows = await f.env.sql.query<{ payload: string }>(
    "SELECT payload FROM ephor_panel_release",
  );
  expect(rows[0]?.payload).not.toContain("0.3.2");
});
test("deployment acceptance is not success; only the matching running version acknowledges it", async () => {
  const { panel } = await setup();
  await panel.install({ version: "0.3.2" });
  const work = await panel.updater({});
  expect(work?.stage).toBe("queued");
  await panel.updater({ id: work?.id, stage: "verifying" });
  await panel.tick();
  expect((await panel.status()).job?.stage).toBe("verifying");
  const restarted = new PanelReleases(
    panel.env,
    undefined,
    { version: "0.3.2", sequence: 3 },
    verify,
  );
  await restarted.tick();
  expect((await restarted.status()).job?.stage).toBe("complete");
});
test("stale channels cannot roll back a previously observed release and status never returns provider secrets", async () => {
  const { panel, r } = await setup();
  panel.source.latest = async () =>
    signed({ ...r, version: "0.3.0", sequence: 1 });
  await expect(panel.check()).rejects.toThrow("PANEL_RELEASE_REPLAY");
  await panel.change(async (s, save) => {
    s.hosting = {
      host: "cloudflare",
      token: "private-provider-token",
      accountId: "a".repeat(32),
      worker: "ephor",
      databaseId: crypto.randomUUID(),
    };
    await save();
  });
  expect(JSON.stringify(await panel.status())).not.toContain(
    "private-provider-token",
  );
});
test("Cloudflare upload preserves secrets and security headers; migrations include their ledger entry atomically", async () => {
  const h: Extract<Hosting, { host: "cloudflare" }> = {
    host: "cloudflare",
    token: "private-token",
    accountId: "a".repeat(32),
    worker: "ephor",
    databaseId: crypto.randomUUID(),
  };
  const r = await release(),
    job: ReleaseJob = {
      id: "job",
      version: r.version,
      sequence: 3,
      envelope: signed(r),
      stage: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      message: "",
    };
  const calls: { path: string; body: unknown }[] = [];
  let applied = false,
    durable = "";
  const provider = new Providers((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const u = new URL(String(input));
    if (u.hostname === "github.com") return new Response(bytes);
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    calls.push({ path: u.pathname, body });
    let result: unknown = {};
    if (u.pathname.endsWith("assets-upload-session"))
      result = { jwt: "upload-token", buckets: [["b".repeat(32)]] };
    else if (u.pathname.endsWith("/assets/upload")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer upload-token",
      );
      result = { jwt: "completion-token" };
    } else if (u.pathname.endsWith("/bookmark"))
      result = { bookmark: "recovery-bookmark" };
    else if (u.pathname.endsWith("/query")) {
      if (body.batch) {
        expect(body.batch[1].params).toEqual(["0028_example.sql"]);
        applied = true;
      }
      result = [
        {
          results:
            body.sql?.startsWith("SELECT") && applied
              ? [{ name: "0028_example.sql" }]
              : [],
        },
      ];
    } else if (u.pathname.endsWith("/settings"))
      result = {
        bindings: [
          { name: "DB", type: "d1" },
          { name: "BETTER_AUTH_SECRET", type: "secret_text" },
          { name: "ASSETS", type: "assets" },
          { name: "EPHOR_PANEL_ROUTES", type: "plain_text" },
        ],
      };
    else if (init?.method === "PUT") {
      expect(durable).toBe("verifying");
      const m = JSON.parse((body as FormData).get("metadata") as string);
      expect(m.bindings).toContainEqual({
        name: "BETTER_AUTH_SECRET",
        type: "inherit",
      });
      expect(m.assets.config._headers).toBe(r.headers);
      expect(m.assets.config.run_worker_first).toEqual([
        "/api/*",
        "/health",
        "/mcp",
        "/oauth/*",
        "/.well-known/*",
      ]);
      expect(
        m.bindings.filter(
          (b: { name: string }) => b.name === "EPHOR_PANEL_ROUTES",
        ),
      ).toEqual([
        { name: "EPHOR_PANEL_ROUTES", type: "plain_text", text: "1:0.3.2" },
      ]);
    }
    return Response.json({ success: true, result });
  }) as unknown as typeof fetch);
  while (job.stage !== "verifying")
    await provider.cloudflareStep(h, r, job, async () => {
      durable = job.stage;
    });
  expect(job.recovery).toContain("recovery-bookmark");
  expect(calls.filter((c) => c.path.endsWith("/assets/upload"))).toHaveLength(
    1,
  );
});
test("an upgrade installed by an older Cloudflare updater repairs routing before acknowledging success", async () => {
  const { panel, r, envelope } = await setup();
  const h: Extract<Hosting, { host: "cloudflare" }> = {
    host: "cloudflare",
    token: "private-token",
    accountId: "a".repeat(32),
    worker: "ephor",
    databaseId: crypto.randomUUID(),
  };
  await panel.change(async (s, save) => {
    s.hosting = h;
    s.job = {
      id: "upgrade",
      version: r.version,
      sequence: r.sequence,
      envelope,
      stage: "verifying",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      message: "",
      recovery: "original pre-migration bookmark",
    };
    await save();
  });
  let uploads = 0,
    deployments = 0,
    mismatch = true;
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.hostname === "github.com") return new Response(bytes);
    let result: unknown;
    if (u.pathname.endsWith("/settings")) {
      result = {
        bindings: [
          {
            name: "DB",
            type: "d1",
            id: mismatch ? "wrong-database" : h.databaseId,
          },
          { name: "EPHOR_ORIGIN", type: "plain_text", text: panel.env.origin },
          { name: "BETTER_AUTH_SECRET", type: "secret_text" },
        ],
      };
    } else if (u.pathname.endsWith("/query")) {
      const body = JSON.parse(String(init?.body));
      // Repair must not re-run migrations or overwrite the original recovery point.
      expect(body.sql).toBe("SELECT lease FROM ephor_panel_release WHERE id=1");
      result = [{ results: await panel.env.sql.query(body.sql) }];
    } else if (u.pathname.endsWith("/assets-upload-session")) {
      uploads++;
      result = { jwt: "fresh-upload-token", buckets: [] };
    } else if (init?.method === "PUT") {
      deployments++;
      expect((await panel.state()).job?.stage).toBe("verifying");
      const metadata = JSON.parse(
        (init.body as FormData).get("metadata") as string,
      );
      expect(metadata.assets.config.run_worker_first).toContain("/mcp");
      expect(metadata.bindings).toContainEqual({
        name: "EPHOR_PANEL_ROUTES",
        type: "plain_text",
        text: "1:0.3.2",
      });
      // Simulate acceptance followed by loss of the HTTP response.
      throw new Error("connection lost");
    } else throw new Error(`Unexpected provider request: ${u.pathname}`);
    return Response.json({ success: true, result });
  }) as typeof fetch;
  const env = {
    ...panel.env,
    deployment: {
      runtime: "cloudflare-worker" as const,
      frontend: "same-runtime" as const,
      // An old updater can inherit the previous release's routing marker.
      panelRoutes: "1:0.3.1",
    },
  };
  const restarted = new PanelReleases(
    env,
    request,
    { version: r.version, sequence: r.sequence },
    verify,
  );
  await restarted.tick();
  expect(uploads).toBe(0);
  expect((await panel.state()).job?.message).toContain("HOST_TARGET_MISMATCH");
  mismatch = false;
  await restarted.tick();
  expect(uploads).toBe(1);
  expect(deployments).toBe(1);
  expect((await panel.state()).job?.recovery).toBe(
    "original pre-migration bookmark",
  );
  await restarted.tick();
  expect(deployments).toBe(1);
  expect((await panel.state()).job?.stage).toBe("verifying");
  const routed = new PanelReleases(
    { ...env, deployment: { ...env.deployment, panelRoutes: "1:0.3.2" } },
    request,
    restarted.running,
    verify,
  );
  await routed.tick();
  expect((await panel.state()).job?.stage).toBe("complete");
  expect((await panel.state()).job?.upload).toBeUndefined();
});
test("credential-bearing provider redirects are never followed", async () => {
  let calls = 0;
  const p = new Providers((async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://attacker.example" },
    });
  }) as unknown as typeof fetch);
  await expect(
    p.railway(
      {
        host: "railway",
        token: "secret",
        serviceId: "id",
        environmentId: "env",
      },
      "query { me { id } }",
    ),
  ).rejects.toThrow("RAILWAY_HTTP_302");
  expect(calls).toBe(1);
});

test("panel APIs require owner authentication and updater token is limited to polling", async () => {
  const f = await fixture();
  expect((await f.app.request("/api/panel/status")).status).toBe(401);
  expect(
    (
      await f.app.request("/api/panel/install", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: f.env.origin },
        body: '{"version":"0.3.1"}',
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.app.request("/api/panel-updater/poll", {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
  ).toBe(401);
});

test("host updater can poll without browser Origin but cannot use the owner routes", async () => {
  const f = await fixture();
  const token = "secret-updater-token".repeat(4);
  const app = createApi({ ...f.env, panelUpdaterToken: token });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  expect(
    (
      await app.request("/api/panel-updater/poll", {
        method: "POST",
        headers,
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect((await app.request("/api/panel/status", { headers })).status).toBe(
    401,
  );
});

test("Railway deploys only the signed image and saves verification state before triggering replacement", async () => {
  const r = await release();
  const h: Extract<Hosting, { host: "railway" }> = {
    host: "railway",
    token: "workspace-token",
    serviceId: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
  };
  const j: ReleaseJob = {
    id: crypto.randomUUID(),
    version: r.version,
    sequence: r.sequence,
    envelope: signed(r),
    stage: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    message: "",
  };
  let durable = "queued",
    calls = 0;
  const p = new Providers((async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer workspace-token",
    );
    expect(new Headers(init?.headers).has("Project-Access-Token")).toBe(false);
    const body = JSON.parse(String(init?.body));
    calls++;
    if (calls === 1) {
      expect(body.variables.input.source).toEqual({
        image: r.image,
        repo: null,
      });
      expect(body.variables.input.healthcheckPath).toBe("/health");
      expect(body.variables.input.startCommand).toBe(
        "/usr/local/bin/ephor-entrypoint bun apps/server/dist/index.js",
      );
      return Response.json({ data: { serviceInstanceUpdate: true } });
    }
    expect(durable).toBe("verifying");
    return Response.json({
      data: { serviceInstanceDeployV2: "deployment-id" },
    });
  }) as unknown as typeof fetch);
  await p.railwayDeploy(h, r, j, async () => {
    durable = j.stage;
  });
  expect(j.deploymentId).toBe("deployment-id");
  expect(j.stage).toBe("verifying");
  expect(calls).toBe(2);
});

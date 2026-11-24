import { bounded, type PanelRelease, ReleaseSource } from "./manifest";
import type { Hosting, ReleaseJob } from "./types";
// Installed atomically with assets routing, so the new invocation can acknowledge it.
export const CLOUDFLARE_PANEL_ROUTES_VERSION = "1";
export class ProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class Providers {
  readonly request: typeof fetch;
  readonly releases: ReleaseSource;
  constructor(request: typeof fetch = fetch) {
    this.request = request.bind(globalThis);
    this.releases = new ReleaseSource(request);
  }
  async cf<T>(
    h: Extract<Hosting, { host: "cloudflare" }>,
    path: string,
    method = "GET",
    body?: unknown,
    jwt?: string,
  ): Promise<T> {
    const response = await this.request(
      `https://api.cloudflare.com/client/v4/accounts/${h.accountId}${path}`,
      {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(45_000),
        headers: {
          Authorization: `Bearer ${jwt ?? h.token}`,
          ...(body instanceof FormData || body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(`CLOUDFLARE_HTTP_${response.status}`);
    }
    const result = JSON.parse(
      new TextDecoder().decode(await bounded(response, 2_000_000)),
    );
    if (!result.success) throw new ProviderError("CLOUDFLARE_REQUEST_FAILED");
    return result.result;
  }
  async railway<T>(
    h: Extract<Hosting, { host: "railway" }>,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await this.request(
      "https://backboard.railway.com/graphql/v2",
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({
          query,
          variables: {
            serviceId: h.serviceId,
            environmentId: h.environmentId,
            ...variables,
          },
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderError(`RAILWAY_HTTP_${response.status}`);
    }
    const result = JSON.parse(
      new TextDecoder().decode(await bounded(response, 1_000_000)),
    );
    if (result.errors?.length || !result.data)
      throw new ProviderError("RAILWAY_REQUEST_FAILED");
    return result.data;
  }
  async validate(h: Hosting, origin: string, lease?: string) {
    if (h.host === "cloudflare") {
      const settings = await this.cf<{
        bindings: { name: string; type: string; id?: string; text?: string }[];
      }>(h, `/workers/scripts/${h.worker}/settings`);
      if (
        !settings.bindings.some(
          (b) => b.name === "DB" && b.type === "d1" && b.id === h.databaseId,
        ) ||
        !settings.bindings.some(
          (b) => b.name === "EPHOR_ORIGIN" && b.text === origin,
        )
      )
        throw new ProviderError("HOST_TARGET_MISMATCH");
      if (lease) {
        const rows = await this.cf<{ results: { lease: string }[] }[]>(
          h,
          `/d1/database/${h.databaseId}/query`,
          "POST",
          { sql: "SELECT lease FROM ephor_panel_release WHERE id=1" },
        );
        if (rows[0]?.results[0]?.lease !== lease)
          throw new ProviderError("HOST_TARGET_MISMATCH");
      }
    } else if (h.host === "railway") {
      await this.railway(
        h,
        "query($serviceId:String!,$environmentId:String!){serviceInstance(serviceId:$serviceId,environmentId:$environmentId){id}}",
      );
    }
  }
  async cloudflareStep(
    h: Extract<Hosting, { host: "cloudflare" }>,
    r: PanelRelease,
    job: ReleaseJob,
    save: () => Promise<void>,
  ) {
    const script = `/workers/scripts/${h.worker}`,
      db = `/d1/database/${h.databaseId}`;
    if (
      job.stage === "queued" ||
      (job.stage === "assets" &&
        (!job.upload || job.upload.expires < Date.now()))
    ) {
      const session = await this.cf<{ jwt: string; buckets: string[][] }>(
        h,
        `${script}/assets-upload-session`,
        "POST",
        {
          manifest: Object.fromEntries(
            Object.entries(r.assets).map(([p, a]) => [
              p,
              { hash: a.hash, size: a.size },
            ]),
          ),
        },
      );
      if (!session.jwt || !Array.isArray(session.buckets))
        throw new ProviderError("CLOUDFLARE_INVALID_UPLOAD");
      job.upload = {
        jwt: session.jwt,
        hashes: session.buckets.flat(),
        expires: Date.now() + 50 * 60_000,
      };
      job.stage = "assets";
      job.message = "Uploading the verified panel files.";
      await save();
      return;
    }
    if (job.stage === "assets") {
      const upload = job.upload;
      if (!upload) throw new Error("Missing upload session");
      if (upload.hashes.length) {
        // One file per request bounds isolate memory and safely resumes interrupted uploads.
        const hash = upload.hashes[0],
          asset = Object.values(r.assets).find((a) => a.hash === hash);
        if (!hash || !asset)
          throw new ProviderError("CLOUDFLARE_UNKNOWN_ASSET");
        const bytes = await this.releases.artifact(r, asset);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const form = new FormData();
        form.append(hash, new Blob([btoa(binary)], { type: asset.type }), hash);
        const result = await this.cf<{ jwt?: string }>(
          h,
          "/workers/assets/upload?base64=true",
          "POST",
          form,
          upload.jwt,
        );
        upload.hashes.shift();
        if (result.jwt) upload.jwt = result.jwt;
        await save();
        return;
      }
      if (job.routingRepair) {
        // The old updater already migrated. Retain its pre-migration recovery point.
        job.stage = "deploying";
        job.message = "Installing MCP and OAuth routing.";
        await save();
        return;
      }
      const recovery = await this.cf<{ bookmark: string }>(
        h,
        `${db}/time_travel/bookmark`,
      );
      if (!recovery.bookmark)
        throw new ProviderError("RECOVERY_POINT_UNAVAILABLE");
      job.recovery = `D1 ${h.databaseId} bookmark ${recovery.bookmark} (subject to your Cloudflare retention period).`;
      job.stage = "migrating";
      job.message = "Recovery point saved. Applying database migrations.";
      await save();
      return;
    }
    if (job.stage === "migrating") {
      await this.cf(h, `${db}/query`, "POST", {
        sql: "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
      });
      const rows = await this.cf<{ results: { name: string }[] }[]>(
        h,
        `${db}/query`,
        "POST",
        { sql: "SELECT name FROM d1_migrations ORDER BY name" },
      );
      const applied = new Set(
        rows.flatMap((row) => row.results.map((m) => m.name)),
      );
      const migration = r.migrations.find((m) => !applied.has(m.name));
      if (migration) {
        // D1 executes this batch atomically, including the migration ledger entry.
        await this.cf(h, `${db}/query`, "POST", {
          batch: [
            { sql: migration.sql },
            {
              sql: "INSERT INTO d1_migrations (name) VALUES (?)",
              params: [migration.name],
            },
          ],
        });
        await save();
        return;
      }
      job.stage = "deploying";
      job.message = "Installing the new Worker version.";
      await save();
      return;
    }
    if (job.stage === "deploying") {
      const code = await this.releases.artifact(r, r.worker);
      const settings = await this.cf<{
        bindings: { name: string; type: string }[];
        observability?: unknown;
        logpush?: boolean;
        placement?: unknown;
      }>(h, `${script}/settings`);
      const form = new FormData();
      form.append(
        "metadata",
        JSON.stringify({
          main_module: "worker.mjs",
          compatibility_date: r.compatibilityDate,
          compatibility_flags: ["nodejs_compat"],
          bindings: [
            ...settings.bindings
              .filter(
                (b) => b.type !== "assets" && b.name !== "EPHOR_PANEL_ROUTES",
              )
              .map((b) => ({ name: b.name, type: "inherit" })),
            { name: "ASSETS", type: "assets" },
            {
              name: "EPHOR_PANEL_ROUTES",
              type: "plain_text",
              text: `${CLOUDFLARE_PANEL_ROUTES_VERSION}:${r.version}`,
            },
          ],
          assets: {
            jwt: job.upload?.jwt,
            config: {
              _headers: r.headers,
              not_found_handling: "single-page-application",
              run_worker_first: [
                "/api/*",
                "/health",
                "/mcp",
                "/oauth/*",
                "/.well-known/*",
              ],
            },
          },
          observability: settings.observability,
          logpush: settings.logpush,
          placement: settings.placement,
          annotations: {
            "workers/message": `Ephor ${r.version}`,
            "workers/tag": `panel-v${r.version}`,
          },
        }),
      );
      form.append(
        "worker.mjs",
        new Blob([code], { type: "application/javascript+module" }),
        "worker.mjs",
      );
      // Persist first: deploying this script can terminate the current invocation.
      job.stage = "verifying";
      job.message = "Waiting for the updated panel to start.";
      await save();
      await this.cf(h, script, "PUT", form);
      return;
    }
  }
  async railwayDeploy(
    h: Extract<Hosting, { host: "railway" }>,
    r: PanelRelease,
    job: ReleaseJob,
    save: () => Promise<void>,
  ) {
    // The image migrates and takes a database snapshot before listening. Source repo settings are replaced.
    await this.railway(
      h,
      "mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}",
      {
        input: {
          source: { image: r.image, repo: null },
          // Railway overrides ENTRYPOINT, not just CMD. Keep volume setup,
          // privilege dropping and disabled runtime package installation.
          startCommand:
            "/usr/local/bin/ephor-entrypoint bun apps/server/dist/index.js",
          preDeployCommand: [],
          healthcheckPath: "/health",
          healthcheckTimeout: 300,
          restartPolicyType: "ON_FAILURE",
          sleepApplication: false,
        },
      },
    );
    job.stage = "verifying";
    job.message = "Railway is deploying the release and checking its health.";
    await save();
    const result = await this.railway<{ serviceInstanceDeployV2: string }>(
      h,
      "mutation($serviceId:String!,$environmentId:String!){serviceInstanceDeployV2(serviceId:$serviceId,environmentId:$environmentId)}",
    );
    job.deploymentId = result.serviceInstanceDeployV2;
    await save();
  }
}

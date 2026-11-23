import { readFile } from "node:fs/promises";
import {
  sha256,
  verifyRelease,
} from "../packages/api/src/panel/release/manifest";
import { Providers } from "../packages/api/src/panel/release/providers";
import type {
  Hosting,
  ReleaseJob,
  ReleaseState,
} from "../packages/api/src/panel/release/types";
import { ServiceSecrets } from "../packages/api/src/services/crypto";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const directory = process.argv[2];
if (!token || !accountId || !directory)
  throw new Error(
    "Supply CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and a signed release directory. This creates and deletes disposable live resources.",
  );
const p = new Providers();
const secret = `0123456789abcdef${crypto.randomUUID()}${crypto.randomUUID()}`;
const setupCode = `0123456789abcdef${crypto.randomUUID()}`;
const h: Extract<Hosting, { host: "cloudflare" }> = {
  host: "cloudflare",
  accountId,
  worker: `ephor-release-test-${Date.now()}`,
  token,
  databaseId: "",
};
const e = JSON.parse(await readFile(`${directory}/panel-release.json`, "utf8")),
  r = await verifyRelease(e);
p.releases.artifact = async (_r, a) => {
  const b = await readFile(`${directory}/${a.name}`);
  if ((await sha256(b)) !== a.sha256) throw Error("bad local artifact");
  return b;
};
try {
  const domain = await p.cf<{ subdomain: string }>(h, "/workers/subdomain");
  const origin = `https://${h.worker}.${domain.subdomain}.workers.dev`;
  const db = await p.cf<{ uuid: string }>(h, "/d1/database", "POST", {
    name: h.worker,
  });
  h.databaseId = db.uuid;
  console.info(`Disposable resources: Worker ${h.worker}, D1 ${db.uuid}`);
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: "worker.mjs",
      compatibility_date: r.compatibilityDate,
      bindings: [
        { name: "DB", type: "d1", id: db.uuid },
        { name: "EPHOR_ORIGIN", type: "plain_text", text: origin },
        {
          name: "BETTER_AUTH_SECRET",
          type: "secret_text",
          text: secret,
        },
        {
          name: "EPHOR_SETUP_CODE",
          type: "secret_text",
          text: setupCode,
        },
      ],
    }),
  );
  form.set(
    "worker.mjs",
    new Blob(
      [
        'export default {fetch(){return new Response("installing",{status:503})}}',
      ],
      { type: "application/javascript+module" },
    ),
    "worker.mjs",
  );
  await p.cf(h, `/workers/scripts/${h.worker}`, "PUT", form);
  const j: ReleaseJob = {
    id: crypto.randomUUID(),
    envelope: e,
    version: r.version,
    sequence: r.sequence,
    stage: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    message: "",
  };
  let n = 0;
  while (j.stage !== "verifying") {
    await p.cloudflareStep(h, r, j, async () => {});
    if (++n % 10 === 0)
      console.info(`Cloudflare verified step ${n}: ${j.stage}`);
  }
  await p.cf(h, `/workers/scripts/${h.worker}/subdomain`, "POST", {
    enabled: true,
    previews_enabled: false,
  });
  for (let i = 0; i < 40; i++) {
    const response = await fetch(`${origin}/health`).catch(() => null);
    if (response?.ok) {
      const body = (await response.json()) as { version: string };
      if (body.version !== r.version) throw Error("Version mismatch");
      const index = await fetch(origin);
      if (!index.ok || !index.headers.get("content-security-policy"))
        throw Error("Assets or security headers missing");
      console.info(
        "Cloudflare live test passed: signed bundle, asset upload, atomic migrations, preserved secrets, health and security headers.",
      );
      break;
    }
    if (i === 39) throw Error("Worker did not become healthy");
    await Bun.sleep(2000);
  }
  const enrollment = await fetch(`${origin}/api/setup/start`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: setupCode }),
    signal: AbortSignal.timeout(15000),
  });
  await enrollment.text();
  if (enrollment.status !== 200 || !enrollment.headers.get("set-cookie"))
    throw new Error("Cloudflare owner setup failed");
  if (process.argv.includes("--self-update")) {
    // Both versions must be published. --update-to tests a real version upgrade.
    const targetIndex = process.argv.indexOf("--update-to");
    const targetEnvelope =
      targetIndex >= 0
        ? JSON.parse(
            await readFile(
              `${process.argv[targetIndex + 1]}/panel-release.json`,
              "utf8",
            ),
          )
        : e;
    const targetRelease = await verifyRelease(targetEnvelope);
    const deployments = () =>
      p.cf<{ deployments: { id: string }[] }>(
        h,
        `/workers/scripts/${h.worker}/deployments`,
      );
    const previousDeployment = (await deployments()).deployments[0]?.id;
    const secrets = new ServiceSecrets(secret);
    const state: ReleaseState = {
      hosting: h,
      job: {
        id: crypto.randomUUID(),
        envelope: targetEnvelope,
        version: targetRelease.version,
        sequence: targetRelease.sequence,
        stage: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        message: "Approved integration test",
      },
    };
    await p.cf(h, `/d1/database/${h.databaseId}/query`, "POST", {
      sql: "UPDATE ephor_panel_release SET payload=? WHERE id=1",
      params: [await secrets.seal("panel-releases", state)],
    });
    await p.cf(h, `/workers/scripts/${h.worker}/schedules`, "PUT", [
      { cron: "* * * * *" },
    ]);
    let stage = "queued",
      complete = false;
    // New cron schedules can take up to 15 minutes to propagate.
    for (let i = 0; i < 240; i++) {
      await Bun.sleep(5000);
      const rows = await p.cf<{ results: { payload: string }[] }[]>(
        h,
        `/d1/database/${h.databaseId}/query`,
        "POST",
        { sql: "SELECT payload FROM ephor_panel_release WHERE id=1" },
      );
      const next = await secrets.open<ReleaseState>(
        "panel-releases",
        rows[0]?.results[0]?.payload ?? "",
      );
      if (next.job?.stage !== stage) {
        stage = next.job?.stage ?? "missing";
        console.info(`Worker self-update: ${stage}`);
      }
      if (stage === "failed") throw new Error(next.job?.message);
      if (stage === "complete") {
        complete = true;
        break;
      }
    }
    if (!complete)
      throw new Error("Worker self-update did not acknowledge completion");
    if ((await deployments()).deployments[0]?.id === previousDeployment)
      throw new Error("Worker acknowledged without a replacement deployment");
    const running = (await fetch(`${origin}/health`).then((response) =>
      response.json(),
    )) as { version: string };
    if (running.version !== targetRelease.version)
      throw new Error(
        "Updated Worker version does not match the approved release",
      );
    console.info(
      "Cloudflare self-update and running-version acknowledgment passed.",
    );
  }
} finally {
  const failures: string[] = [];
  for (const path of [
    `/workers/scripts/${h.worker}`,
    ...(h.databaseId ? [`/d1/database/${h.databaseId}`] : []),
  ]) {
    try {
      await p.cf(h, path, "DELETE");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "CLOUDFLARE_HTTP_404")
        failures.push(path);
    }
  }
  if (failures.length) {
    console.error(`Disposable cleanup failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else console.info("Disposable Cloudflare resources deleted.");
}

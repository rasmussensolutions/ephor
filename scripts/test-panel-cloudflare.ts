import { readFile } from "node:fs/promises";
import {
  sha256,
  verifyRelease,
} from "../packages/api/src/panel/release/manifest";
import { Providers } from "../packages/api/src/panel/release/providers";
import type {
  Hosting,
  ReleaseJob,
} from "../packages/api/src/panel/release/types";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const directory = process.argv[2];
if (!token || !accountId || !directory)
  throw new Error(
    "Supply CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and a signed release directory. This creates and deletes disposable live resources.",
  );
const p = new Providers();
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
          text: crypto.randomUUID() + crypto.randomUUID(),
        },
        {
          name: "EPHOR_SETUP_CODE",
          type: "secret_text",
          text: crypto.randomUUID() + crypto.randomUUID(),
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
} finally {
  await p
    .cf(h, `/workers/scripts/${h.worker}`, "DELETE")
    .catch((e) => console.error("Worker cleanup failed", e.message));
  if (h.databaseId)
    await p
      .cf(h, `/d1/database/${h.databaseId}`, "DELETE")
      .catch((e) => console.error("Database cleanup failed", e.message));
  console.info("Disposable Cloudflare resource cleanup finished.");
}

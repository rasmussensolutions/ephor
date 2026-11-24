import { createPrivateKey, sign } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  type Artifact,
  type PanelRelease,
  sha256,
  verifyRelease,
} from "../packages/api/src/panel/release/manifest";
import {
  PANEL_SEQUENCE,
  PANEL_VERSION,
} from "../packages/api/src/panel/release/version";

import { CADDY_IMAGE } from "./panel-vps";

const output = process.argv[2] ?? "dist/panel-release";
const image = process.env.EPHOR_PANEL_IMAGE;
if (!image)
  throw new Error(
    "EPHOR_PANEL_IMAGE must be the published OCI digest reference.",
  );
if (
  process.env.RELEASE_TAG &&
  process.env.RELEASE_TAG !== `panel-v${PANEL_VERSION}`
)
  throw new Error("Tag/version mismatch");
await mkdir(output, { recursive: true });
async function artifact(path: string, name?: string): Promise<Artifact> {
  const bytes = await readFile(path),
    hash = await sha256(bytes);
  const filename = name ?? `${hash}.asset`;
  await writeFile(join(output, filename), bytes);
  return { name: filename, sha256: hash, size: bytes.length };
}
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};
const assets: PanelRelease["assets"] = {};
async function walk(dir: string, prefix = "") {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name),
      relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(path, relative);
    else if (
      entry.isFile() &&
      !["_headers", "_redirects", ".assetsignore"].includes(entry.name)
    ) {
      const a = await artifact(path),
        bytes = await readFile(path);
      // Match Cloudflare's direct-upload content identifier (not the integrity digest).
      const hash = (
        await sha256(
          new TextEncoder().encode(
            bytes.toString("base64") + extname(path).slice(1),
          ),
        )
      ).slice(0, 32);
      assets[relative] = {
        ...a,
        hash,
        type: mime[extname(path)] ?? "application/octet-stream",
      };
    }
  }
}
await walk("apps/dashboard/dist/client");
const migrations = [];
for (const name of (await readdir("packages/api/migrations/sqlite"))
  .filter((n) => n.endsWith(".sql"))
  .sort())
  migrations.push({
    name,
    sql: await readFile(`packages/api/migrations/sqlite/${name}`, "utf8"),
  });
const release: PanelRelease = {
  format: 1,
  version: PANEL_VERSION,
  sequence: PANEL_SEQUENCE,
  minimumSequence: 0,
  image,
  worker: await artifact("apps/worker/dist/index.js", "worker.mjs"),
  installer: await artifact("dist/install.mjs", "install.mjs"),
  vps: {
    x64: await artifact(
      "dist/ephor-installer-linux-x64",
      "ephor-installer-linux-x64",
    ),
    arm64: await artifact(
      "dist/ephor-installer-linux-arm64",
      "ephor-installer-linux-arm64",
    ),
    caddyImage: CADDY_IMAGE,
  },
  assets,
  migrations,
  compatibilityDate: "2026-11-12",
  headers: await readFile("apps/dashboard/dist/client/_headers", "utf8"),
};
const pem = process.env.EPHOR_RELEASE_SIGNING_KEY_FILE
  ? await readFile(process.env.EPHOR_RELEASE_SIGNING_KEY_FILE, "utf8")
  : process.env.EPHOR_RELEASE_SIGNING_KEY;
if (!pem) throw new Error("Signing key required");
const payload = JSON.stringify(release);
const envelope = {
  payload,
  signature: sign(
    null,
    Buffer.from(`ephor:panel-release:v1\n${payload}`),
    createPrivateKey(pem),
  ).toString("hex"),
};
await verifyRelease(envelope);
await writeFile(join(output, "panel-release.json"), JSON.stringify(envelope));
console.info(
  `Verified and signed panel ${release.version}: ${Object.keys(assets).length} assets, ${migrations.length} migrations.`,
);

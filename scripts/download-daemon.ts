import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyLocalDaemon } from "./daemon-artifacts";

// Pin the immutable release manifest so template builds remain reproducible even
// after newer daemon releases are published. Update this pin with each release.
const base =
  "https://github.com/rasmussensolutions/ephor/releases/download/daemon-v0.2.2/";
const manifestHash =
  "55ea59daa8fa5dcc981c956ee3d049849a30628999977dc6b4fa67064d377118";
const directory = resolve("apps/dashboard/public/daemon");
if (process.env.EPHOR_DAEMON_LOCAL === "1") {
  const local = await verifyLocalDaemon(directory);
  console.info(`Using verified local daemon build ${local.buildId}.`);
  process.exit(0);
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function download(name: string, maximum: number) {
  const response = await fetch(new URL(name, base), {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body || !response.url.startsWith("https://"))
    throw new Error(`Could not download daemon asset ${name}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new Error(`Daemon asset too large: ${name}`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

const manifestBytes = await download("manifest.json", 16_384);
if (digest(manifestBytes) !== manifestHash)
  throw new Error("Daemon manifest does not match the pinned release");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
await mkdir(directory, { recursive: true });
const staging = resolve(directory, `.download-${crypto.randomUUID()}`);
await mkdir(staging);
try {
  for (const arch of ["x86_64", "aarch64"]) {
    const name = `ephord-linux-${arch}`;
    const bytes = await download(name, 32 * 1024 * 1024);
    if (digest(bytes) !== manifest[arch])
      throw new Error(`Daemon checksum mismatch: ${arch}`);
    await writeFile(resolve(staging, name), bytes, { mode: 0o755 });
  }
  await writeFile(resolve(staging, "manifest.json"), manifestBytes);
  for (const name of [
    "ephord-linux-x86_64",
    "ephord-linux-aarch64",
    "manifest.json",
  ])
    await rename(resolve(staging, name), resolve(directory, name));
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.info(
  `Verified and bundled Ephor daemon ${manifest.version} for x86_64 and aarch64.`,
);

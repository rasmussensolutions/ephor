import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Source builds can bundle their own workers without downloading an older release.
// Validate both architectures before allowing Vite to publish local artifacts.
export async function verifyLocalDaemon(
  directory: string,
  minimumProtocol = 6,
) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, "manifest.json"), "utf8"),
  );
  if (
    !Number.isInteger(manifest.serviceProtocol) ||
    manifest.serviceProtocol < minimumProtocol ||
    !/^[a-f0-9]{64}$/.test(manifest.buildId ?? "")
  )
    throw new Error(
      "Bundle a compatible daemon from this source before building the panel.",
    );
  for (const arch of ["x86_64", "aarch64"]) {
    const bytes = await readFile(resolve(directory, `ephord-linux-${arch}`));
    if (createHash("sha256").update(bytes).digest("hex") !== manifest[arch])
      throw new Error(`Daemon checksum mismatch: ${arch}`);
  }
  return manifest;
}

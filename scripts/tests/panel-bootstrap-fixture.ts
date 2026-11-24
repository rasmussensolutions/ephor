import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  PUBLIC_KEY,
  sha256,
  verifyRelease,
} from "../../packages/api/src/panel/release/manifest";
import { PANEL_VERSION } from "../../packages/api/src/panel/release/version";
import { CADDY_IMAGE, command } from "../panel-vps";

export async function testBootstrap() {
  const binary = new Uint8Array(await readFile("/root/ephor-installer"));
  const release = await verifyRelease(
    JSON.parse(await readFile("/root/release.json", "utf8")),
  );
  const a = { size: binary.length, sha256: await sha256(binary) };
  release.vps = {
    x64: { ...a, name: "ephor-installer-linux-x64" },
    arm64: { ...a, name: "ephor-installer-linux-arm64" },
    caddyImage: CADDY_IMAGE,
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  ).toString("hex");
  const payload = JSON.stringify(release);
  const envelope = {
    payload,
    signature: sign(
      null,
      Buffer.from(`ephor:panel-release:v1\n${payload}`),
      privateKey,
    ).toString("hex"),
  };
  // Only this disposable test copy trusts the ephemeral test signer.
  await writeFile(
    "/root/bootstrap-test.sh",
    (await readFile("/root/install.sh", "utf8")).replaceAll(PUBLIC_KEY, key),
  );
  await writeFile("/root/bootstrap-release.json", JSON.stringify(envelope));
  await writeFile("/root/bootstrap-artifact", binary);
  await mkdir("/root/test-bin", { recursive: true });
  await writeFile(
    "/root/test-bin/curl",
    `#!/bin/sh
set -eu
out= url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out=$1 ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  https://raw.githubusercontent.com/rasmussensolutions/ephor/panel-channel/panel-release.json) cp /root/bootstrap-release.json "$out" ;;
  https://github.com/rasmussensolutions/ephor/releases/download/panel-v*/ephor-installer-linux-*) cp /root/bootstrap-artifact "$out" ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o700 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `/root/test-bin:${originalPath}`;
  try {
    assert.equal(
      await command(
        "sh",
        ["/root/bootstrap-test.sh", "vps", "--version"],
        true,
        "/root",
      ),
      PANEL_VERSION,
    );
    await writeFile(
      "/root/bootstrap-release.json",
      JSON.stringify({ ...envelope, payload: `${payload} ` }),
    );
    await assert.rejects(
      command(
        "sh",
        ["/root/bootstrap-test.sh", "vps", "--version"],
        true,
        "/root",
      ),
    );
    await writeFile("/root/bootstrap-release.json", JSON.stringify(envelope));
    binary[0] = (binary[0] ?? 0) ^ 1;
    await writeFile("/root/bootstrap-artifact", binary);
    await assert.rejects(
      command(
        "sh",
        ["/root/bootstrap-test.sh", "vps", "--version"],
        true,
        "/root",
      ),
    );
  } finally {
    process.env.PATH = originalPath;
  }
  console.info(
    "Shell bootstrap passed: real OpenSSL verification, native execution without a terminal, tampered signature and artifact rejection.",
  );
}
if (import.meta.main) await testBootstrap();

import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyRelease } from "../src/machines/releases";

test("release assembly and signing validate architectures, checksums and tag before publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ephor-release-preflight-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  ).toString("hex");
  const metadata = {
    version: "0.2.1",
    buildId: "a".repeat(64),
    updaterProtocol: 3,
    serviceProtocol: 6,
    securityProtocol: 1,
    protectionProtocol: 1,
    managedUpdatesProtocol: 2,
  };
  const bundle = join(dir, "bundle");
  const run = async (
    script: string,
    args: string[],
    tag = "daemon-v0.2.1",
    expectedKey = key,
  ) => {
    const child = Bun.spawn(["bun", resolve("scripts", script), ...args], {
      env: {
        ...process.env,
        RELEASE_TAG: tag,
        EPHOR_RELEASE_PUBLIC_KEY: expectedKey,
        EPHOR_RELEASE_SIGNING_KEY_FILE: join(dir, "key.pem"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: out + err };
  };
  try {
    await writeFile(
      join(dir, "key.pem"),
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    for (const arch of ["x86_64", "aarch64"]) {
      const path = join(dir, `daemon-${arch}`);
      await mkdir(path);
      const bytes = Buffer.from(`fixture-${arch}`);
      await writeFile(join(path, `ephord-linux-${arch}`), bytes);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          ...metadata,
          [arch]: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    }
    expect((await run("merge-daemon-artifacts.ts", [dir, bundle])).code).toBe(
      0,
    );
    const sign: [string, string, string] = [
      bundle,
      "https://example.com/daemon/0.2.1/",
      join(dir, "release.json"),
    ];
    expect(
      (await run("release-daemon.ts", ["sign", ...sign], "daemon-v0.2.0"))
        .output,
    ).toContain("Release tag must match");
    expect(
      (
        await run(
          "release-daemon.ts",
          ["sign", ...sign],
          "daemon-v0.2.1",
          "0".repeat(64),
        )
      ).output,
    ).toContain("Signing key does not match");
    expect((await run("release-daemon.ts", ["sign", ...sign])).code).toBe(0);
    const { release } = await verifyRelease(
      JSON.parse(await readFile(sign[2], "utf8")),
      key,
    );
    expect(release.updaterProtocol).toBe(3);
    expect(Object.keys(release.artifacts).sort()).toEqual([
      "aarch64",
      "x86_64",
    ]);
    expect((await run("release-daemon.ts", ["sign", ...sign])).code).not.toBe(
      0,
    );
    await writeFile(join(bundle, "ephord-linux-x86_64"), "tampered");
    expect(
      (
        await run("release-daemon.ts", [
          "sign",
          bundle,
          sign[1],
          join(dir, "bad.json"),
        ])
      ).output,
    ).toContain("Bundled checksum mismatch");
    const arm = join(dir, "daemon-aarch64", "manifest.json");
    const manifest = JSON.parse(await readFile(arm, "utf8"));
    await writeFile(arm, JSON.stringify({ ...manifest, updaterProtocol: 2 }));
    expect(
      (await run("merge-daemon-artifacts.ts", [dir, join(dir, "mismatch")]))
        .output,
    ).toContain("identical source inputs");
    await writeFile(arm, JSON.stringify(manifest));
    await writeFile(
      join(dir, "daemon-aarch64", "ephord-linux-aarch64"),
      "tampered",
    );
    expect(
      (await run("merge-daemon-artifacts.ts", [dir, join(dir, "corrupt")]))
        .output,
    ).toContain("Invalid artifact checksum");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

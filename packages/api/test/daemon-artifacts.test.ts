import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLocalDaemon } from "../../../scripts/daemon-artifacts";

test("local release requires compatible protocol and both verified architectures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ephor-artifacts-"));
  const binary = Buffer.from("fixture");
  const hash = createHash("sha256").update(binary).digest("hex");
  const manifest = {
    buildId: hash,
    serviceProtocol: 6,
    updaterProtocol: 3,
    x86_64: hash,
    aarch64: hash,
  };
  const save = () =>
    writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  try {
    await save();
    await writeFile(join(directory, "ephord-linux-x86_64"), binary);
    await expect(verifyLocalDaemon(directory)).rejects.toThrow();
    await writeFile(join(directory, "ephord-linux-aarch64"), binary);
    expect((await verifyLocalDaemon(directory)).serviceProtocol).toBe(6);
    manifest.serviceProtocol = 5;
    await save();
    await expect(verifyLocalDaemon(directory)).rejects.toThrow(
      "compatible daemon",
    );
    manifest.serviceProtocol = 6;
    manifest.updaterProtocol = 2;
    await save();
    await expect(verifyLocalDaemon(directory)).rejects.toThrow(
      "compatible daemon",
    );
    manifest.updaterProtocol = 3;
    await save();
    await writeFile(join(directory, "ephord-linux-aarch64"), "tampered");
    await expect(verifyLocalDaemon(directory)).rejects.toThrow(
      "checksum mismatch",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

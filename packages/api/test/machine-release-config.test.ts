import { expect, test } from "bun:test";
import { machineReleaseConfig } from "../src/machines/release-config";
import { OFFICIAL, PUBLIC_KEY } from "../src/panel/release/manifest";

test("official installations enable machine releases without manual hosting variables", () => {
  expect(machineReleaseConfig(undefined, undefined, true)).toEqual({
    releaseUrl: `https://github.com/${OFFICIAL}/releases/latest/download/release.json`,
    releasePublicKey: PUBLIC_KEY,
  });
  expect(machineReleaseConfig(undefined, undefined, false)).toEqual({
    releaseUrl: undefined,
    releasePublicKey: undefined,
  });
});
test("custom signing trust is never mixed with official defaults", () => {
  const url = "https://releases.example.com/daemon.json",
    key = "a".repeat(64);
  for (const [releaseUrl, releasePublicKey] of [
    [url, key],
    [url, undefined],
    [undefined, key],
    ["", ""],
  ] as const) {
    expect(machineReleaseConfig(releaseUrl, releasePublicKey, true)).toEqual({
      releaseUrl,
      releasePublicKey,
    });
  }
});

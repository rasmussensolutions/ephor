import { OFFICIAL, PUBLIC_KEY } from "../panel/release/manifest";

// Official installations work without provider-specific release variables. An
// explicit override is an indivisible pair: never silently mix trust roots.
export function machineReleaseConfig(
  releaseUrl: string | undefined,
  releasePublicKey: string | undefined,
  officialDefaults: boolean,
) {
  if (
    officialDefaults &&
    releaseUrl === undefined &&
    releasePublicKey === undefined
  )
    return {
      releaseUrl: `https://github.com/${OFFICIAL}/releases/latest/download/release.json`,
      releasePublicKey: PUBLIC_KEY,
    };
  return { releaseUrl, releasePublicKey };
}

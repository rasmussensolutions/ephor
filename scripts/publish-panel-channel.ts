import { readFile } from "node:fs/promises";
import {
  OFFICIAL,
  RELEASES,
  ReleaseSource,
  verifyRelease,
} from "../packages/api/src/panel/release/manifest";

const directory = process.argv[2] ?? "dist/panel-release";
const token = process.env.GH_TOKEN,
  commit = process.env.GITHUB_SHA;
if (!token || !commit || !/^[a-f0-9]{40}$/.test(commit))
  throw new Error("Publisher credentials and source commit are required");
const manifest = await readFile(`${directory}/panel-release.json`, "utf8"),
  envelope = JSON.parse(manifest),
  release = await verifyRelease(envelope);
const published = JSON.parse(
  new TextDecoder().decode(
    await new ReleaseSource().download(
      `${RELEASES}panel-v${release.version}/panel-release.json`,
      2_100_000,
    ),
  ),
);
if (
  published.payload !== envelope.payload ||
  published.signature !== envelope.signature
)
  throw new Error(
    "Published immutable release differs from the channel candidate",
  );
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  missing = false,
) {
  const response = await fetch(
    `https://api.github.com/repos/${OFFICIAL}${path}`,
    {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "Ephor release publisher",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (missing && response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(`Channel publication failed (${response.status})`);
  return response.json();
}
const ref = await api("/git/ref/heads/panel-channel", "GET", undefined, true);
if (ref) {
  const current = await api("/contents/panel-release.json?ref=panel-channel");
  const previous = await verifyRelease(
    JSON.parse(Buffer.from(current.content, "base64").toString()),
  );
  if (previous.sequence > release.sequence)
    throw new Error("Refusing to roll back the published channel");
}
const files = {
  "panel-release.json": manifest,
  "install.sh": await readFile("deploy/panel/install.sh", "utf8"),
};
const tree = [];
for (const [path, content] of Object.entries(files)) {
  const blob = await api("/git/blobs", "POST", {
    content: Buffer.from(content).toString("base64"),
    encoding: "base64",
  });
  tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
}
const root = await api("/git/trees", "POST", { tree });
const next = await api("/git/commits", "POST", {
  message: `Publish panel ${release.version}`,
  tree: root.sha,
  parents: [ref?.object.sha ?? commit],
});
if (ref)
  await api("/git/refs/heads/panel-channel", "PATCH", {
    sha: next.sha,
    force: false,
  });
else
  await api("/git/refs", "POST", {
    ref: "refs/heads/panel-channel",
    sha: next.sha,
  });
console.info(
  `Published signed panel channel ${release.version}. Versioned release assets remain immutable.`,
);

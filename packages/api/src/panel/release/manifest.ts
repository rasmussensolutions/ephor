export const OFFICIAL = "rasmussensolutions/ephor";
export const PUBLIC_KEY =
  "69fcf97385688a836880535bad05d49fcf2b4a09bd54315546c458efe3d53b2b";
export const RELEASES = `https://github.com/${OFFICIAL}/releases/download/`;
export interface Artifact {
  name: string;
  sha256: string;
  size: number;
}
export interface PanelRelease {
  format: 1;
  version: string;
  sequence: number;
  minimumSequence: number;
  image: string;
  worker: Artifact;
  installer: Artifact;
  assets: Record<string, Artifact & { hash: string; type: string }>;
  migrations: { name: string; sql: string }[];
  compatibilityDate: string;
  headers: string;
}
export interface SignedRelease {
  payload: string;
  signature: string;
}
const encoder = new TextEncoder();
export function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function sha256(bytes: Uint8Array) {
  return hex(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
}
export function unhex(s: string) {
  return Uint8Array.from(s.match(/../g) ?? [], (s) => Number.parseInt(s, 16));
}
export async function bounded(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !response.ok ||
    Number(response.headers.get("content-length") ?? 0) > limit
  )
    throw new Error("Release download failed");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty release response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Release exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
export async function verifyRelease(
  envelope: SignedRelease,
  publicKey = PUBLIC_KEY,
): Promise<PanelRelease> {
  if (
    !envelope ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length > 2_000_000 ||
    !/^[a-f0-9]{128}$/.test(envelope.signature)
  )
    throw new Error("Invalid release signature");
  const key = await crypto.subtle.importKey(
    "raw",
    unhex(publicKey),
    "Ed25519",
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      unhex(envelope.signature),
      encoder.encode(`ephor:panel-release:v1\n${envelope.payload}`),
    ))
  )
    throw new Error("Untrusted panel release");
  const r = JSON.parse(envelope.payload) as PanelRelease;
  if (
    r.format !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(r.version) ||
    !Number.isSafeInteger(r.sequence) ||
    r.sequence < 1 ||
    !Number.isSafeInteger(r.minimumSequence) ||
    r.minimumSequence < 0 ||
    r.minimumSequence >= r.sequence ||
    !/^ghcr\.io\/rasmussensolutions\/ephor-panel@sha256:[a-f0-9]{64}$/.test(
      r.image,
    ) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(r.compatibilityDate)
  )
    throw new Error("Invalid panel release");
  const artifact = (a: Artifact) => {
    if (
      !a ||
      !/^[a-zA-Z0-9_.-]{1,160}$/.test(a.name) ||
      a.name.includes("..") ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !Number.isSafeInteger(a.size) ||
      a.size < 1 ||
      a.size > 25 * 1024 * 1024
    )
      throw new Error("Invalid release artifact");
  };
  if (typeof r.headers !== "string" || r.headers.length > 100_000)
    throw new Error("Invalid asset headers");
  artifact(r.worker);
  artifact(r.installer);
  if (
    !r.assets ||
    Object.keys(r.assets).length > 500 ||
    !Array.isArray(r.migrations) ||
    r.migrations.length > 200
  )
    throw new Error("Invalid release contents");
  for (const [path, a] of Object.entries(r.assets)) {
    artifact(a);
    if (
      !path.startsWith("/") ||
      path.includes("..") ||
      path.includes("\\") ||
      [...path].some((c) => c.charCodeAt(0) <= 32) ||
      !/^[a-f0-9]{32}$/.test(a.hash) ||
      !/^[a-zA-Z0-9+./;-]+$/.test(a.type)
    )
      throw new Error("Invalid release asset");
  }
  let previous = "";
  for (const m of r.migrations) {
    if (
      !/^\d{4}_[a-z0-9_]+\.sql$/.test(m.name) ||
      m.name <= previous ||
      typeof m.sql !== "string" ||
      m.sql.length > 100_000
    )
      throw new Error("Invalid release migration");
    previous = m.name;
  }
  return r;
}
export class ReleaseSource {
  readonly request: typeof fetch;
  constructor(request: typeof fetch = fetch) {
    this.request = request.bind(globalThis);
  }
  // Release assets use GitHub's signed CDN redirects. Never attach provider credentials.
  async download(url: string, limit: number) {
    for (let i = 0; i < 5; i++) {
      const u = new URL(url);
      if (
        u.protocol !== "https:" ||
        ![
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
          "raw.githubusercontent.com",
        ].includes(u.hostname) ||
        u.username ||
        u.password
      )
        throw new Error("Untrusted release redirect");
      const response = await this.request(u, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: { "User-Agent": "Ephor" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        url = new URL(response.headers.get("location") ?? "", u).href;
        continue;
      }
      return bounded(response, limit);
    }
    throw new Error("Too many release redirects");
  }
  async latest(): Promise<SignedRelease> {
    // A signed branch pointer works with immutable releases and independent daemon releases.
    const envelope = JSON.parse(
      new TextDecoder().decode(
        await this.download(
          `https://raw.githubusercontent.com/${OFFICIAL}/panel-channel/panel-release.json`,
          2_100_000,
        ),
      ),
    );
    await verifyRelease(envelope);
    return envelope;
  }
  async artifact(r: PanelRelease, artifact: Artifact) {
    const bytes = await this.download(
      `${RELEASES}panel-v${r.version}/${artifact.name}`,
      artifact.size,
    );
    if (
      bytes.length !== artifact.size ||
      (await sha256(bytes)) !== artifact.sha256
    )
      throw new Error("Release checksum mismatch");
    return bytes;
  }
}

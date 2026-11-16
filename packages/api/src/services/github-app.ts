import { importPKCS8, SignJWT } from "jose";
import {
  AuthError,
  AuthStore,
  hash,
  randomToken,
  type Sql,
} from "../auth/store";
import { ServiceSecrets } from "./crypto";
import { buildSettings, object, type ServiceSource } from "./spec";
import { detectTechnology } from "./technology";

interface AppConfig {
  id: number;
  slug: string;
  pem: string;
  webhookSecret: string;
}
interface Repository {
  id: number;
  full_name: string;
  owner: { id: number };
  default_branch: string;
  private: boolean;
  archived: boolean;
}
const encoder = new TextEncoder();
export class Integrations {
  readonly secrets: ServiceSecrets;
  constructor(
    readonly sql: Sql,
    secret: string,
  ) {
    this.secrets = new ServiceSecrets(secret);
  }
  async get<T>(id: string): Promise<T | null> {
    const [row] = await this.sql.query<{ config: string }>(
      "SELECT config FROM ephor_integration WHERE id=$1",
      [id],
    );
    return row ? this.secrets.open<T>(`integration:${id}`, row.config) : null;
  }
  async set(id: string, config: unknown) {
    await this.sql.query(
      "INSERT INTO ephor_integration (id,config) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET config=$2",
      [id, await this.secrets.seal(`integration:${id}`, config)],
    );
  }
}
// GitHub returns PKCS#1 PEM; WebCrypto imports PKCS#8. Wrap DER without a Node dependency.
function privateKey(pem: string) {
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return pem;
  const rsa = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----|\s/g, "")),
    (c) => c.charCodeAt(0),
  );
  const length = (n: number) =>
    n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  const body = [
    2,
    1,
    0,
    48,
    13,
    6,
    9,
    42,
    134,
    72,
    134,
    247,
    13,
    1,
    1,
    1,
    5,
    0,
    4,
    ...length(rsa.length),
    ...rsa,
  ];
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(48, ...length(body.length), ...body))}\n-----END PRIVATE KEY-----`;
}
export class GitHubApp {
  readonly integrations: Integrations;
  constructor(
    readonly sql: Sql,
    secret: string,
    readonly origin: string,
    readonly request: typeof fetch = fetch,
  ) {
    this.integrations = new Integrations(sql, secret);
  }
  async api<T>(path: string, token?: string, body?: unknown): Promise<T> {
    const response = await this.request(`https://api.github.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Ephor",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new AuthError(
        response.status === 429 || response.status === 403
          ? "GITHUB_ACCESS_OR_RATE_LIMIT"
          : "GITHUB_REPOSITORY_UNAVAILABLE",
        400,
      );
    return response.json() as Promise<T>;
  }
  async config() {
    const config = await this.integrations.get<AppConfig>("github");
    if (!config) throw new AuthError("GITHUB_NOT_CONNECTED", 409);
    return config;
  }
  async jwt() {
    const app = await this.config();
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(String(app.id))
      .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
      .setExpirationTime("5m")
      .sign(await importPKCS8(privateKey(app.pem), "RS256"));
  }
  async status() {
    const app = await this.integrations.get<AppConfig>("github");
    return {
      configured: !!app,
      slug: app?.slug,
      installations: await this.sql.query<{ id: string; account: string }>(
        "SELECT id,account FROM ephor_github_installation ORDER BY account",
      ),
    };
  }
  async state(kind: string) {
    await this.sql.query("DELETE FROM ephor_github_state WHERE expires < $1", [
      Date.now(),
    ]);
    const state = randomToken(),
      { state: auth } = await new AuthStore(this.sql).read();
    await this.sql.query(
      "INSERT INTO ephor_github_state (digest,kind,epoch,expires) VALUES ($1,$2,$3,$4)",
      [await hash(state), kind, auth.epoch, Date.now() + 600000],
    );
    return state;
  }
  async consume(state: unknown, kind: string) {
    if (typeof state !== "string" || !/^[a-f0-9]{64}$/.test(state))
      throw new AuthError("GITHUB_STATE_EXPIRED", 403);
    const { state: auth } = await new AuthStore(this.sql).read();
    const rows = await this.sql.query(
      "DELETE FROM ephor_github_state WHERE digest=$1 AND kind=$2 AND epoch=$3 AND expires>$4 RETURNING digest",
      [await hash(state), kind, auth.epoch, Date.now()],
    );
    if (!rows.length) throw new AuthError("GITHUB_STATE_EXPIRED", 403);
  }
  async start() {
    if (!this.origin.startsWith("https://"))
      throw new AuthError("HTTPS_REQUIRED", 409);
    const existing = await this.integrations.get<AppConfig>("github");
    const state = await this.state(existing ? "install" : "register");
    if (existing)
      return {
        url: `https://github.com/apps/${existing.slug}/installations/new?state=${state}`,
        state,
      };
    return {
      url: `https://github.com/settings/apps/new?state=${state}`,
      state,
      manifest: {
        name: `Ephor-${crypto.randomUUID().slice(0, 8)}`,
        url: this.origin,
        redirect_url: `${this.origin}/settings/integrations?github=register`,
        setup_url: `${this.origin}/settings/integrations?github=install`,
        public: true,
        hook_attributes: {
          url: `${this.origin}/api/integrations/github/webhook`,
          active: true,
        },
        default_permissions: { contents: "read", metadata: "read" },
        default_events: ["push"],
        setup_on_update: true,
      },
    };
  }
  async finish(body: unknown) {
    const b = object(body);
    if (b.kind === "register") {
      await this.consume(b.state, "register");
      if (await this.integrations.get("github"))
        throw new AuthError("GITHUB_ALREADY_CONFIGURED", 409);
      if (typeof b.code !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(b.code))
        throw new AuthError("INVALID_GITHUB_CODE");
      const app = await this.api<{
        id: number;
        slug: string;
        pem: string;
        webhook_secret: string;
      }>(`/app-manifests/${b.code}/conversions`, undefined, {});
      if (
        !Number.isSafeInteger(app.id) ||
        !/^[a-z0-9-]+$/.test(app.slug) ||
        typeof app.pem !== "string" ||
        app.pem.length > 16000 ||
        !app.webhook_secret
      )
        throw new AuthError("INVALID_GITHUB_APP");
      await this.integrations.set("github", {
        id: app.id,
        slug: app.slug,
        pem: app.pem,
        webhookSecret: app.webhook_secret,
      });
      await new AuthStore(this.sql).audit(
        "github.app_registered",
        String(app.id),
      );
      return this.start();
    }
    await this.consume(b.state, "install");
    const id = numericId(b.installationId);
    const installation = await this.api<{
      app_id: number;
      suspended_at: string | null;
      account: { login: string };
    }>(`/app/installations/${id}`, await this.jwt());
    if (
      installation.app_id !== (await this.config()).id ||
      installation.suspended_at
    )
      throw new AuthError("GITHUB_INSTALLATION_UNAVAILABLE");
    await this.sql.query(
      "INSERT INTO ephor_github_installation (id,account) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET account=$2",
      [id, installation.account.login],
    );
    await new AuthStore(this.sql).audit("github.installation_connected", id);
    return { connected: true };
  }
  async token(installationId: string, repositoryId?: string) {
    const id = numericId(installationId);
    if (
      !(
        await this.sql.query(
          "SELECT id FROM ephor_github_installation WHERE id=$1",
          [id],
        )
      ).length
    )
      throw new AuthError("GITHUB_INSTALLATION_UNAVAILABLE", 403);
    const result = await this.api<{ token: string }>(
      `/app/installations/${id}/access_tokens`,
      await this.jwt(),
      {
        permissions: { contents: "read", metadata: "read" },
        ...(repositoryId
          ? { repository_ids: [Number(numericId(repositoryId))] }
          : {}),
      },
    );
    return result.token;
  }
  async repositories(installationId: string, page: number) {
    const token = await this.token(installationId);
    const result = await this.api<{
      repositories: Repository[];
      total_count: number;
    }>(`/installation/repositories?per_page=100&page=${page}`, token);
    return {
      repositories: result.repositories
        .filter((r) => !r.archived)
        .map((r) => ({
          id: String(r.id),
          name: r.full_name,
          branch: r.default_branch,
          private: r.private,
        })),
      more: page * 100 < result.total_count,
    };
  }
  async repository(installationId: string, repositoryId: string) {
    const token = await this.token(installationId, repositoryId);
    const repo = await this.api<Repository>(
      `/repositories/${numericId(repositoryId)}`,
      token,
    );
    if (String(repo.id) !== repositoryId || repo.archived)
      throw new AuthError("GITHUB_REPOSITORY_UNAVAILABLE");
    return { repo, token };
  }
  async branches(installationId: string, repositoryId: string, page: number) {
    const { repo, token } = await this.repository(installationId, repositoryId);
    const branches = await this.api<{ name: string }[]>(
      `/repos/${repo.full_name}/branches?per_page=100&page=${page}`,
      token,
    );
    return {
      branches: branches.map((b) => b.name),
      more: branches.length === 100,
    };
  }
  async source(value: unknown): Promise<ServiceSource> {
    const b = object(value);
    if (b.type === "image") return { type: "image" };
    if (b.type !== "github") throw new AuthError("INVALID_REPOSITORY");
    const installationId = numericId(b.installationId),
      repositoryId = numericId(b.repositoryId);
    const { repo, token } = await this.repository(installationId, repositoryId);
    const branch = String(b.branch || repo.default_branch);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(branch) ||
      branch.includes("..") ||
      branch.endsWith("/") ||
      branch.endsWith(".lock")
    )
      throw new AuthError("INVALID_REPOSITORY");
    const source: ServiceSource = {
      type: "github",
      installationId,
      repositoryId,
      repository: repo.full_name,
      ownerId: String(repo.owner.id),
      branch,
      ...buildSettings(b),
    };
    const sha = await this.branchHead(repo.full_name, branch, token);
    source.technology = await this.technology(source, sha, token);
    return source;
  }
  async technology(source: ServiceSource, sha: string, token: string) {
    const [owner, repo] = (source.repository ?? "").split("/");
    if (!owner || !repo || !/^[a-f0-9]{40}$/.test(sha)) return undefined;
    const context = (source.context ?? ".")
      .split("/")
      .filter((part) => part && part !== ".");
    if (context.includes("..")) return undefined;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
    const signal = AbortSignal.timeout(2500);
    const read = async (parts: string[], limit: number, accept: string) => {
      const path = parts.length
        ? `/${parts.map(encodeURIComponent).join("/")}`
        : "";
      const response = await this.request(
        `https://api.github.com${base}${path}?ref=${sha}`,
        {
          redirect: "error",
          signal,
          headers: {
            Accept: accept,
            Authorization: `Bearer ${token}`,
            "User-Agent": "Ephor",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get("content-length")) > limit
      ) {
        await response.body?.cancel();
        throw new Error("Repository metadata unavailable");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let text = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return text + decoder.decode();
          size += value.byteLength;
          if (size > limit) throw new Error("Repository metadata too large");
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        await reader.cancel();
      }
    };
    try {
      const directory = await read(
        context,
        1024 * 1024,
        "application/vnd.github+json",
      );
      if (!directory) return null;
      const entries: unknown = JSON.parse(directory);
      if (!Array.isArray(entries)) return null;
      const names = new Set<string>();
      for (const entry of entries)
        if (entry?.type === "file" && typeof entry.name === "string")
          names.add(entry.name);
      return await detectTechnology(names, (name) =>
        read([...context, name], 64 * 1024, "application/vnd.github.raw+json"),
      );
    } catch {
      // Detection is optional. A slow GitHub response must not fail a build.
      return undefined;
    }
  }
  async head(source: ServiceSource) {
    const { repo, token } = await this.repository(
      source.installationId ?? "",
      source.repositoryId ?? "",
    );
    if (
      String(repo.owner.id) !== source.ownerId ||
      repo.full_name !== source.repository
    )
      throw new AuthError("GITHUB_REPOSITORY_IDENTITY_CHANGED", 409);
    return this.branchHead(repo.full_name, source.branch ?? "", token);
  }
  private async branchHead(repository: string, branch: string, token: string) {
    const ref = await this.api<{ commit: { sha: string } }>(
      `/repos/${repository}/branches/${encodeURIComponent(branch)}`,
      token,
    );
    if (!/^[a-f0-9]{40}$/.test(ref.commit.sha))
      throw new AuthError("INVALID_GITHUB_COMMIT");
    return ref.commit.sha;
  }
  async verifyWebhook(raw: string, signature: string) {
    if (!/^sha256=[a-f0-9]{64}$/.test(signature))
      throw new AuthError("INVALID_WEBHOOK", 401);
    const secret = (await this.config()).webhookSecret;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const bytes = Uint8Array.from(signature.slice(7).match(/../g) ?? [], (b) =>
      parseInt(b, 16),
    );
    if (!(await crypto.subtle.verify("HMAC", key, bytes, encoder.encode(raw))))
      throw new AuthError("INVALID_WEBHOOK", 401);
  }
  async disconnect() {
    await this.sql.query("DELETE FROM ephor_github_installation");
    await this.sql.query("DELETE FROM ephor_integration WHERE id='github'");
    await this.sql.query("DELETE FROM ephor_github_state");
    await this.sql.query(
      "UPDATE ephor_build SET status='cancelled',updated_at=$1 WHERE status IN ('queued','running','built')",
      [Date.now()],
    );
    await new AuthStore(this.sql).audit("github.disconnected");
  }
}
export function numericId(value: unknown) {
  const id = String(value ?? "");
  if (!/^[1-9][0-9]{0,14}$/.test(id)) throw new AuthError("INVALID_GITHUB_ID");
  return id;
}

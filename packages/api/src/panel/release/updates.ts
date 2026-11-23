import type { AuthEnvironment } from "../../auth/config";
import { AuthError } from "../../auth/store";
import { ServiceSecrets } from "../../services/crypto";
import { object } from "../../services/spec";
import { OFFICIAL, ReleaseSource, verifyRelease } from "./manifest";
import { ProviderError, Providers } from "./providers";
import type { Hosting, ReleaseState, ReleaseStatus } from "./types";
import { PANEL_SEQUENCE, PANEL_VERSION } from "./version";

const active = (state: ReleaseState) =>
  state.job && !["failed", "complete"].includes(state.job.stage);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class PanelReleases {
  readonly secrets: ServiceSecrets;
  readonly source: ReleaseSource;
  readonly providers: Providers;
  constructor(
    readonly env: AuthEnvironment,
    request: typeof fetch = fetch,
    readonly running = { version: PANEL_VERSION, sequence: PANEL_SEQUENCE },
    readonly verify = verifyRelease,
  ) {
    this.secrets = new ServiceSecrets(env.secret);
    this.source = new ReleaseSource(request);
    this.providers = new Providers(request);
  }
  async state(): Promise<ReleaseState> {
    const [row] = await this.env.sql.query<{ payload: string | null }>(
      "SELECT payload FROM ephor_panel_release WHERE id=1",
    );
    if (!row) throw new Error("Panel release migration missing");
    return row.payload ? this.secrets.open("panel-releases", row.payload) : {};
  }
  async change<T>(
    fn: (
      state: ReleaseState,
      save: () => Promise<void>,
      lease: string,
    ) => Promise<T>,
  ) {
    const lease = crypto.randomUUID(),
      now = Date.now();
    const rows = await this.env.sql.query(
      "UPDATE ephor_panel_release SET lease=$1,lease_until=$2 WHERE id=1 AND lease_until<$3 RETURNING id",
      [lease, now + 180_000, now],
    );
    if (!rows.length) throw new AuthError("PANEL_UPDATE_BUSY", 409);
    try {
      const state = await this.state();
      const save = async () => {
        if (state.job) state.job.updatedAt = Date.now();
        const rows = await this.env.sql.query(
          "UPDATE ephor_panel_release SET payload=$1,lease_until=$2 WHERE id=1 AND lease=$3 AND lease_until>$4 RETURNING id",
          [
            await this.secrets.seal("panel-releases", state),
            Date.now() + 180_000,
            lease,
            Date.now(),
          ],
        );
        if (!rows.length) throw new AuthError("PANEL_UPDATE_BUSY", 409);
      };
      return await fn(state, save, lease);
    } finally {
      await this.env.sql.query(
        "UPDATE ephor_panel_release SET lease=NULL,lease_until=0 WHERE id=1 AND lease=$1",
        [lease],
      );
    }
  }
  async status(): Promise<ReleaseStatus> {
    const s = await this.state(),
      r = s.latest ? await this.verify(s.latest) : undefined;
    const h = s.hosting;
    return {
      running: this.running.version,
      detectedHost:
        this.env.deployment?.runtime === "cloudflare-worker"
          ? "cloudflare"
          : this.env.deployment?.host === "railway"
            ? "railway"
            : this.env.panelUpdaterToken
              ? "docker"
              : "unknown",
      hosting:
        h?.host === "cloudflare"
          ? {
              host: h.host,
              accountId: h.accountId,
              worker: h.worker,
              databaseId: h.databaseId,
            }
          : h?.host === "railway"
            ? {
                host: h.host,
                serviceId: h.serviceId,
                environmentId: h.environmentId,
              }
            : h,
      latest: r && {
        version: r.version,
        sequence: r.sequence,
        notes: `https://github.com/${OFFICIAL}/releases/tag/panel-v${r.version}`,
        compatible:
          r.minimumSequence <= this.running.sequence &&
          r.sequence > this.running.sequence,
      },
      checkedAt: s.checkedAt,
      updaterSeen: s.updaterSeen,
      job: s.job && {
        id: s.job.id,
        version: s.job.version,
        stage: s.job.stage,
        createdAt: s.job.createdAt,
        updatedAt: s.job.updatedAt,
        message: s.job.message,
        recovery: s.job.recovery,
      },
    };
  }
  async configure(input: unknown) {
    const x = object(input);
    let h: Hosting;
    if (x.host === "docker") {
      if (!this.env.panelUpdaterToken)
        throw new AuthError("PANEL_UPDATER_REQUIRED", 409);
      h = { host: "docker" };
    } else {
      if (
        typeof x.token !== "string" ||
        x.token.length < 20 ||
        x.token.length > 512 ||
        /\s/.test(x.token)
      )
        throw new AuthError("PANEL_INVALID_HOST");
      if (
        x.host === "cloudflare" &&
        typeof x.accountId === "string" &&
        /^[a-f0-9]{32}$/.test(x.accountId) &&
        typeof x.worker === "string" &&
        /^[a-z0-9][a-z0-9_-]{0,62}$/.test(x.worker) &&
        typeof x.databaseId === "string" &&
        uuid.test(x.databaseId) &&
        this.env.deployment?.runtime === "cloudflare-worker"
      )
        h = {
          host: x.host,
          token: x.token,
          accountId: x.accountId,
          worker: x.worker,
          databaseId: x.databaseId,
        };
      else if (
        x.host === "railway" &&
        typeof x.serviceId === "string" &&
        uuid.test(x.serviceId) &&
        typeof x.environmentId === "string" &&
        uuid.test(x.environmentId) &&
        x.serviceId === this.env.railwayServiceId &&
        x.environmentId === this.env.railwayEnvironmentId
      )
        h = {
          host: x.host,
          token: x.token,
          serviceId: x.serviceId,
          environmentId: x.environmentId,
        };
      else throw new AuthError("PANEL_INVALID_HOST");
    }
    await this.change(async (s, save, lease) => {
      if (active(s)) throw new AuthError("PANEL_UPDATE_BUSY", 409);
      try {
        await this.providers.validate(h, this.env.origin, lease);
      } catch {
        throw new AuthError("PANEL_HOST_UNAVAILABLE", 409);
      }
      s.hosting = h;
      await save();
    });
  }
  async check() {
    const latest = await this.source.latest(),
      release = await this.verify(latest);
    await this.change(async (s, save) => {
      if (
        release.sequence <
        Math.max(this.running.sequence, s.highestSequence ?? 0)
      )
        throw new AuthError("PANEL_RELEASE_REPLAY", 409);
      s.latest = latest;
      s.highestSequence = release.sequence;
      s.checkedAt = Date.now();
      await save();
    });
  }
  async install(input: unknown) {
    const x = object(input);
    await this.change(async (s, save) => {
      if (active(s)) throw new AuthError("PANEL_UPDATE_BUSY", 409);
      if (
        !s.hosting ||
        !s.latest ||
        !s.checkedAt ||
        Date.now() - s.checkedAt > 24 * 60 * 60_000
      )
        throw new AuthError("PANEL_CHECK_REQUIRED", 409);
      const r = await this.verify(s.latest);
      if (
        x.version !== r.version ||
        r.sequence <= this.running.sequence ||
        r.sequence < (s.highestSequence ?? 0) ||
        r.minimumSequence > this.running.sequence
      )
        throw new AuthError("PANEL_RELEASE_INCOMPATIBLE", 409);
      if (
        s.hosting.host === "docker" &&
        (!s.updaterSeen || Date.now() - s.updaterSeen > 180_000)
      )
        throw new AuthError("PANEL_UPDATER_OFFLINE", 409);
      s.job = {
        id: crypto.randomUUID(),
        version: r.version,
        sequence: r.sequence,
        envelope: s.latest,
        stage: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        message: "Update queued. You can leave this page open or return later.",
      };
      await save();
    });
  }
  async tick() {
    const initial = await this.state();
    if (!initial.hosting && this.env.railwayApiToken)
      await this.configure({
        host: "railway",
        token: this.env.railwayApiToken,
        serviceId: this.env.railwayServiceId,
        environmentId: this.env.railwayEnvironmentId,
      });
    if (!active(initial)) return;
    await this.change(async (s, save, lease) => {
      const j = s.job,
        h = s.hosting;
      if (!j || !h || !active(s)) return;
      if (
        j.stage === "verifying" &&
        j.version === this.running.version &&
        j.sequence === this.running.sequence
      ) {
        j.stage = "complete";
        j.message = `Ephor ${j.version} is running.`;
        delete j.upload;
        await save();
        return;
      }
      if (Date.now() - j.createdAt > 60 * 60_000) {
        j.stage = "failed";
        j.message =
          "The update did not finish within an hour. Check the hosting provider before retrying. The saved recovery point is retained.";
        await save();
        return;
      }
      if (h.host === "docker") return;
      try {
        const r = await this.verify(j.envelope);
        if (j.stage === "queued")
          await this.providers.validate(h, this.env.origin, lease);
        if (j.stage === "verifying") {
          if (h.host === "railway" && j.deploymentId) {
            const result = await this.providers.railway<{
              deployment: { status: string };
            }>(h, "query($id:String!){deployment(id:$id){status}}", {
              id: j.deploymentId,
            });
            if (
              ["FAILED", "CRASHED", "REMOVED"].includes(
                result.deployment.status,
              )
            )
              throw new ProviderError("RAILWAY_DEPLOYMENT_FAILED");
          }
          return;
        }
        if (h.host === "railway")
          await this.providers.railwayDeploy(h, r, j, save);
        else {
          const until = Date.now() + 20_000;
          let steps = 0;
          do {
            await this.providers.cloudflareStep(h, r, j, save);
            steps++;
          } while (
            Date.now() < until &&
            steps < 10 &&
            String(j.stage) !== "verifying"
          );
        }
      } catch (error) {
        // Do not blindly retry a deployment whose response was lost after acceptance.
        if (
          j.stage !== "verifying" ||
          (error instanceof ProviderError && /_HTTP_4\d\d$/.test(error.code))
        )
          j.stage = "failed";
        j.message =
          error instanceof ProviderError
            ? `${error.code}. Check hosting permissions and provider logs. Recovery details are retained.`
            : "Update interrupted. Check hosting logs before retrying. Recovery details are retained.";
        await save();
      }
    });
  }
  async updater(input: unknown) {
    const x = object(input);
    return this.change(async (s, save) => {
      if (!s.hosting) s.hosting = { host: "docker" };
      if (s.hosting.host !== "docker")
        throw new AuthError("PANEL_INVALID_HOST");
      s.updaterSeen = Date.now();
      const j = s.job;
      if (x.id && j?.id === x.id && active(s)) {
        if (x.stage === "verifying" && j.stage === "queued") {
          j.stage = "verifying";
          j.message = "Installing the release image and checking its health.";
        } else if (x.stage === "failed") {
          j.stage = "failed";
          j.message =
            "Docker updater failed. See the updater log and /var/lib/ephor/data/backups before retrying.";
        }
      }
      await save();
      return j && ["queued", "verifying"].includes(j.stage)
        ? { id: j.id, stage: j.stage, envelope: j.envelope }
        : null;
    });
  }
}
export async function processPanelRelease(env: AuthEnvironment) {
  await new PanelReleases(env).tick();
}
